// The browser-input-gate against a fake Selkies that enforces the real
// ordering rules. This is the test that proves requirement #4 rather than
// merely exercising the state machine locally.
//
// The fake upstream reproduces the four behaviours the design depends on:
//
//   1. Input authority is evaluated against the live table on *every* input
//      frame, at receive time (websockets_mode.py:6235).
//   2. Installing a table happens before MK_ACCESS is pushed (:8071, :8356),
//      so a release sent after the flip is dropped.
//   3. The read loop is sequential and awaits each input dispatch, and answers
//      a PING inline (:5420-5423, :6248) -- the barrier the gate uses.
//   4. A close while the socket still holds authority runs the departure
//      release, which releases everything held (:6303).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

const GATE_PORT = 18082
const UPSTREAM_PORT = 18083
// A second, isolated pair for the handshake-forwarding test. These must not
// overlap the pair above: binding a second gate on the fake Selkies port made
// the test hang rather than fail.
const PROBE_GATE_PORT = 18092
const PROBE_UPSTREAM_PORT = 18093

const INPUT_VERBS = new Set(['kd', 'ku', 'kh', 'kr', 'm', 'm2', 'co', 'cmd', 'sf', 'sfe'])

let dir, gate, upstreamHTTP, control, upstream
// The fake desktop: what the input backend believes is held. It only changes
// when a frame is actually dispatched to it.
let desktop
// The upstream socket as Selkies sees it.
let session

