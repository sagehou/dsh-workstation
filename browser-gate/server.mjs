// The browser input gate (ADR-0005).
//
// A transparent WebSocket peer in front of Selkies' data socket. It forwards
// the operator's own handshake, including the session-token subprotocol, so
// Selkies still decides who holds authority; what the gate adds is the one
// transition Selkies cannot perform for itself -- releasing held input before
// authority is taken away.
//
// It is deliberately a real server-side boundary rather than a client
// control: the operator's page never talks to Selkies directly, so no page
// script, second tab, or crafted client can send input the gate is not
// holding closed.

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { InputGate } from './gate.mjs'

const ENV = process.env
const listenAddr = ENV.GATE_ADDR ?? '0.0.0.0:8082'
const upstreamURL = ENV.GATE_UPSTREAM ?? 'ws://dsh-workstation-chromium:3000/browser/api/websockets'
const wsPath = ENV.GATE_PATH ?? '/browser/api/websockets'
const controlFile = ENV.GATE_CONTROL_SECRET ?? '/run/secrets/gate-control'
const barrierTimeout = Number(ENV.GATE_BARRIER_TIMEOUT_MS ?? 2000)
// A handover may not take longer than this before it is reported as failed and
// the operator's upstream socket is closed while it still holds authority, so
// Selkies runs its own departure release.
const handoverTimeout = Number(ENV.GATE_HANDOVER_TIMEOUT_MS ?? 5000)

if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$|^[a-z0-9.-]+:\d{1,5}$/.test(listenAddr)) {
  throw new Error('GATE_ADDR must be host:port')
}
if (!upstreamURL.startsWith('ws://') && !upstreamURL.startsWith('wss://')) {
  throw new Error('GATE_UPSTREAM must be a ws:// or wss:// URL')
}
if (!(barrierTimeout > 0 && barrierTimeout <= 30_000)) throw new Error('GATE_BARRIER_TIMEOUT_MS out of range')
if (!(handoverTimeout >= barrierTimeout && handoverTimeout <= 60_000)) {
  throw new Error('GATE_HANDOVER_TIMEOUT_MS must be at least the barrier timeout')
}
const control = (await readFile(controlFile, 'utf8')).trim()
if (!/^[0-9a-f]{64}$/.test(control)) throw new Error('Invalid gate control secret')

const digest = value => createHash('sha256').update(value).digest()
const controlDigest = digest(control)
const authorized = header => {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(header ?? '')
  // Hash both sides so the comparison is constant-time whatever the input.
  return Boolean(match) && timingSafeEqual(digest(match[1]), controlDigest)
}

// One operator connection. Replaced rather than shared if the page reconnects.
let link = null

const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), event }))

function reply (response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

// The completion barrier. The upstream read loop is a single sequential
// `async for msg in websocket` that awaits each input message's dispatch, and
// it answers a control PING inline. A PONG therefore proves the frames sent
// before it have been dispatched on that same connection, in order.
function barrier (socket, timeout) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('upstream socket is not open'))
      return
    }
    const started = Date.now()
    const done = error => {
      clearTimeout(timer)
      socket.off('pong', onPong)
      if (error) reject(error)
      else resolve(Date.now() - started)
    }
    const onPong = () => done(null)
    const timer = setTimeout(() => done(new Error('release barrier timed out')), timeout)
    socket.once('pong', onPong)
    try {
      socket.ping()
    } catch (error) {
      done(error)
    }
  })
}

// Set when a handover could not be proven. Cleared only by a handover that
// succeeds, because the desktop's held state is global: a press the gate could
// not clear may still be down, and a new connection having nothing of its own
// to release says nothing about that.
let unproven = null

// Close the operator's upstream socket while it still holds authority, so
// Selkies runs its own departure release (_release_held_input) instead of
// leaving the desktop mid-press.
//
// This is deliberately not recorded as a release. The departure path is
// expected to release, but the gate cannot prove it did, and the whole point of
// the barrier is that a release is reported only when it is proven.
function abandonUpstream (reason) {
  unproven = reason
  const current = link
  if (!current) return
  current.gate.abandon()
  try {
    // 1000 rather than a cut: the departure path releases held input on any
    // close that is not the reconnect-grace case.
    current.upstream.close(1000, 'gate handover')
  } catch { /* already closing */ }
  log({ type: 'abandoned_upstream', reason })
}

// One handover at a time. Two concurrent calls would both pass the `released`
// check before either finished, sending the release twice and interleaving two
// barriers on one socket.
let handoverChain = Promise.resolve()

