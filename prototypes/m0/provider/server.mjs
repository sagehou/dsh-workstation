import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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
const cdp = 'http://172.30.231.2:9223'
const fixture = 'http://witness:8081/'
const fencePath = '/state/browser-fence'
const boot = randomUUID()
const digest = text => createHash('sha256').update(text ?? '').digest('hex')
const tickets = new Map()
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
  const response = await fetch('http://172.30.231.2:3000/browser/api/tokens', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + master, 'Content-Type': 'application/json' },
    body: JSON.stringify(table),
    signal: AbortSignal.timeout(3000),
  })
  await response.body?.cancel()
  check(response.ok, 'INPUT_GATE_UNAVAILABLE')
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
    const context = browser.contexts()[0]
    page = context.pages().find(tab => tab.url() === fixture) ?? context.pages()[0] ?? await context.newPage()
    if (page.url() !== fixture) await page.goto(fixture, { timeout: 5000 })
    await page.bringToFront()
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
async function grant(peerId, ttl) {
  const peer = [...tickets.values()].find(candidate => candidate.id === peerId)
  check(peer?.stream, 'NO_LIVE_MCP_CONNECTION')
  check(Number.isSafeInteger(ttl) && ttl >= 500 && ttl <= 120_000, 'BAD_TTL', 400)
  check(state === 'HUMAN', 'NOT_HUMAN')
  state = 'HANDOVER'
  try {
    await input(true)
    await writeFile(fencePath + '.new', browserId, { mode: 0o600 })
    await rename(fencePath + '.new', fencePath)
    check(state === 'HANDOVER' && browser.isConnected() && peer.stream, 'OWNER_LOST_DURING_GRANT')
    const generation = boot + ':' + ++nextGeneration
    lease = { peer, generation, expires: performance.now() + ttl }
    state = 'AGENT'
    reason = 'GRANTED'
    expiry = setTimeout(() => { void handover('EXPIRED').catch(() => {}) }, ttl)
    return { generation }
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
  if (state === 'AGENT' && lease.peer === peer) void handover('MCP_LOST').catch(() => {})
  void peer.transport.close().catch(() => {})
}
function toolResult(code) {
  return { isError: code !== 'M0_OK', content: [{ type: 'text', text: code }] }
}
async function mark(peer, args) {
  if (state === 'HANDOVER' || state === 'DISCONNECTED') return toolResult(state)
  if (!lease) return toolResult('NO_LEASE')
  if (performance.now() >= lease.expires) {
    void handover('EXPIRED').catch(() => {})
    return toolResult('EXPIRED')
  }
  if (lease.peer !== peer || !peer.stream) return toolResult('NOT_OWNER')
  if (lease.generation !== args.generation) return toolResult('STALE_GENERATION')
  if (flight) return toolResult('BUSY')
  // Keep the CDP promise through MCP cancellation; the renderer may still have work.
  const work = page.evaluate(({ marker, hold }) => window.m0Mark(marker, hold), args)
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
  const peer = tickets.get(digest(req.headers.authorization))
  check(peer, 'MCP_CREDENTIAL_REVOKED', 401)
  const body = req.method === 'POST' ? await json(req) : undefined
  if (!peer.transport) {
    check(isInitializeRequest(body), 'USE_MCP_INITIALIZE', 400)
    const server = new McpServer({ name: 'm0-browser-provider', version: '0.0.1' })
    server.registerTool('mark', {
      description: 'Write a marker in the M0 browser fixture under the current generation.',
      inputSchema: {
        generation: z.string().max(64),
        marker: z.string().regex(/^[a-z0-9-]{1,40}$/),
        hold: z.boolean(),
      },
    }, args => mark(peer, args))
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
    return respond(res, 200, { state, reason, inFlight: Boolean(flight), lease: Boolean(lease), mcpProtocol: lease?.peer.protocol })
  }
  check(req.method === 'POST', 'NOT_FOUND', 404)
  const args = await json(req)
  let result
  switch (req.url) {
    case '/recover': result = await recover(); break
    case '/issue': {
      check(tickets.size < 32, 'TOO_MANY_MCP_CONNECTIONS')
      const credential = randomBytes(32).toString('hex')
      const key = digest('Bearer ' + credential)
      const id = randomUUID()
      tickets.set(key, { id, key, stream: false })
      result = { id, credential }
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
listen(mcp, '172.30.232.2', 8080)
listen(control, '172.30.233.2', 8081)
