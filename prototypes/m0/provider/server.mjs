import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { chromium } from 'playwright'
import { z } from 'zod'

const [master, controller, sentinel, admin] = await Promise.all(
  ['m0_master', 'm0_controller', 'm0_sentinel', 'm0_admin'].map(name => readFile('/run/secrets/' + name, 'utf8')),
)
const publicMode = process.env.WORKSTATION_PROVIDER === '1'
const enroll = publicMode ? (await readFile('/run/secrets/browser_enroll', 'utf8')).trim() : ''
if (publicMode && !/^[0-9a-f]{64}$/.test(enroll)) throw Error('Invalid workstation MCP admission key')
const origins = new Set((process.env.BROWSER_TOOL_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean))
for (const origin of origins) {
  if (!origin.startsWith('https://') || new URL(origin).origin !== origin) throw Error('Expected bare HTTPS browser tool origins')
}
const cdp = publicMode ? 'http://127.0.0.1:9223' : 'http://172.30.231.2:9223'
const selkies = publicMode ? 'http://dsh-workstation-chromium:3000' : 'http://172.30.231.2:3000'
// The gate's address and control credential come from the environment so a
// custom subnet moves them too. The prototype path has no gate; the input
// helpers below keep the non-public behaviour unchanged.
const gate = process.env.PROVIDER_GATE_URL ?? 'http://dsh-workstation-browser-gate:8082'
const gateControl = publicMode ? (await readFile('/run/secrets/gate_control', 'utf8')).trim() : ''
if (publicMode && !/^[0-9a-f]{64}$/.test(gateControl)) throw Error('Invalid gate control credential')
const fixture = 'http://witness:8081/'
const fencePath = '/state/browser-fence'
const boot = randomUUID()
const digest = text => createHash('sha256').update(text ?? '').digest('hex')
const tickets = new Map()
const usedTickets = new Map()
const webTicketLifetime = 5 * 60_000
let state = 'DISCONNECTED', reason = 'BOOT', nextGeneration = 0
let browser, browserId, page, lease, expiry, flight, recovering

class Denied extends Error {
  constructor(code, status = 409) {
    super(code)
    this.status = status
  }
}
function check(condition, code, status) {
  if (!condition) throw new Denied(code, status)
}
async function input(locked) {
  const table = { [controller]: { role: 'controller', slot: null } }
  if (locked) table[sentinel] = { role: 'viewer', slot: null, mk_control: true }
  // The gate has to release held input *before* the table changes: authority is
  // evaluated per frame against the live table, and provision_tokens installs
  // the new table before it announces the change. A release sent after the flip
  // is dropped, which is how a human's held button used to survive an Agent
  // lease. Locking therefore means: prove the release, then take authority.
  // NEGATIVE CONTROL: no handover.
  const response = await fetch(selkies + '/browser/api/tokens', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + master, 'Content-Type': 'application/json' },
    body: JSON.stringify(table),
    signal: AbortSignal.timeout(3000),
  })
  await response.body?.cancel()
  check(response.ok, 'INPUT_GATE_UNAVAILABLE')
  // Handing control back is the reverse order: restore the table, then tell the
  // gate the operator may drive again.
  if (!locked && publicMode) {
    const resumed = await fetch(gate + '/resume', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + gateControl },
      signal: AbortSignal.timeout(3000),
    }).catch(() => null)
    // A failed resume is not silent: the operator would be locked out, which is
    // the closed direction but still has to be reported.
    check(resumed?.ok === true, 'INPUT_RESUME_FAILED')
  }
}
function fault(code) {
  state = 'DISCONNECTED'
  reason = code
  lease = undefined
  clearTimeout(expiry)
}
async function recover() {
  check(state === 'DISCONNECTED' && !recovering && !flight, 'RECOVERY_UNAVAILABLE')
  recovering = true
  try {
    const response = await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(1500) })
    check(response.ok, 'CDP_UNAVAILABLE')
    const info = await response.json()
    const id = new URL(info.webSocketDebuggerUrl).pathname
    const fence = await readFile(fencePath, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    check(id !== fence, 'RESET_NEEDS_NEW_BROWSER')
    await input(true)
    if (!browser?.isConnected() || browserId !== id) {
      const attached = await chromium.connectOverCDP(cdp, { timeout: 4000 })
      browser = attached
      browserId = id
      attached.on('disconnected', () => {
        if (browser === attached) fault('BROWSER_LOST')
      })
    }
    if (!publicMode) {
      const context = browser.contexts()[0]
      const reserved = new Set([...tickets.values()].map(peer => peer.binding?.page))
      page = context.pages().find(tab => !reserved.has(tab) && tab.url() === fixture) ?? await context.newPage()
      if (page.url() !== fixture) await page.goto(fixture, { timeout: 5000 })
      await page.bringToFront()
    }
    await input(false)
    await rm(fencePath, { force: true })
    check(browser.isConnected(), 'BROWSER_LOST')
    state = 'HUMAN'
    reason = 'RECOVERED'
    return { state, browser: info.Browser, protocol: info['Protocol-Version'] }
  } finally {
    recovering = false
  }
}
const liveBinding = binding => binding && binding.browserId === browserId && !binding.page.isClosed()

