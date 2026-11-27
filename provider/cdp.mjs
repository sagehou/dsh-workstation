import { once } from 'node:events'
import { connect, createServer } from 'node:net'

const server = createServer(peer => {
  const upstream = connect('/run/workstation-cdp/cdp.sock')
  peer.once('error', () => upstream.destroy())
  upstream.once('error', () => peer.destroy())
  peer.once('close', () => upstream.destroy())
  upstream.once('close', () => peer.destroy())
  peer.pipe(upstream).pipe(peer)
})
server.listen({ host: '127.0.0.1', port: 9223 })
await once(server, 'listening')
await import('./server.mjs')
