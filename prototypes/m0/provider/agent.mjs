import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { json } from 'node:stream/consumers'

if (process.argv[2] === '--network') {
  const denied = [
    'http://172.30.231.2:9223/json/version', 'http://172.30.231.2:9222/json/list',
    'http://chromium:9223/json/version', 'http://172.30.231.2:3000/browser/api/tokens',
    'http://172.30.233.2:8081/status', 'http://provider:8081/status',
  ]
  await Promise.all(denied.map(async url => {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }), 'DSH reached a denied network endpoint')
  }))
  assert.equal((await fetch('http://provider:8080/mcp', { signal: AbortSignal.timeout(2000) })).status, 401)
  console.log('DSH container: direct CDP, Selkies administration and Provider control unreachable; MCP requires a credential')
  process.exit(0)
}

if (process.argv[2] === '--wire-call') {
  const { credential, mcpSession, protocol, marker, generation } = await json(process.stdin)
  const response = await fetch('http://provider:8080/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + credential,
      'Mcp-Session-Id': mcpSession,
      'Mcp-Protocol-Version': protocol,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'm0-wire-' + marker, method: 'tools/call',
      params: { name: 'mark', arguments: { marker, generation, hold: false } },
    }),
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.status, 200)
  const { result } = await response.json()
  assert.equal(result?.isError, true, 'overlapping MCP call was not denied')
  console.log(result.content[0].text)
  process.exit(0)
}

const toolName = 'mcp__browser__mark'
const command = /^m0:([a-z0-9-]{1,30}):([a-zA-Z0-9:-]{1,64}):(once|hold)$/
const codes = /\b(?:M0_OK|NO_LEASE|NOT_OWNER|STALE_GENERATION|BUSY|HANDOVER|DISCONNECTED|EXPIRED|ACTION_UNCERTAIN)\b/g
function outcome(result) {
  const seen = [...JSON.stringify(result.content).matchAll(codes)].map(match => match[0])
  const code = seen.at(-1) ?? 'UNKNOWN_TOOL_RESULT'
  return Boolean(result.is_error) === (code !== 'M0_OK') ? code : 'WRONG_ERROR_FLAG'
}
function sendMessages(res, model, actions, text) {
  const events = [
    { type: 'message_start', message: { id: 'm0', type: 'message', role: 'assistant', model, content: [],
      usage: { input_tokens: 3, output_tokens: 0 } } },
  ]
  if (actions.length) {
    for (const [index, args] of actions.entries()) {
      events.push(
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call-' + args.marker, name: toolName, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
        { type: 'content_block_stop', index },
      )
    }
  } else {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    )
  }
  events.push(
    { type: 'message_delta', delta: { stop_reason: actions.length ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  )
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}
// Deterministic Messages API fixture. The DSH binary still discovers, runs and records the MCP tool.
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') return res.writeHead(404).end()
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    const user = data.messages.filter(message => message.role === 'user').flatMap(message =>
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content)
    const match = user.findLast(block => block.type === 'text' && command.test(block.text?.trim()))?.text.trim().match(command)
    if (!match) return sendMessages(res, data.model, [], 'M0 result NO_FIXTURE_PROMPT')
    const [, marker, generation, mode] = match
    const actions = [{ marker, generation, hold: mode === 'hold' }]
    const results = actions.map(args => user.findLast(block => block.type === 'tool_result' && block.tool_use_id === 'call-' + args.marker))
    if (results.every(Boolean)) return sendMessages(res, data.model, [], 'M0 result ' + results.map(outcome).join(','))
    if (!data.tools?.some(tool => tool.name === toolName)) return sendMessages(res, data.model, [], 'M0 result TOOL_NOT_LISTED')
    return sendMessages(res, data.model, actions, '')
  } catch {
    res.writeHead(400).end()
  }
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const child = spawn('/dsh-home/runtime/versions/0.2.2-rc.1/node_modules/.bin/dsh', ['--profile', 'acp'], {
  env: { ...process.env, DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, DEEPSEEK_API_KEY: 'm0-fixture-key' },
  stdio: ['inherit', 'inherit', 'pipe'],
})
let stderr = ''
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
child.once('exit', code => {
  if (code) console.error(stderr.replace(/(?:https?|wss?):\/\/\S+|\b[\w-]{32,}\b/g, '[redacted]'))
  process.exitCode = code ?? 1
  mock.closeAllConnections()
  mock.close()
})