async function bindTab(peer) {
  if (peer.binding) return peer.binding
  const id = browserId
  const tab = await browser.contexts()[0].newPage()
  // The Agent's tab has to be the one on the shared desktop: a binding that is
  // not foregrounded would take input without the Agent or the operator being
  // able to see what it is driving.
  await tab.bringToFront()
  check(state === 'HANDOVER' && browserId === id && browser.isConnected() && peer.stream, 'OWNER_LOST_DURING_GRANT')
  const onClose = () => {
    if (state === 'AGENT' && lease?.peer === peer) void handover('TAB_CLOSED').catch(() => {})
  }
  peer.binding = { browserId: id, page: tab, onClose }
  tab.once('close', onClose)
  if (!publicMode) await tab.goto(fixture, { timeout: 5000 })
  return peer.binding
}

async function grant(peerId, ttl) {
  const peer = [...tickets.values()].find(candidate => candidate.id === peerId)
  check(peer?.stream, 'NO_LIVE_MCP_CONNECTION')
  check(Number.isSafeInteger(ttl) && ttl >= 500 && ttl <= 120_000, 'BAD_TTL', 400)
  check(state === 'HUMAN', 'NOT_HUMAN')
  if (peer.binding) check(liveBinding(peer.binding), 'TAB_UNAVAILABLE')
  state = 'HANDOVER'
  try {
    await input(true)
    await writeFile(fencePath + '.new', browserId, { mode: 0o600 })
    await rename(fencePath + '.new', fencePath)
    check(state === 'HANDOVER' && browser.isConnected() && peer.stream, 'OWNER_LOST_DURING_GRANT')
    const binding = peer.tab ? await bindTab(peer) : { browserId, page }
    check(state === 'HANDOVER' && browser.isConnected() && peer.stream, 'OWNER_LOST_DURING_GRANT')
    check(liveBinding(binding), 'TAB_UNAVAILABLE')
    const generation = boot + ':' + ++nextGeneration
    lease = { peer, binding, generation, expires: performance.now() + ttl }
    state = 'AGENT'
    reason = 'GRANTED'
    expiry = setTimeout(() => { void handover('EXPIRED').catch(() => {}) }, ttl)
    return { generation, mcpSession: peer.transport.sessionId, protocol: peer.protocol }
  } catch (error) {
    fault('GRANT_FAILED')
    throw error
  }
}
async function handover(cause) {
  check(state === 'AGENT', 'NO_AGENT')
  state = 'HANDOVER'
  reason = cause
  clearTimeout(expiry)
  try {
    await flight
    check(state === 'HANDOVER' && browser.isConnected(), 'ACTION_UNCERTAIN')
    lease = undefined
    await input(false)
    await rm(fencePath, { force: true })
    check(state === 'HANDOVER' && browser.isConnected(), 'BROWSER_LOST')
    state = 'HUMAN'
    return { state }
  } catch (error) {
    fault('DRAIN_UNCERTAIN')
    throw error
  }
}
function retire(peer) {
  peer.stream = false
  tickets.delete(peer.key)
  if (peer.binding) peer.binding.page.off('close', peer.binding.onClose)
  if (state === 'AGENT' && lease.peer === peer) void handover('MCP_LOST').catch(() => {})
  void peer.transport.close().catch(() => {})
}
function toolResult(code) {
  return { isError: code !== 'M0_OK', content: [{ type: 'text', text: code }] }
}
function leaseDenied(peer) {
  if (state === 'HANDOVER' || state === 'DISCONNECTED') return state
  if (!lease) return 'NO_LEASE'
  if (performance.now() >= lease.expires) {
    void handover('EXPIRED').catch(() => {})
    return 'EXPIRED'
  }
  if (lease.peer !== peer || !peer.stream) return 'NOT_OWNER'
  if (!liveBinding(lease.binding)) return 'TAB_UNAVAILABLE'
}
async function mark(peer, args) {
  const denied = leaseDenied(peer)
  if (denied) return toolResult(denied)
  if (lease.generation !== args.generation) return toolResult('STALE_GENERATION')
  if (flight) return toolResult('BUSY')
  const tab = lease.binding.page
  if (tab.url() !== fixture) return toolResult('FIXTURE_UNAVAILABLE')
  // Keep the CDP promise through MCP cancellation; the renderer may still have work.
  const work = tab.evaluate(({ marker, hold, fixture }) => {
    if (location.href !== fixture) return 'wrong page'
    return window.m0Mark(marker, hold)
  }, { ...args, fixture })
  flight = work
  try {
    if (await work !== 'done') throw new Error('marker not confirmed')
    return toolResult('M0_OK')
  } catch {
    fault('ACTION_UNCERTAIN')
    return toolResult('ACTION_UNCERTAIN')
  } finally {
    flight = undefined
  }
}
function cleanTickets() {
  const now = Date.now()
  for (const [key, until] of usedTickets) if (until <= now) usedTickets.delete(key)
  for (const peer of tickets.values()) {
    if (peer.label && !peer.stream && peer.deadline <= now) {
      tickets.delete(peer.key)
      if (peer.transport) void peer.transport.close().catch(() => {})
    }
  }
}

