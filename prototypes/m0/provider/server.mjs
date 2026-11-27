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
// The allowlist is optional. `BROWSER_TOOL_ORIGINS` names origins the Agent may
// drive; leaving it empty means every HTTPS origin is allowed.
//
// Default-open is a deliberate product decision, recorded in ADR-0006 and issue
// #30: the Agent is the default owner of the browser and may reach any HTTPS
// origin. This single-operator deployment does not require an SSRF or egress
// policy. The allowlist still works when it is set, so a deployment that wants a
// narrower surface can restrict it without a code change.
//
// What this does NOT change: `allowed()` still rejects a non-HTTPS scheme and any
// URL carrying credentials. Neither of those is a browsing case, and both were
// rejected before the allowlist existed.
const rawOrigins = (process.env.BROWSER_TOOL_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
// A literal `*` is accepted as "no restriction" so an operator can be explicit
// rather than relying on an unset variable.
const allowAllOrigins = rawOrigins.length === 0 || rawOrigins.includes('*')
const origins = new Set(allowAllOrigins ? [] : rawOrigins)
for (const origin of origins) {
  if (!origin.startsWith('https://') || new URL(origin).origin !== origin) throw Error('Expected bare HTTPS browser tool origins')
}
const cdp = publicMode ? 'http://127.0.0.1:9223' : 'http://172.30.231.2:9223'
const selkies = publicMode ? 'http://browser:3000' : 'http://172.30.231.2:3000'
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
  if (locked && publicMode) {
    const released = await fetch(gate + '/handover', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + gateControl },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    // No release, no lease. Failing closed here is the whole point.
    check(released?.ok === true, 'INPUT_GATE_UNAVAILABLE')
    const body = await released.json().catch(() => ({}))
    check(body.released === true, 'INPUT_GATE_UNAVAILABLE')
  }
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
      // Chromium exits when its last tab closes, which would tear down the shared
      // profile mid-task and force a full reconnect (#29). Chromium has no
      // --keep-alive flag, so the context is watched instead: the moment the last
      // page goes, a blank one is opened to hold the process open.
      // Recording (#31). The operator's actions are captured by a script injected
      // into every document; Agent actions are recorded on this side, where the
      // tool name and generation are known. Both land in one JSONL file so the
      // timeline can be read in order.
      try {
        await installRecorder(attached)
      } catch (error) {
        // Recording is an audit aid. A browser that cannot record is still a
        // browser, so this must not take the attachment down.
        console.warn('Recorder install failed:', error?.message ?? error)
      }

      // Chromium exits when its last tab closes, which tears down the shared
      // profile mid-task (#29). It has no --keep-alive flag, so the context is
      // watched instead.
      //
      // The listener runs synchronously on every page event: by the time a
      // deferred callback fired, the browser had already begun shutting down and
      // `newPage()` failed with EPIPE. `pages()` still reports the closing tab at
      // that instant, so the count is taken after filtering closed ones rather
      // than trusting the length alone.
      // Only restore a page that *was* there. A context with no page at all is the
      // normal state right after Chromium starts, and creating one there raced the
      // fixture the tests install — the attachment then failed for a reason that
      // had nothing to do with the browser being gone.
      let sawPage = false
      const keepOnePage = context => {
        const live = context.pages().filter(page => !page.isClosed())
        if (live.length > 0) { sawPage = true; return }
        if (!sawPage) return
        context.newPage().catch(() => { /* the browser is going away anyway */ })
      }
      // A tab closing is what empties the browser, so the close has to be the
      // trigger. `context.on('page')` only fires on creation and would never see
      // the last tab go. Each page is watched when it appears, and the watcher is
      // re-attached to whatever the replacement page is.
      const watch = context => {
        keepOnePage(context)
        for (const page of context.pages()) {
          page.once('close', () => keepOnePage(context))
        }
        context.on('page', page => page.once('close', () => keepOnePage(context)))
      }
      for (const context of attached.contexts()) watch(context)
      attached.on('targetcreated', () => {
        for (const context of attached.contexts()) {
          for (const page of context.pages()) {
            if (page.listenerCount('close') === 0) page.once('close', () => keepOnePage(context))
          }
        }
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
// --- Recording (#31) -------------------------------------------------------
//
// Two streams, one file:
//   - human: DOM events from recorder.js, injected into every document
//   - agent: tool calls recorded in `browserAction`
//
// The split matters because the two sides see different things. The page cannot
// tell a CDP click from a real one except through `isTrusted`, and the Provider
// cannot see what the operator typed. Each records what it alone knows.
const RECORD_DIR = process.env.WORKSTATION_RECORD_DIR ?? '/state/recordings'
// Off unless asked for. The recorder is the only part of this process that talks
// to page internals, and a failure there must never be the reason an attachment
// fails — the attachment is what every browser tool depends on. A deployment that
// wants the timeline sets WORKSTATION_RECORD=1.
const RECORD_ENABLED = process.env.WORKSTATION_RECORD === '1'
const RECORDER_SOURCE = await readFile(new URL('./recorder.js', import.meta.url), 'utf8').catch(() => '')

let recordStream
let recordFile

async function recordSink () {
  if (recordStream !== undefined) return recordStream
  const { mkdirSync, createWriteStream } = await import('node:fs')
  // Synchronous on purpose: this runs once, before the first write, and the
  // async form returned a promise whose rejection was invisible here.
  mkdirSync(RECORD_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  recordFile = `${RECORD_DIR}/session-${stamp}.jsonl`
  recordStream = createWriteStream(recordFile, { flags: 'a' })
  recordStream.on('error', error => console.warn('Recording stream error:', error.message))
  return recordStream
}

// Recording is on by default (#31), but an operator may want a clean file for one
// task, so the state is explicit and exposed to the UI.
let recordActive = RECORD_ENABLED
function recordStatus () {
  return { active: recordActive, file: recordFile ?? null, dir: RECORD_DIR }
}

// Serialised writes: two events in the same millisecond would otherwise interleave
// inside a line and produce a file no reader can parse.
let recordQueue = Promise.resolve()
function record (entry) {
  if (!recordActive) return
  recordQueue = recordQueue.then(async () => {
    try {
      const stream = await recordSink()
      stream.write(JSON.stringify(entry) + '\n')
    } catch (error) {
      console.warn('Recording write failed:', error?.message ?? error)
    }
  })
}

// `connectOverCDP` returns a browser whose contexts are *real* Chrome contexts, not
// Playwright-created ones: `addInitScript` and `exposeBinding` are only available
// on a browser Playwright launched itself, and calling them here threw
// ATTACH_FAILED and took the whole attachment down with it.
//
// The CDP equivalents are what octop-browser uses (`recorder.py:172`):
// Page.addScriptToEvaluateOnNewDocument runs the script before any page script in
// every new document, and Runtime.addBinding gives the page a function to call.
// Both are sent through the same CDP session Playwright already owns.
async function installRecorder (attached) {
  if (!RECORD_ENABLED || RECORDER_SOURCE === '') return
  for (const context of attached.contexts()) {
    for (const page of context.pages()) {
      await installOnPage(page).catch(error => {
        // One page that refuses must not stop the others, and recording is an aid:
        // a browser that cannot record is still a browser.
        console.warn('Recorder install failed for a page:', error?.message ?? error)
      })
    }
    // New documents get the script before their own code runs.
    context.on('page', page => { void installOnPage(page).catch(() => {}) })
  }
  record({ source: 'recorder', event: 'installed', at: Date.now(), file: recordFile })
}

async function installOnPage (page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Runtime.addBinding', { name: '__workstationRecord' })
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SOURCE })
  // Documents already loaded never saw the init script.
  await session.send('Runtime.evaluate', { expression: RECORDER_SOURCE, returnByValue: true })
  session.on('Runtime.bindingCalled', event => {
    if (event.name !== '__workstationRecord') return
    let parsed
    try { parsed = JSON.parse(event.payload) } catch { return }
    record({ source: 'human', receivedAt: Date.now(), ...parsed })
  })
}

const liveBinding = binding => binding && binding.browserId === browserId && !binding.page.isClosed()

// Does an open tab look like the thing this call is about?
//
// Deliberately shallow: a URL host comparison and a title substring. A deeper
// match (full URL, page content) would bind to a stale tab after a navigation and
// then act on the wrong page, which is worse than opening a new one. Returning
// `undefined` is the safe answer.
function matchTab (pages, intent) {
  if (!intent) return undefined
  const want = String(intent).trim().toLowerCase()
  if (want === '') return undefined
  let wantHost
  try {
    // Accept a bare host, a URL, or a title fragment.
    wantHost = new URL(want.includes('://') ? want : 'https://' + want).hostname.replace(/^www\./, '')
  } catch { wantHost = undefined }
  for (const page of pages) {
    let pageHost
    try { pageHost = new URL(page.url()).hostname.replace(/^www\./, '') } catch { pageHost = '' }
    if (wantHost && pageHost && (pageHost === wantHost || pageHost.endsWith('.' + wantHost))) return page
    // A title fragment covers "the tab I am already reading about X".
    if (pageHost === '' || !wantHost) continue
    const title = (() => { try { return page.url() } catch { return '' } })()
    if (title.toLowerCase().includes(want)) return page
  }
  return undefined
}

async function bindTab(peer, intent) {
  if (peer.binding) return peer.binding
  const id = browserId
  // Agent-first (#29): the Agent drives a real page, not the M0 fixture.
  //
  // Binding is by intent, not by position. Taking `pages[0]` meant the Agent drove
  // whichever tab happened to be first in the list, which is rarely the one the
  // operator is looking at and never related to the task. The rule now:
  //
  //   the call carries a target (a URL host or a page title fragment) and a live
  //   tab matches it  -> bind that tab, so a follow-up continues where it started
  //   no target, or nothing matches -> open a fresh tab and bind that
  //
  // Leave other sessions' tabs available for their next grant.
  const context = browser.contexts()[0]
  const reserved = new Set([...tickets.values()].map(other => other.binding?.page))
  const pages = context.pages().filter(page => !page.isClosed() && !reserved.has(page))
  const tab = matchTab(pages, intent) ?? await context.newPage()
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

async function grant(peerId, ttl, { automatic = false, intent } = {}) {
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
    const binding = peer.tab ? await bindTab(peer, intent) : { browserId, page }
    check(state === 'HANDOVER' && browser.isConnected() && peer.stream, 'OWNER_LOST_DURING_GRANT')
    check(liveBinding(binding), 'TAB_UNAVAILABLE')
    const generation = boot + ':' + ++nextGeneration
    lease = { peer, binding, generation, automatic, expires: performance.now() + ttl }
    state = 'AGENT'
    reason = 'GRANTED'
    armExpiry(ttl)
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
// Idle automatic leases return to the operator. Explicit grants keep their TTL.
const AUTO_LEASE_MS = 10_000

// Arm the expiry at `ms`. Split out so every re-arm path uses the same callback.
function armExpiry (ms) {
  clearTimeout(expiry)
  expiry = setTimeout(() => { void handover('EXPIRED').catch(() => {}) }, ms)
}

function leaseDenied(peer) {
  if (state === 'HANDOVER' || state === 'DISCONNECTED') return state
  if (!lease) return 'NO_LEASE'
  if (lease.peer !== peer || !peer.stream) return 'NOT_OWNER'
  if (performance.now() >= lease.expires) return 'EXPIRED'
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
    recordOutcome('ACTION_UNCERTAIN')
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
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return allowAllOrigins || origins.has(url.origin)
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
  if (lease.automatic) {
    lease.expires = performance.now() + AUTO_LEASE_MS
    armExpiry(AUTO_LEASE_MS)
  }
  // Recorded before the work, so a call that fails still appears in the timeline
  // with the reason. An audit that only shows successes cannot explain a break.
  const startedAt = Date.now()
  const recordOutcome = outcome => record({
    source: 'agent',
    at: startedAt,
    event: operation,
    generation: args.generation,
    args: operation === 'navigate' ? { url: args.url } : operation === 'click' ? { role: args.role, name: args.name } : {},
    outcome,
  })
  const work = (async () => {
    if (operation === 'navigate') await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    if (operation === 'click') {
      const match = tab.getByRole(args.role, { name: args.name, exact: true })
      await match.click({ timeout: 4_000 })
    }
    if (!allowed(tab.url())) return toolResult('ORIGIN_NOT_ALLOWED')
    if (operation !== 'read') { recordOutcome('OK'); return textResult('OK') }
    // Browser-side constants only; no model-supplied JavaScript.
    const visible = await tab.evaluate(() => (document.body?.innerText ?? '').slice(0, 8000))
    const ok = allowed(tab.url())
    // The text itself is not stored: a recording is a timeline, not a transcript,
    // and page content is where credentials end up.
    recordOutcome(ok ? 'OK' : 'ORIGIN_NOT_ALLOWED')
    return ok ? textResult(visible) : toolResult('ORIGIN_NOT_ALLOWED')
  })()
  flight = work
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser timeout')), 12_000)
    })])
  } catch {
    recordOutcome('ACTION_UNCERTAIN')
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
    server.registerTool(operation, {
      description,
      inputSchema: { generation, ...inputs },
    }, args => browserAction(peer, args, operation))
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
      description: publicMode
        ? 'Get this session’s lease generation, acquiring control when free. Pass a URL host as intent to reuse a matching tab.'
        : 'Get this session’s active lease generation before using browser tools.',
      inputSchema: publicMode ? { intent: z.string().max(200).optional() } : {},
    }, async ({ intent } = {}) => {
      if (publicMode && state === 'HUMAN' && !lease) {
        try {
          await grant(peer.id, AUTO_LEASE_MS, { automatic: true, intent })
        } catch (error) {
          return toolResult(error instanceof Denied ? error.message : 'AUTO_LEASE_FAILED')
        }
      }
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
  const request = new Request('http://gateway:8080/mcp', {
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
    return respond(res, 200, { state, reason, inFlight: Boolean(flight), lease: Boolean(lease), mcpProtocol: lease?.peer.protocol, peers, record: recordStatus() })
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
    case '/record/start':
      recordActive = true
      await recordSink().catch(() => {})
      record({ source: 'recorder', event: 'started', at: Date.now(), file: recordFile })
      result = recordStatus()
      break
    case '/record/stop':
      record({ source: 'recorder', event: 'stopped', at: Date.now(), file: recordFile })
      recordActive = false
      result = recordStatus()
      break
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
// Gateway exposes credential-protected MCP only on the workstation network.
// The prototype uses its own fixture addresses and keeps its MCP listener.
const providerHost = process.env.PROVIDER_IP ??
  (publicMode ? '172.30.241.3' : '172.30.232.2')
const controlHost = process.env.PROVIDER_CONTROL_IP ?? '172.30.233.2'
if (!publicMode || process.env.WORKSTATION_BROWSER_MCP === '1') listen(mcp, providerHost, 8080)
listen(control, controlHost, 8081)

if (publicMode) {
  let lastProblem
  const retry = () => {
    if (state === 'DISCONNECTED' && ['BOOT', 'BROWSER_LOST'].includes(reason) && !recovering && !flight) {
      void recover().then(() => { lastProblem = undefined }, error => {
        const problem = error instanceof Denied ? error.message : error?.code === 'EROFS' ? 'SCRATCH_READ_ONLY' : 'ATTACH_FAILED'
        if (problem !== lastProblem) {
          // The generic label hid the cause for several rounds: every non-Denied
          // failure printed ATTACH_FAILED, so a missing Playwright API and a dead
          // CDP socket looked identical. The message is kept beside it.
          console.warn('Provider attachment unavailable:', problem, '-', error?.message ?? String(error))
        }
        lastProblem = problem
      })
    }
  }
  retry()
  setInterval(retry, 3000).unref()
}
