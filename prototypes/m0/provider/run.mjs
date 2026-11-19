import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

const cli = ['compose', ...process.argv.slice(2)]
const compose = (...args) => execFileSync('docker', [...cli, ...args], { stdio: 'inherit' })
function connect(service, script, notify = () => {}) {
  const child = spawn('docker', [...cli, 'exec', '-T', service, 'node', '/m0/provider/' + script],
    { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let serial = 0, closed = false
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  child.stdin.on('error', () => {})
  createInterface({ input: child.stdout }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method === 'session/request_permission') {
      return send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    }
    if (message.method) return notify(message)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timeout)
    if (message.error) waiter.reject(new Error(waiter.method + ': ' + message.error.message))
    else waiter.resolve(message.result)
  })
  const end = () => {
    closed = true
    for (const { timeout, method, reject } of pending.values()) {
      clearTimeout(timeout)
      reject(new Error(method + ': process disconnected'))
    }
    pending.clear()
  }
  child.once('error', end)
  child.once('close', end)
  return {
    call(method, params) {
      if (closed) return Promise.reject(new Error(method + ': process disconnected'))
      const id = ++serial
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(method + ': timeout')) }, 75_000)
        pending.set(id, { timeout, method, resolve, reject })
        send({ jsonrpc: '2.0', id, method, params })
      })
    },
    close() { child.stdin.end() },
  }
}
async function poll(label, read, timeout = 20_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) { lastError = error.message }
    await sleep(150)
  }
  throw Error(label + (lastError ? ': ' + lastError : ''))
}
const viewer = connect('viewer', 'viewer.mjs')
const control = (path, body) => viewer.call('control', { path, body })
const ok = async (path, body) => {
  const reply = await control(path, body)
  assert.equal(reply.status, 200, path + ': ' + reply.data.error)
  return reply.data
}
const state = (expected, reason, inFlight) => poll('Provider did not enter ' + expected + ' ' + (reason ?? ''), async () => {
  const status = await ok('/status')
  return status.state === expected && (!reason || status.reason === reason) &&
    (inFlight === undefined || status.inFlight === inFlight) && status
})
const wire = () => viewer.call('wire')
const auth = expected => poll('Selkies did not report input authority ' + expected, async () => {
  const status = await wire()
  return status.ready === 1 && status.mk === expected && status.video > 0 && status
})
const events = () => viewer.call('observe')
const seen = (name, timeout) => poll('Chromium witness did not observe ' + name, async () => (await events()).includes(name), timeout)
const inject = frames => viewer.call('send', frames)
const pulse = ['kd,97', 'ku,97', 'm,300,250,0,0', 'm,300,250,1,0', 'm,300,250,0,0']
const snapshot = events => Object.fromEntries(['keydown', 'keyup', 'mousedown', 'mouseup'].map(
  type => [type, events.filter(event => event === 'event:' + type).length],
))
async function humanInput() {
  await auth('1')
  const before = snapshot(await events())
  await inject(pulse)
  await poll('Selkies input positive control did not reach Chromium', async () => {
    const after = snapshot(await events())
    return Object.keys(before).every(type => after[type] > before[type])
  }, 10_000)
}
async function deniedInput() {
  const locked = await auth('0')
  const before = snapshot(await events())
  await inject([...pulse, 'REQUEST_KEYFRAME'])
  await poll('locked socket did not deliver new video', async () => {
    const current = await wire()
    return current.ready === 1 && current.video > locked.video
  }, 15_000)
  await sleep(450)
  assert.deepEqual(snapshot(await events()), before, 'human keyboard or pointer reached Chromium while locked')
}
async function recover() {
  const result = await poll('could not recover browser into HUMAN', async () => {
    const reply = await control('/recover', {})
    if (reply.status !== 200) throw Error(reply.data.error)
    return reply.data
  }, 90_000)
  assert.equal(result.state, 'HUMAN')
  assert.equal(result.browser, 'Chrome/156.0.8078.79')
  assert.equal(result.protocol, '1.3')
  await seen('event:ready')
  await viewer.call('connect')
  await humanInput()
}
function restartBrowser() {
  compose('stop', '-t', '2', 'cdp-relay')
  compose('start', 'chromium', 'cdp-relay')
}

