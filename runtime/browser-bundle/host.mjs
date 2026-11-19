import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export const inject = ['tools']

export function apply(ctx) {
  if (process.env.WORKSTATION_BROWSER_MCP !== '1') return
  const key = readFileSync('/run/secrets/browser_enroll', 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(key)) throw Error('Invalid workstation MCP admission key')
  const clients = new Map()
  let stopping = false

  ctx.tools.guard(exec => {
    if (exec.name.startsWith('mcp__browser__') && !clients.get(exec.agent)?.ready) {
      return 'This session has no active browser MCP connection'
    }
  })
  ctx.effect(() => async () => {
    stopping = true
    const mounted = [...clients.values()]
    clients.clear()
    await Promise.all(mounted.map(async ({ fiber }) => fiber.dispose()))
  })
  // Agent disposal has already unwound registrations in agent.ctx at this event.
  ctx.on('agent/disposed', ({ agent }) => { clients.delete(agent) })
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (stopping || signal?.aborted || clients.has(agent) || agent.session.header.parentSession !== undefined) return
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agent.id)) return
    const claim = 'v1.' + agent.id + '.' + randomBytes(24).toString('hex') + '.' + (Date.now() + 60_000)
    const ticket = claim + '.' + createHmac('sha256', key).update(claim).digest('hex')
    let fiber
    const abort = () => {
      clients.delete(agent)
      void Promise.resolve().then(() => fiber?.dispose()).catch(() => {})
    }
    try {
      const headers = { Authorization: 'Bearer ' + ticket }
      const config = McpClient.Config({
        serverName: 'browser',
        transport: 'streamable-http',
        url: 'http://provider:8080/mcp',
        headers,
        failOnStartupError: true,
        toolCallTimeoutMs: 20_000,
        reconnect: { enabled: false },
      })
      agent.ctx.on('tools/execute', (exec, next) => {
        if (exec.name.startsWith('mcp__browser__') && exec.agent !== agent) {
          throw Error('This browser tool belongs to another session')
        }
        return next()
      })
      fiber = agent.ctx.plugin(McpClient, { ...config, headers })
      const client = { fiber, ready: false }
      clients.set(agent, client)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      await fiber
      if (stopping || signal?.aborted || clients.get(agent) !== client) return
      client.ready = true
    } catch {
      abort()
      ctx.logger.warn('Workstation browser connection unavailable for this session')
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }, { prepend: true })
}