function handover () {
  // Serialise: the release, the barrier and the state update are one critical
  // section, and two overlapping calls on one socket would send it twice.
  const run = handoverChain.then(handoverStep, handoverStep)
  handoverChain = run.catch(() => {})
  return run
}

async function handoverStep () {
  const current = link
  // An unproven release leaves the desktop's held state unknown, so it stays
  // unknown until some handover actually proves a release. Without a connection
  // that currently holds authority, there is nothing that could prove it now,
  // so the refusal has to outrank both the idle and the not-yet-granted cases.
  const cannotProve = !current || !current.gate.authority
  if (cannotProve && unproven) {
    throw new Error('a previous handover could not be proven: ' + unproven)
  }
  if (!current) {
    // Nothing is connected, so nothing is currently held.
    return { released: true, frames: 0, barrierMs: 0, note: 'no operator connection' }
  }
  if (current.upstream.readyState !== WebSocket.OPEN) {
    // Cannot prove a release; do not claim one.
    throw new Error('operator upstream socket is not open')
  }
  // A retried handover on a connection that already released must not send the
  // frames again: authority is gone by then, so upstream would drop them and a
  // second "released" would be a claim the gate cannot support.
  if (current.gate.released) {
    return { released: true, frames: 0, barrierMs: 0, note: 'already released' }
  }
  // The barrier proves *dispatch on this connection*, not authorisation. A
  // socket that has lost authority would have its release frames dropped at
  // websockets_mode.py:6235 while the PING behind them is still answered
  // inline -- so a "released" there would be exactly the false claim the
  // barrier exists to prevent.
  //
  // A connection that never held authority is different and safe to report:
  // the gate forwarded no input, so this connection left nothing down. It is
  // the handed-over-then-revoked case that is dangerous, and only that is
  // refused.
  if (!current.gate.authority) {
    if (current.gate.everGranted) {
      throw new Error('authority was already revoked, so held input cannot be released through this socket')
    }
    return { released: true, frames: 0, barrierMs: 0, note: 'this connection never held input authority' }
  }
  const frames = current.gate.beginHandover()
  // Input closed before the release is written, so no operator frame can be
  // interleaved between the release and the token flip.
  for (const frame of frames) current.upstream.send(frame)
  let barrierMs
  try {
    barrierMs = await barrier(current.upstream, barrierTimeout)
  } catch (error) {
    abandonUpstream('release unproven: ' + error.message)
    throw error
  }
  log({ type: 'handover', frames: frames.length, barrierMs })
  // Settle to CLOSED here rather than waiting for MK_ACCESS,0. If the Provider
  // dies between this reply and the table flip, a state left at RELEASING would
  // refuse the next grant forever; CLOSED is the same closed direction without
  // the permanent lockout.
  current.gate.handoverComplete()
  // The desktop is now proven clear, so the unproven mark is lifted.
  unproven = null
  return { released: true, frames: frames.length, barrierMs }
}

function resume () {
  if (link) link.gate.resume()
  log({ type: 'resume' })
  return { state: link ? link.gate.state : 'no operator connection' }
}