function newDesktop () {
  const state = {
    keys: new Set(),
    buttons: 0,
    releases: [],
    applied: 0,
    apply (message) {
      const t = message.split(',')
      switch (t[0]) {
        case 'kd': state.keys.add(Number(t[1])); break
        case 'ku': state.keys.delete(Number(t[1])); break
        case 'kr':
          // reset_keyboard releases every held key and modifier.
          if (state.keys.size) state.releases.push([...state.keys])
          state.keys.clear()
          break
        case 'm':
        case 'm2': {
          // send_x11_mouse diffs the mask against what the backend holds.
          const mask = Number(t[3])
          if (!Number.isInteger(mask)) break
          if (state.buttons && mask === 0) state.releases.push(state.buttons)
          state.buttons = mask & 0x3f
          break
        }
      }
      state.applied++
    },
    held () {
      return { keys: [...state.keys].sort((a, b) => a - b), buttons: state.buttons }
    },
  }
  return state
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gate-test-'))
  control = randomBytes(32).toString('hex')
  await writeFile(join(dir, 'gate-control'), control + '\n', { mode: 0o600 })

  // autoPong is off so the barrier can be made unanswerable on demand; the
  // handler below answers it the way Selkies' inline `await pong()` does.
  upstream = new WebSocketServer({ noServer: true, autoPong: false })
  upstreamHTTP = createServer()
  upstreamHTTP.on('upgrade', (req, socket, head) => {
    upstream.handleUpgrade(req, socket, head, ws => {
      session = { ws, authorized: true, autoPong: true }
      ws.on('ping', () => {
        if (session.autoPong) ws.pong()
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const message = data.toString()
        // Authority is checked per frame at receive time, before dispatch.
        if (INPUT_VERBS.has(message.split(',', 1)[0]) && !session.authorized) return
        desktop.apply(message)
      })
      ws.on('close', () => {
        // The departure release, but only while authority was still held.
        if (!session.authorized) return
        desktop.apply('kr')
        desktop.apply('m2,0,0,0,0,0')
      })
    })
  })
  await new Promise(resolve => upstreamHTTP.listen(UPSTREAM_PORT, '127.0.0.1', resolve))

  gate = spawn(process.execPath, [join(import.meta.dirname, '..', 'server.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GATE_ADDR: `127.0.0.1:${GATE_PORT}`,
      GATE_UPSTREAM: `ws://127.0.0.1:${UPSTREAM_PORT}/browser/api/websockets`,
      GATE_CONTROL_SECRET: join(dir, 'gate-control'),
      GATE_BARRIER_TIMEOUT_MS: '700',
      GATE_HANDOVER_TIMEOUT_MS: '3000',
    },
  })
  gate.stdout.on('data', () => {})
  gate.stderr.on('data', chunk => process.stderr.write(`[gate] ${chunk}`))
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${GATE_PORT}/health`).catch(() => null)
    return response?.status === 204
  }, 'the gate did not start')
})

after(async () => {
  gate?.kill('SIGKILL')
  upstream?.clients?.forEach(ws => ws.terminate())
  upstreamHTTP?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})

// Every test starts from a gate with no operator connection, so a leftover
// socket from the previous test cannot be mistaken for this one's.
beforeEach(async () => {
  const status = await call('/status')
  if (status.body.connected) {
    // Ask the gate to drop the previous test's operator, then wait for it.
    session?.ws?.terminate()
    await waitFor(async () => (await call('/status')).body.connected === false,
      'the previous operator connection did not go away')
  }
  desktop = newDesktop()
  session = undefined
})

async function waitFor (predicate, message, timeout = 6000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function call (path, token = control) {
  return new Promise((resolve, reject) => {
    const sent = request({
      host: '127.0.0.1',
      port: GATE_PORT,
      path,
      method: path === '/status' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        let parsed = body
        try { parsed = JSON.parse(body) } catch { /* non-JSON is fine */ }
        resolve({ status: response.statusCode, body: parsed })
      })
    })
    sent.on('error', reject)
    sent.end()
  })
}

// The operator's page, connecting through the gate as the real page does.
function connectOperator () {
  return new Promise((resolve, reject) => {
    // The page offers the token subprotocol, which the gate must pass through
    // untouched so Selkies still authorises the socket itself.
    const ws = new WebSocket(`ws://127.0.0.1:${GATE_PORT}/browser/api/websockets`, ['selkies'])
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// Bring the stack to the state the Provider starts from: the operator holds
// authority with a button and a key down.
async function humanHoldingInput () {
  const operator = await connectOperator()
  await waitFor(async () => (await call('/status')).body.connected === true,
    'the gate did not see the operator')
  await waitFor(() => session !== undefined && session.ws.readyState === WebSocket.OPEN,
    'the gate did not connect upstream')
  // Selkies grants authority the way reconcile_clients does.
  session.authorized = true
  session.ws.send('MK_ACCESS,1')
  await waitFor(async () => (await call('/status')).body.state === 'OPEN',
    'the grant did not open the gate')
  operator.send('kd,97')
  operator.send('m,10,20,1,0,5')
  await waitFor(() => desktop.keys.has(97) && desktop.buttons === 1,
    'the press did not reach the desktop')
  return operator
}

test('a held button survives the naive handover, which is the M0 defect', async () => {
  const operator = await humanHoldingInput()
  assert.deepEqual(desktop.held(), { keys: [97], buttons: 1 })

  // Flip the table the way provision_tokens does: install first, then push.
  session.authorized = false
  session.ws.send('MK_ACCESS,0')
  // The release the page would send is now dropped, exactly as Selkies does.
  operator.send('m,10,20,0,0')
  operator.send('ku,97')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(desktop.held(), { keys: [97], buttons: 1 },
    'this test is only meaningful while the naive order strands the input')
  operator.close()
}, { concurrency: false })

test('the gate releases held input before authority is taken away', async () => {
  const operator = await humanHoldingInput()
  assert.deepEqual(desktop.held(), { keys: [97], buttons: 1 })

  const handover = await call('/handover')
  assert.equal(handover.status, 200, JSON.stringify(handover.body))
  assert.equal(handover.body.released, true)
  // The requirement: nothing is still held once /handover returns.
  assert.deepEqual(desktop.held(), { keys: [], buttons: 0 }, 'held input survived the handover')

  // Only now does the Provider flip the table.
  session.authorized = false
  session.ws.send('MK_ACCESS,0')
  await waitFor(async () => (await call('/status')).body.state === 'CLOSED', 'the gate did not close')

  // Input is refused at the boundary even if the page sends it anyway.
  const before = desktop.applied
  operator.send('kd,98')
  operator.send('m,30,40,1,0')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(desktop.applied, before, 'a frame reached the desktop while authority was gone')
  assert.deepEqual(desktop.held(), { keys: [], buttons: 0 })
  operator.close()
}, { concurrency: false })

test('a key the gate never forwarded is still released', async () => {
  // Models a press delivered before the gate was in the path, or one whose
  // press the gate dropped for any reason: the release must not depend on the
  // gate's own bookkeeping.
  const operator = await humanHoldingInput()
  desktop.keys.add(112)
  const handover = await call('/handover')
  assert.equal(handover.status, 200)
  assert.deepEqual(desktop.held(), { keys: [], buttons: 0 },
    'the release only covered what the gate had tracked')
  operator.close()
}, { concurrency: false })

test('the handover proves completion rather than assuming it', async () => {
  const operator = await humanHoldingInput()
  const handover = await call('/handover')
  assert.equal(handover.status, 200)
  // barrierMs is measured against the upstream's own PONG.
  assert.equal(typeof handover.body.barrierMs, 'number')
  assert.ok(handover.body.barrierMs >= 0)
  assert.equal(handover.body.frames, 2, 'the release is the two upstream primitives')
  operator.close()
}, { concurrency: false })

test('a grant arriving mid-release is refused', async () => {
  const operator = await humanHoldingInput()
  const pending = call('/handover')
  // Upstream grants authority while the release is outstanding -- the race M0
  // recorded, where the Agent's action could interleave with a human press.
  session.ws.send('MK_ACCESS,1')
  const handover = await pending
  assert.equal(handover.status, 200)
  const status = await call('/status')
  assert.notEqual(status.body.state, 'OPEN', 'a grant during a release reopened input')
  operator.close()
}, { concurrency: false })

test('hand-back reopens input only on an explicit resume and grant', async () => {
  const operator = await humanHoldingInput()
  assert.equal((await call('/handover')).status, 200)
  session.authorized = false
  session.ws.send('MK_ACCESS,0')
  await waitFor(async () => (await call('/status')).body.state === 'CLOSED', 'the gate did not close')

  // Returning control to HUMAN: the table is restored, then resume is called.
  session.authorized = true
  session.ws.send('MK_ACCESS,1')
  // A grant alone does not reopen: the gate stays closed after a handover
  // until the control plane says the handback is complete.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal((await call('/status')).body.state, 'CLOSED')
  assert.equal((await call('/resume')).status, 200)
  session.ws.send('MK_ACCESS,1')
  await waitFor(async () => (await call('/status')).body.state === 'OPEN', 'resume did not reopen input')
  operator.send('kd,97')
  await waitFor(() => desktop.keys.has(97), 'input did not reach the desktop after hand-back')
  operator.close()
}, { concurrency: false })

test('client disconnect mid-press releases held input', async () => {
  const operator = await humanHoldingInput()
  assert.deepEqual(desktop.held(), { keys: [97], buttons: 1 })
  // A cut: the page dies, but this socket still holds authority upstream, so
  // Selkies runs its departure release.
  operator.terminate()
  await waitFor(() => desktop.keys.size === 0 && desktop.buttons === 0,
    'a disconnect mid-press stranded the input')
}, { concurrency: false })

test('a release that cannot be proven is refused and closes input', async () => {
  const operator = await humanHoldingInput()
  assert.deepEqual(desktop.held(), { keys: [97], buttons: 1 })
  // Make the barrier unanswerable: the upstream stops returning PONG, so the
  // gate cannot prove the release was dispatched.
  session.autoPong = false
  const handover = await call('/handover')
  assert.notEqual(handover.status, 200, 'an unproven release reported success')
  assert.equal(handover.body.released, false)
  // The gate must not fail open.
  assert.equal((await call('/status')).body.state, 'CLOSED')
  assert.equal((await call('/health')).status, 204)
  operator.close()
}, { concurrency: false })

test('an unproven release stays closed until a later handover proves the desktop clear', async () => {
  // A barrier timeout cannot be waved away by reconnecting: a new connection
  // having nothing of its own to release says nothing about the press the gate
  // failed to clear, so /handover keeps refusing while nothing is attached.
  const operator = await humanHoldingInput()
  session.autoPong = false
  assert.notEqual((await call('/handover')).status, 200)
  operator.close()
  await waitFor(async () => (await call('/status')).body.connected === false,
    'the operator connection did not go away')
  const refused = await call('/handover')
  assert.notEqual(refused.status, 200, 'an unproven release was forgotten when the page reconnected')
  assert.equal(refused.body.released, false)

  // The recovery path is a real handover that proves the release. Reconnecting
  // is what the page does by itself after the socket drop, and Selkies still
  // grants because the token table never changed.
  session.autoPong = true
  const recovered = await humanHoldingInput()
  const proven = await call('/handover')
  assert.equal(proven.status, 200, JSON.stringify(proven.body))
  assert.equal(proven.body.released, true)
  assert.deepEqual(desktop.held(), { keys: [], buttons: 0 })

  // With the desktop proven clear, the no-connection case is truthful again.
  recovered.close()
  await waitFor(async () => (await call('/status')).body.connected === false,
    'the recovered operator connection did not go away')
  const idle = await call('/handover')
  assert.equal(idle.status, 200, JSON.stringify(idle.body))
  assert.equal(idle.body.released, true)
  assert.equal(idle.body.note, 'no operator connection')
}, { concurrency: false })

test('the control API rejects an unauthenticated handover', async () => {
  assert.equal((await call('/handover', 'f'.repeat(64))).status, 401)
  assert.equal((await call('/handover', 'nope')).status, 401)
  assert.equal((await call('/status', 'f'.repeat(64))).status, 401)
  // An unauthenticated caller must not be able to change state either.
  assert.equal((await call('/resume', 'nope')).status, 401)
}, { concurrency: false })

test('a path other than the data socket is refused rather than proxied', async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${GATE_PORT}/browser/api/tokens`)
      ws.once('open', () => { ws.close(); resolve() })
      ws.once('error', reject)
    }),
    'the gate proxied a path that is not the data socket')
}, { concurrency: false })

test('the operator handshake is forwarded intact, so Selkies still authorises it', async () => {
  // The gate must not become the authority. Selkies decides by the session
  // token in the subprotocol, and checks Origin against the Host it sees
  // (stream_server.py:2408), so both have to arrive unchanged.
  const seen = {}
  const probe = new WebSocketServer({ noServer: true })
  const http = createServer()
  const upgraded = new Set()
  http.on('connection', socket => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
  })
  http.on('upgrade', (req, socket, head) => {
    seen.host = req.headers.host
    seen.origin = req.headers.origin
    seen.protocol = req.headers['sec-websocket-protocol']
    probe.handleUpgrade(req, socket, head, ws => { ws.on('message', () => {}); seen.closed = true })
  })
  await new Promise(resolve => http.listen(PROBE_UPSTREAM_PORT, '127.0.0.1', resolve))

  // A second gate pointed at the probe, so this test does not disturb the one
  // the other tests use.
  const env = {
    ...process.env,
    GATE_ADDR: `127.0.0.1:${PROBE_GATE_PORT}`,
    GATE_UPSTREAM: `ws://127.0.0.1:${PROBE_UPSTREAM_PORT}/browser/api/websockets`,
    GATE_CONTROL_SECRET: join(dir, 'gate-control'),
  }
  const second = spawn(process.execPath, [join(import.meta.dirname, '..', 'server.mjs')], { stdio: 'ignore', env })
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PROBE_GATE_PORT}/health`).catch(() => null)
      return response?.status === 204
    }, 'the probe gate did not start')
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PROBE_GATE_PORT}/browser/api/websockets`,
        ['selkies', 'selkies.token.' + Buffer.from('a'.repeat(64)).toString('base64url')],
        { headers: { Origin: 'https://workstation.test' } })
      ws.once('open', () => { ws.close(); resolve() })
      ws.once('error', reject)
    })
    // The operator's socket opens as soon as the gate accepts it; the gate's own
    // upstream handshake is what the probe sees, so wait for it.
    await waitFor(() => seen.host !== undefined, 'the gate never connected upstream')
    assert.equal(seen.host, `127.0.0.1:${PROBE_GATE_PORT}`, 'the gate rewrote Host')
    assert.equal(seen.origin, 'https://workstation.test', 'the gate dropped or rewrote Origin')
    assert.match(seen.protocol ?? '', /selkies/, 'the gate dropped the selkies protocol')
    assert.match(seen.protocol ?? '', /selkies\.token\./, 'the gate dropped the session token subprotocol')
  } finally {
    second.kill('SIGKILL')
    probe.clients?.forEach(ws => ws.terminate())
    // http.close() waits for open upgraded sockets, so destroy them first.
    upgraded.forEach(socket => socket.destroy())
    http.close()
  }
}, { concurrency: false })