let acp
const turns = new Map()
async function startDsh() {
  acp = connect('dsh', 'agent.mjs', ({ method, params }) => {
    if (method !== 'session/update') return
    const turn = turns.get(params.sessionId)
    if (!turn) return
    if (params.update.sessionUpdate === 'agent_message_chunk' && params.update.content.type === 'text') {
      turn.text += params.update.content.text
    }
    if (params.update.sessionUpdate === 'tool_call') turn.tools.push(params.update.title)
  })
  const info = await acp.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(info.protocolVersion, 1)
  assert.equal(info.agentCapabilities.mcpCapabilities.http, true)
}
const mcpOptions = peer => ({
  cwd: '/workspace',
  mcpServers: [{ name: 'browser', type: 'http', url: 'http://provider:8080/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer ' + peer.credential }] }],
})
async function startSession(peer, previous) {
  const params = mcpOptions(peer)
  if (previous) await acp.call('session/resume', { ...params, sessionId: previous })
  const sessionId = previous ?? (await acp.call('session/new', params)).sessionId
  assert(sessionId)
  return { ...peer, sessionId }
}
const issueSession = async previous => startSession(await ok('/issue', {}), previous)
async function ask(peer, marker, generation = 'none', mode = 'once') {
  const turn = { text: '', tools: [] }
  turns.set(peer.sessionId, turn)
  try {
    const result = await acp.call('session/prompt', { sessionId: peer.sessionId,
      prompt: [{ type: 'text', text: ['m0', marker, generation, mode].join(':') }] })
    assert.equal(result.stopReason, 'end_turn', marker + ': DSH turn did not settle')
    const value = /^M0 result (\S+)$/.exec(turn.text.trim())?.[1]
    assert(value, marker + ': no deterministic tool result from DSH')
    assert.deepEqual(turn.tools, Array(mode === 'parallel' ? 2 : 1).fill('mcp__browser__mark'), marker + ': wrong DSH tool dispatch')
    return value.split(',').sort().join(',')
  } finally {
    turns.delete(peer.sessionId)
  }
}
const grant = async (peer, ttl = 90_000) => (await ok('/grant', { peer: peer.id, ttl })).generation
const release = async marker => assert.equal(await viewer.call('release', marker), 204, 'renderer barrier was not live')
const background = promise => { void promise.catch(() => {}); return promise }