function attach (operator, request) {
  const protocols = request.headers['sec-websocket-protocol']
  const headers = {}
  // Host and Origin are forwarded unchanged. Selkies checks that an upgrade's
  // Origin is allowed (stream_server.py:2408-2442), and it matches against the
  // Host it receives, so rewriting either here would reject the operator's own
  // page even though the request is legitimate.
  if (request.headers.host) headers.Host = request.headers.host
  const origin = request.headers.origin
  if (origin) headers.Origin = origin

  // The subprotocol carries the session token. It goes in the constructor
  // argument rather than the header map so `ws` cannot emit it twice.
  const offered = protocols ? protocols.split(',').map(value => value.trim()).filter(Boolean) : undefined
  const upstream = new WebSocket(upstreamURL, offered, { headers })
  const gate = new InputGate()
  const current = { operator, upstream, gate, opened: false }
  // Frames the page sends before the upstream handshake completes. The page
  // sends SETTINGS the moment its socket opens, which can beat the gate's own
  // upstream connection; `ws.send()` throws while CONNECTING, and letting that
  // reach shutdown() killed the session about to start. Buffering is safe
  // because only non-input verbs can be queued: input is gated on authority,
  // and authority cannot arrive before the upstream is open.
  const pending = []
  // A replacement connection supersedes the old one; the old one is closed so
  // two sockets never both carry authority.
  if (link && link !== current) {
    try { link.operator.close(1000, 'superseded') } catch { /* already gone */ }
  }
  link = current

  const shutdown = reason => {
    if (link === current) link = null
    try { operator.close(1000, reason) } catch { /* already closed */ }
    try { upstream.close(1000, reason) } catch { /* already closed */ }
  }

  upstream.on('open', () => {
    current.opened = true
    // Replay in order, so the handshake a page sends first is upstream's first.
    for (const frame of pending.splice(0)) {
      try { upstream.send(frame) } catch { shutdown('upstream send failed after open'); return }
    }
    log({ type: 'upstream_open' })
  })

  upstream.on('message', (data, isBinary) => {
    // Everything the server sends is forwarded, including while releasing:
    // dropping control messages here would also drop video and display state,
    // and the page learning early that it lost authority is harmless because
    // the gate has already stopped forwarding input.
    const text = isBinary ? null : data.toString()
    if (text !== null && text.startsWith('MK_ACCESS,')) {
      if (text === 'MK_ACCESS,1') gate.grant()
      else if (text === 'MK_ACCESS,0') {
        // The Provider flips the table only after /handover has proven the
        // release, so this is the expected confirmation. A revocation that
        // arrives without a preceding handover came from outside the gate, and
        // the held-input release below cannot happen: authority is already
        // gone, so the frames would be dropped. Record it rather than pretend
        // the transition was safe.
        if (gate.state === 'OPEN') log({ type: 'revoked_outside_gate' })
        gate.revoke()
      }
    }
    try {
      operator.send(data, { binary: isBinary })
    } catch { /* operator gone; its close handler tears down */ }
  })

  operator.on('message', (data, isBinary) => {
    if (isBinary) {
      // Video/audio control never rides the operator's uplink; refuse rather
      // than forward something the gate cannot reason about.
      return
    }
    for (const frame of gate.fromOperator(data.toString())) {
      if (upstream.readyState === WebSocket.OPEN) {
        try { upstream.send(frame) } catch { shutdown('upstream send failed') }
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        // Queue rather than fail: a handshake that arrives before the upstream
        // is established is normal, and dropping the session over it was a real
        // intermittent video failure.
        pending.push(frame)
      } else {
        shutdown('upstream is not open')
      }
    }
  })

  upstream.on('close', () => shutdown('upstream closed'))
  operator.on('close', () => shutdown('operator closed'))
  upstream.on('error', error => {
    log({ type: 'upstream_error', message: error.message })
    shutdown('upstream error')
  })
  operator.on('error', () => shutdown('operator error'))

  log({ type: 'operator_connected' })
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://gate.invalid')
  if (url.pathname === '/health') {
    const healthy = !link || link.upstream.readyState === WebSocket.OPEN
    response.writeHead(healthy ? 204 : 503)
    response.end()
    return
  }
  if (!authorized(request.headers.authorization)) {
    reply(response, 401, { error: 'unauthorized' })
    return
  }
  if (url.pathname === '/status') {
    // The same shape whether or not an operator is attached, so a probe can
    // read `.authority` unconditionally instead of silently getting undefined.
    reply(response, 200, link
      ? { connected: true, ...link.gate.status() }
      : { connected: false, state: 'CLOSED', authority: false, permitted: true, everGranted: false, released: false, keys: [], buttons: 0, seq: 0 })
    return
  }
  if (url.pathname === '/resume' && request.method === 'POST') {
    reply(response, 200, resume())
    return
  }
  if (url.pathname === '/handover' && request.method === 'POST') {
    const timer = setTimeout(() => {
      if (!response.headersSent) {
        abandonUpstream('handover timed out')
        reply(response, 504, { released: false, error: 'handover timed out' })
      }
    }, handoverTimeout)
    handover().then(
      result => {
        clearTimeout(timer)
        if (!response.headersSent) reply(response, 200, result)
      },
      error => {
        clearTimeout(timer)
        if (!response.headersSent) reply(response, 503, { released: false, error: error.message })
      }
    )
    return
  }
  reply(response, 404, { error: 'not found' })
})

const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://gate.invalid')
  if (url.pathname !== wsPath && url.pathname !== wsPath + '/') {
    socket.destroy()
    return
  }
  sockets.handleUpgrade(request, socket, head, ws => attach(ws, request))
})

server.listen(Number(listenAddr.split(':').pop()), listenAddr.split(':').slice(0, -1).join(':'), () => {
  log({ type: 'listening', addr: listenAddr, upstream: upstreamURL })
})