test('a page that sends its handshake before the gate reaches upstream is not dropped', async () => {
  // This is the intermittent failure the first live CI run exposed: the page
  // sends SETTINGS the instant its socket opens, which can beat the gate's own
  // upstream connection. `ws.send()` throws while CONNECTING, and treating that
  // as fatal closed a session about to start.
  //
  // Delay the fake Selkies' upgrade so the order is guaranteed rather than
  // probabilistic.
  const held = []
  const slow = new WebSocketServer({ noServer: true })
  const slowHTTP = createServer()
  const sockets = new Set()
  slowHTTP.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  slowHTTP.on('upgrade', (req, socket, head) => {
    // Hold the upgrade until after the operator has sent its first frame.
    held.push(() => slow.handleUpgrade(req, socket, head, ws => {
      const received = []
      ws.on('message', data => {
        if (data.toString() === 'SETTINGS,{"displayId":"primary"}') ws.send('MK_ACCESS,1')
      })
      ws.on('ping', () => ws.pong())
    }))
  })
  await new Promise(resolve => slowHTTP.listen(PROBE_UPSTREAM_PORT + 1, '127.0.0.1', resolve))

  const env = {
    ...process.env,
    GATE_ADDR: `127.0.0.1:${PROBE_GATE_PORT + 1}`,
    GATE_UPSTREAM: `ws://127.0.0.1:${PROBE_UPSTREAM_PORT + 1}/browser/api/websockets`,
    GATE_CONTROL_SECRET: join(dir, 'gate-control'),
  }
  const gate = spawn(process.execPath, [join(import.meta.dirname, '..', 'server.mjs')], { stdio: 'ignore', env })
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PROBE_GATE_PORT + 1}/health`).catch(() => null)
      return response?.status === 204
    }, 'the slow gate did not start')

    const operator = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PROBE_GATE_PORT + 1}/browser/api/websockets`, ['selkies'])
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
    // Send immediately, before the upstream is allowed to complete.
    operator.send('SETTINGS,{"displayId":"primary"}')
    let closed = false
    operator.on('close', () => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(closed, false, 'the gate dropped the session because the page spoke first')

    // Now let the upstream handshake complete; the queued frame must arrive.
    await waitFor(() => held.length > 0, 'the gate never reached upstream')
    for (const accept of held.splice(0)) accept()
    await waitFor(async () => {
      const status = await fetch(`http://127.0.0.1:${PROBE_GATE_PORT + 1}/status`, {
        headers: { Authorization: 'Bearer ' + control },
      })
      return (await status.json()).authority === true
    }, 'the queued SETTINGS never reached the upstream, so no grant came back')
    assert.equal(closed, false, 'the session was closed after the upstream opened')
    operator.close()
  } finally {
    gate.kill('SIGKILL')
    slow.clients?.forEach(ws => ws.terminate())
    sockets.forEach(socket => socket.destroy())
    slowHTTP.close()
  }
}, { concurrency: false })

