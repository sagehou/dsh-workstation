import { closeSync, readFileSync } from 'node:fs'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export const inject = ['tools']

function readTickets() {
  if (process.env.M0_WEB_TICKET_FD !== '3') return []
  delete process.env.M0_WEB_TICKET_FD
  try {
    const tickets = JSON.parse(readFileSync(3, 'utf8'))
    if (!Array.isArray(tickets) || tickets.length > 32 || tickets.some(ticket =>
      !/^[0-9a-f-]{36}$/.test(ticket?.id) || !/^[0-9a-f]{64}$/.test(ticket?.credential) ||
      !Number.isSafeInteger(ticket?.acceptUntil))) throw Error()
    return tickets
  } catch {
    throw Error('M0 browser tickets could not be loaded from the launcher pipe')
  } finally {
    try { closeSync(3) } catch {}
  }
}

export function apply(ctx) {
  const tickets = readTickets()
  if (!tickets.length) return
  const clients = new Map()
  let stopping = false

  ctx.tools.guard(exec => {
    if (exec.name.startsWith('mcp__browser__') && !clients.get(exec.agent)?.ready) {
      return 'This session has no active browser MCP connection'
    }
  })
  ctx.effect(() => async () => {
    stopping = true
    tickets.length = 0
    const mounted = [...clients.values()]
    clients.clear()
    await Promise.all(mounted.map(async ({ fiber }) => fiber.dispose()))
  })
  // Agent disposal has already unwound registrations in agent.ctx at this event.
  ctx.on('agent/disposed', ({ agent }) => { clients.delete(agent) })
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (stopping || signal?.aborted || clients.has(agent) || agent.session.meta.parentSession !== undefined) return
    while (tickets.length && tickets[0].acceptUntil <= Date.now()) tickets.shift()
    const ticket = tickets.shift()
    if (!ticket) return
    let fiber
    const abort = () => {
      clients.delete(agent)
      void Promise.resolve(fiber?.dispose()).catch(() => {})
    }
    try {
      const headers = { Authorization: 'Bearer ' + ticket.credential }
      const config = McpClient.Config({
        serverName: 'browser',
        transport: 'streamable-http',
        url: 'http://provider:8080/mcp',
        headers,
        failOnStartupError: true,
        reconnect: { enabled: false },
      })
      fiber = agent.ctx.plugin(McpClient, { ...config, headers })
      const client = { fiber, ready: false }
      clients.set(agent, client)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      await fiber
      if (stopping || signal?.aborted || clients.get(agent) !== client) return
      client.ready = true
      console.log(`M0 browser binding session=${agent.id} peer=${ticket.id}`)
    } catch {
      abort()
      ctx.logger.warn('M0 browser connection unavailable for this session')
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }, { prepend: true })
}