function admit(authorization, key, initialize) {
  const match = /^Bearer (v1\.([a-zA-Z0-9_-]{1,128})\.[a-f0-9]{48}\.([0-9]{13}))\.([a-f0-9]{64})$/.exec(authorization ?? '')
  check(match, 'MCP_CREDENTIAL_REVOKED', 401)
  const [, claim, label, expiry, signature] = match
  const now = Date.now()
  check(Number(expiry) > now && Number(expiry) <= now + 65_000, 'MCP_CREDENTIAL_REVOKED', 401)
  const expected = createHmac('sha256', enroll).update(claim).digest()
  check(timingSafeEqual(expected, Buffer.from(signature, 'hex')), 'MCP_CREDENTIAL_REVOKED', 401)
  check(!usedTickets.has(key), 'MCP_CREDENTIAL_REVOKED', 401)
  // The official client probes first; a verified legacy response lets it initialize without spending the ticket.
  check(initialize, 'USE_MCP_INITIALIZE', 400)
  check(tickets.size < 32 && usedTickets.size < 128, 'TOO_MANY_MCP_CONNECTIONS', 429)
  const peer = { id: randomUUID(), label, key, deadline: Number(expiry), tab: true, stream: false }
  usedTickets.set(key, Number(expiry))
  tickets.set(key, peer)
  return peer
}