try {
  await state('DISCONNECTED', 'BOOT')
  for (const endpoint of ['127.0.0.1:9222', '127.0.0.1:9223', '172.30.231.2:9223', '172.30.232.2:8080', '172.30.233.2:8081']) {
    await assert.rejects(fetch('http://' + endpoint + '/json/version', { signal: AbortSignal.timeout(1200) }), 'host reached private endpoint')
  }
  compose('exec', '-T', 'dsh', 'node', '/m0/provider/agent.mjs', '--network')
  await recover()
  console.log('CDP bridge endpoints: Chromium/relay and Provider only; Provider alone attached to Chromium 156.0.8078.79 (CDP 1.3)')

  await startDsh()
  const a = await issueSession(), b = await issueSession()
  assert.equal(await ask(a, 'human-denied'), 'NO_LEASE')
  const contenders = await Promise.all([a, b].map(peer => control('/grant', { peer: peer.id, ttl: 90_000 })))
  assert.deepEqual(contenders.map(reply => reply.status).sort(), [200, 409])
  assert.equal(contenders.find(reply => reply.status === 409).data.error, 'NOT_HUMAN')
  let owner = contenders[0].status === 200 ? a : b
  const other = owner === a ? b : a
  let generation = contenders.find(reply => reply.status === 200).data.generation
  assert.equal(await ask(other, 'wrong-owner', generation), 'NOT_OWNER')
  await deniedInput()
  assert.equal(await ask(owner, 'valid', generation), 'M0_OK')
  await seen('finished:valid')
  console.log('official DSH ACP → official Streamable HTTP MCP: valid lease wrote the Chromium marker; HUMAN/no lease and a second Agent were denied')
  console.log('competing grants admitted exactly one owner; raw Selkies keys and buttons were blocked with live video')

  const simultaneous = background(ask(owner, 'parallel', generation, 'parallel'))
  const winner = await poll('neither concurrent operation reached the renderer barrier', async () => {
    const entry = (await events()).find(event => event.startsWith('barrier:parallel-'))
    return entry?.split(':')[1]
  })
  const takeover = background(ok('/takeover', {}))
  const handover = await state('HANDOVER', 'TAKEOVER', true)
  assert(handover.lease, 'lease cleared before the action drained')
  assert.equal(await ask(other, 'during-takeover', generation), 'HANDOVER')
  await deniedInput()
  assert(!(await events()).includes('finished:' + winner))
  await release(winner)
  assert.equal(await simultaneous, 'BUSY,M0_OK')
  assert.equal((await takeover).state, 'HUMAN')
  const finished = (await events()).indexOf('finished:' + winner)
  assert(finished >= 0)
  await humanInput()
  assert((await events()).slice(finished + 1).includes('event:mousedown'))
  console.log('parallel tools produced one CDP operation and one BUSY result; takeover stopped admission, drained the renderer, revoked the lease, then restored Selkies input')

  const expiring = await grant(owner, 4500)
  const draining = background(ask(owner, 'expiry-drain', expiring, 'hold'))
  await seen('barrier:expiry-drain', 10_000)
  await state('HANDOVER', 'EXPIRED', true)
  assert.equal(await ask(other, 'during-expiry', expiring), 'HANDOVER')
  await deniedInput()
  await release('expiry-drain')
  assert.equal(await draining, 'M0_OK')
  assert.equal((await state('HUMAN', 'EXPIRED', false)).lease, false)
  await humanInput()
  assert.equal(await ask(owner, 'expired', expiring), 'NO_LEASE')
  generation = await grant(owner)
  assert.notEqual(generation, expiring)
  assert.equal(await ask(owner, 'stale-before-restart', expiring), 'STALE_GENERATION')
  assert.equal(await ask(owner, 'new-generation', generation), 'M0_OK')
  console.log('expiry drained in flight before restoring input; the same DSH session could not use the old generation after a new grant')

  const killedDsh = background(ask(owner, 'dsh-disconnect', generation, 'hold'))
  await seen('barrier:dsh-disconnect')
  compose('kill', '-s', 'SIGKILL', 'dsh')
  await assert.rejects(killedDsh, /process disconnected/)
  await state('HANDOVER', 'MCP_LOST', true)
  await deniedInput()
  await release('dsh-disconnect')
  await state('HUMAN', 'MCP_LOST', false)
  await humanInput()
  compose('start', 'dsh')
  await startDsh()
  await assert.rejects(startSession(owner), /session\/new:/)
  owner = await issueSession(owner.sessionId)
  assert.equal(await ask(owner, 'resume-no-lease', generation), 'NO_LEASE')
  const beforeDshRestart = generation
  generation = await grant(owner)
  assert.equal(await ask(owner, 'old-dsh-generation', beforeDshRestart), 'STALE_GENERATION')
  assert.equal(await ask(owner, 'after-dsh-restart', generation), 'M0_OK')
  console.log('DSH SIGKILL closed the MCP stream; the provider drained before human control, refused the spent credential, and required a new generation for the resumed DSH session')

  const lostBrowser = background(ask(owner, 'browser-drop', generation, 'hold'))
  await seen('barrier:browser-drop')
  compose('kill', '-s', 'SIGKILL', 'chromium')
  assert.equal(await lostBrowser, 'ACTION_UNCERTAIN')
  assert.equal((await state('DISCONNECTED')).lease, false)
  assert.equal(await ask(owner, 'disconnected', generation), 'DISCONNECTED')
  assert(!(await events()).includes('finished:browser-drop'))
  restartBrowser()
  await recover()
  const beforeBrowserRestart = generation
  generation = await grant(owner)
  assert.equal(await ask(owner, 'old-browser-generation', beforeBrowserRestart), 'STALE_GENERATION')
  assert.equal(await ask(owner, 'after-browser-restart', generation), 'M0_OK')
  console.log('Chromium SIGKILL left no lease and no completed renderer marker; explicit recovery of a new Chromium process required a fresh lease')

  const lostProvider = background(ask(owner, 'provider-drop', generation, 'hold'))
  await seen('barrier:provider-drop')
  compose('kill', '-s', 'SIGKILL', 'provider')
  await deniedInput()
  await release('provider-drop')
  await seen('finished:provider-drop')
  const providerLost = await lostProvider.catch(() => 'DISCONNECTED')
  assert.notEqual(providerLost, 'M0_OK')
  compose('start', 'provider')
  await state('DISCONNECTED', 'BOOT')
  assert.equal((await control('/recover', {})).data.error, 'RESET_NEEDS_NEW_BROWSER')
  await deniedInput()
  compose('kill', '-s', 'SIGKILL', 'chromium')
  restartBrowser()
  await recover()
  const final = await issueSession()
  const current = await grant(final)
  assert.equal(await ask(final, 'after-provider-restart', current), 'M0_OK')
  await ok('/takeover', {})
  await humanInput()
  console.log('Provider SIGKILL kept Selkies view only even while a renderer action continued; its restart refused the same Chromium process and recovered only after browser replacement')

  // A token update can block new frames without releasing a previously held pointer button.
  const held = snapshot(await events())
  await inject(['m,320,240,1,0'])
  await poll('held-button positive control missing', async () => snapshot(await events()).mousedown > held.mousedown)
  const heldGeneration = await grant(final)
  await auth('0')
  await inject(['m,320,240,0,0'])
  await sleep(600)
  const releasedBySelkies = snapshot(await events()).mouseup > held.mouseup
  assert.equal(await ask(final, 'held-button-state', heldGeneration), 'M0_OK')
  await ok('/takeover', {})
  await inject(['m,320,240,0,0'])
  await poll('did not restore held pointer after return to HUMAN', async () => snapshot(await events()).mouseup > held.mouseup)
  assert(releasedBySelkies, 'Gate C BLOCKED: a mouse button held before grant was not released by the live Selkies token update')
  console.log('Selkies released a held pointer before Agent operation')
} catch (error) {
  console.error(String(error).replace(/(?:https?|wss?):\/\/\S+|\b[\w-]{32,}\b/g, '[redacted]'))
  process.exitCode = 1
} finally {
  acp?.close()
  viewer.close()
}