test('an unproven release is not forgotten by a connection that has not been granted yet', async () => {
  // The idle case is only safe to report because nothing can still be held.
  // A page that has reconnected but not yet been granted authority is not the
  // same thing: the press the gate failed to clear may still be down, and
  // "this connection never held authority" says nothing about it.
  const operator = await humanHoldingInput()
  session.autoPong = false
  assert.notEqual((await call('/handover')).status, 200)
  operator.close()
  await waitFor(async () => (await call('/status')).body.connected === false,
    'the operator connection did not go away')

  // Reconnect, but make Selkies withhold the grant so no release can be proven.
  session.autoPong = true
  const reconnected = await connectOperator()
  await waitFor(async () => (await call('/status')).body.connected === true,
    'the gate did not see the reconnected operator')
  const status = await call('/status')
  assert.equal(status.body.authority, false, 'this test needs a socket without authority')
  const refused = await call('/handover')
  assert.notEqual(refused.status, 200, 'an unproven release was reported as clear')
  assert.equal(refused.body.released, false)

  // A real grant does allow the proof, and that clears the mark.
  session.ws.send('MK_ACCESS,1')
  await waitFor(async () => (await call('/status')).body.state === 'OPEN', 'the grant did not arrive')
  const proven = await call('/handover')
  assert.equal(proven.status, 200, JSON.stringify(proven.body))
  assert.equal(proven.body.released, true)
  reconnected.close()
}, { concurrency: false })