function allowed(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password && origins.has(url.origin)
  } catch { return false }
}
const textResult = text => ({ content: [{ type: 'text', text }] })
async function browserAction(peer, args, operation) {
  const denied = leaseDenied(peer)
  if (denied) return toolResult(denied)
  if (lease.generation !== args.generation) return toolResult('STALE_GENERATION')
  if (flight) return toolResult('BUSY')
  const tab = lease.binding.page
  const target = operation === 'navigate' ? args.url : tab.url()
  if (!allowed(target)) return toolResult('ORIGIN_NOT_ALLOWED')
  const work = (async () => {
    if (operation === 'navigate') await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    if (operation === 'click') {
      const match = tab.getByRole(args.role, { name: args.name, exact: true })
      await match.click({ timeout: 4_000 })
    }
    if (!allowed(tab.url())) return toolResult('ORIGIN_NOT_ALLOWED')
    if (operation !== 'read') return textResult('OK')
    // Browser-side constants only; no model-supplied JavaScript.
    const visible = await tab.evaluate(() => (document.body?.innerText ?? '').slice(0, 8000))
    return allowed(tab.url()) ? textResult(visible) : toolResult('ORIGIN_NOT_ALLOWED')
  })()
  flight = work
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser timeout')), 12_000)
    })])
  } catch {
    fault('ACTION_UNCERTAIN')
    return toolResult('ACTION_UNCERTAIN')
  } finally {
    clearTimeout(timer)
    flight = undefined
  }
}
function publicTools(server, peer) {
  const generation = z.string().max(64)
  for (const [operation, description, inputs] of [
    ['navigate', 'Open an allowed HTTPS URL in this session’s assigned tab.', { url: z.string().max(2048) }],
    ['read', 'Read visible, untrusted text from this session’s assigned tab.', {}],
    ['click', 'Click an exact accessible button or link in this session’s assigned tab.',
      { role: z.enum(['button', 'link']), name: z.string().min(1).max(200) }],
  ]) {
    server.registerTool(operation, { description, inputSchema: { generation, ...inputs } },
      args => browserAction(peer, args, operation))
  }
}

async function json(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    check(body.length <= 16_384, 'BODY_TOO_LARGE', 413)
  }
  try { return JSON.parse(body) } catch { throw new Denied('BAD_JSON', 400) }
}
async function mcp(req, res) {
  check(req.url === '/mcp' && !req.headers.origin, 'NOT_FOUND', 404)
  const key = digest(req.headers.authorization)
  const body = req.method === 'POST' ? await json(req) : undefined
  if (publicMode) cleanTickets()
  let peer = tickets.get(key)
  if (publicMode && !peer) {
    const initialize = isInitializeRequest(body)
    if (initialize || (body?.jsonrpc === '2.0' && body.method === 'server/discover')) {
      peer = admit(req.headers.authorization, key, initialize)
    }
  }
  check(peer, 'MCP_CREDENTIAL_REVOKED', 401)
  if (!peer.transport) {
    if (peer.acceptUntil !== undefined && Date.now() >= peer.acceptUntil) {
      tickets.delete(peer.key)
      throw new Denied('MCP_CREDENTIAL_REVOKED', 401)
    }
    check(isInitializeRequest(body), 'USE_MCP_INITIALIZE', 400)
    const server = new McpServer({ name: 'm0-browser-provider', version: '0.0.1' })
    if (publicMode) publicTools(server, peer)
    else server.registerTool('mark', {
      description: 'Write a marker in the M0 browser fixture under the current generation.',
      inputSchema: {
        generation: z.string().max(64),
        marker: z.string().regex(/^[a-z0-9-]{1,40}$/),
        hold: z.boolean(),
      },
    }, args => mark(peer, args))
    if (peer.tab) server.registerTool('lease_status', {
      description: 'Get this session’s active lease generation before using browser tools.',
      inputSchema: {},
    }, () => {
      const denied = leaseDenied(peer)
      return denied ? toolResult(denied) : { content: [{ type: 'text', text: lease.generation }] }
    })
    peer.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, enableJsonResponse: true, keepAliveMs: 500,
    })
    await server.connect(peer.transport)
  } else {
    check(peer.transport.sessionId && peer.transport.sessionId === req.headers['mcp-session-id'], 'MCP_SESSION_REVOKED', 404)
  }
  const abort = new AbortController()
  res.once('close', () => abort.abort())
  const request = new Request('http://provider:8080/mcp', {
    method: req.method, headers: req.headers, signal: abort.signal,
  })
  const reply = await peer.transport.handleRequest(request, { parsedBody: body })
  const observing = req.method === 'GET' && reply.ok
  if (observing) {
    peer.stream = true
    peer.protocol = req.headers['mcp-protocol-version']
    res.once('close', () => retire(peer))
  }
  if (req.method === 'DELETE' && reply.ok) retire(peer)
  res.writeHead(reply.status, Object.fromEntries(reply.headers))
  if (reply.body) await pipeline(Readable.fromWeb(reply.body), res)
  else res.end()
}

