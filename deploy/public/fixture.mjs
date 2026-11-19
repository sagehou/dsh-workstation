import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as https } from 'node:https'
import { json } from 'node:stream/consumers'

https({ key: readFileSync('/fixture/key.pem'), cert: readFileSync('/fixture/cert.pem') }, (req, res) => {
  const name = { '/alpha': 'WTAB_ALPHA', '/beta': 'WTAB_BETA' }[req.url]
  if (!name) return res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>' + name + '</title><p>' + name + '</p>')
}).listen(443, '0.0.0.0')

function reply(res, model, action, text) {
  const events = [{ type: 'message_start', message: {
    id: 'compose-ci', type: 'message', role: 'assistant', model, content: [],
    usage: { input_tokens: 3, output_tokens: 0 },
  } }]
  if (action) {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: action.id, name: action.name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(action.args) } },
    )
  } else {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    )
  }
  events.push({ type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: action ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of events) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
  res.end()
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') return res.writeHead(404).end()
  try {
    const data = await json(req)
    const blocks = data.messages.filter(message => message.role === 'user').flatMap(message =>
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content)
    const text = blocks.findLast(block => block.type === 'text' && block.text.startsWith('compose-ci '))?.text
    if (!text) return reply(res, data.model, null, 'Compose fixture')
    const { label, operation, args } = JSON.parse(text.slice('compose-ci '.length))
    const id = 'ci_' + label
    const result = blocks.findLast(block => block.type === 'tool_result' && block.tool_use_id === id)
    if (result) {
      const content = JSON.stringify(result.content)
      const value = content.match(/\b(?:[a-f0-9-]{36}:\d+|WTAB_(?:ALPHA|BETA)|OK|NO_LEASE|NOT_OWNER|STALE_GENERATION|TAB_UNAVAILABLE|HANDOVER|BUSY|DISCONNECTED|EXPIRED|ORIGIN_NOT_ALLOWED|ACTION_UNCERTAIN)\b/g)?.at(-1)
      return reply(res, data.model, null, 'CI_RESULT_' + label + '=' + (value ?? 'UNKNOWN'))
    }
    const name = 'mcp__browser__' + operation
    if (!data.tools?.some(tool => tool.name === name)) return reply(res, data.model, null, 'CI_RESULT_' + label + '=TOOL_NOT_LISTED')
    return reply(res, data.model, { id, name, args }, '')
  } catch {
    if (!res.headersSent) res.writeHead(400)
    res.end()
  }
}).listen(8087, '0.0.0.0')