const respond = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
async function control(req, res) {
  const want = Buffer.from(digest('Bearer ' + admin), 'hex')
  check(timingSafeEqual(want, Buffer.from(digest(req.headers.authorization), 'hex')), 'UNAUTHORIZED', 401)
  if (req.method === 'GET' && req.url === '/status') {
    const peers = publicMode ? [...tickets.values()].filter(peer => peer.label && peer.stream)
      .map(peer => ({ id: peer.id, label: peer.label, tab: Boolean(liveBinding(peer.binding)) })) : undefined
    return respond(res, 200, { state, reason, inFlight: Boolean(flight), lease: Boolean(lease), mcpProtocol: lease?.peer.protocol, peers })
  }
  check(req.method === 'POST', 'NOT_FOUND', 404)
  const args = await json(req)
  let result
  switch (req.url) {
    case '/recover': result = await recover(); break
    case '/issue': {
      check(!publicMode, 'NOT_FOUND', 404)
      const now = Date.now()
      for (const [key, peer] of tickets) {
        if (!peer.transport && peer.acceptUntil !== undefined && peer.acceptUntil <= now) tickets.delete(key)
      }
      check(tickets.size < 32, 'TOO_MANY_MCP_CONNECTIONS')
      const credential = randomBytes(32).toString('hex')
      const key = digest('Bearer ' + credential)
      const id = randomUUID()
      const tab = args?.tab === true
      const acceptUntil = tab ? now + webTicketLifetime : undefined
      tickets.set(key, { id, key, stream: false, tab, acceptUntil })
      result = { id, credential, acceptUntil }
      break
    }
    case '/grant': result = await grant(args.peer, args.ttl); break
    case '/takeover': result = await handover('TAKEOVER'); break
    default: throw new Denied('NOT_FOUND', 404)
  }
  respond(res, 200, result)
}
function listen(handler, host, port) {
  createServer((req, res) => {
    handler(req, res).catch(error => {
      if (res.destroyed || res.headersSent) return res.destroy()
      respond(res, error.status ?? 503, { error: error instanceof Denied ? error.message : 'UPSTREAM_UNAVAILABLE' })
    })
  }).listen(port, host)
}
// The public provider binds the addresses Compose assigns it. They come from
// deploy/network.sh, so a custom subnet moves them together with the Compose
// static addresses and the health-check target that probes this listener.
// A literal here fails with EADDRNOTAVAIL: the container has no such address.
const providerHost = process.env.PROVIDER_IP ??
  (publicMode ? '172.30.241.3' : '172.30.232.2')
const controlHost = process.env.PROVIDER_CONTROL_IP ?? '172.30.233.2'
listen(mcp, providerHost, 8080)
listen(control, controlHost, 8081)

if (publicMode) {
  let lastProblem
  const retry = () => {
    if (state === 'DISCONNECTED' && ['BOOT', 'BROWSER_LOST'].includes(reason) && !recovering && !flight) {
      void recover().then(() => { lastProblem = undefined }, error => {
        const problem = error instanceof Denied ? error.message : error?.code === 'EROFS' ? 'SCRATCH_READ_ONLY' : 'ATTACH_FAILED'
        if (problem !== lastProblem) console.warn('Provider attachment unavailable:', problem)
        lastProblem = problem
      })
    }
  }
  retry()
  setInterval(retry, 3000).unref()
}
