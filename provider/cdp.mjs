import { once } from 'node:events'
import { unlink } from 'node:fs/promises'
import { connect, createServer } from 'node:net'

const path = '/run/workstation-cdp/cdp.sock'
const relay = process.argv[2] === 'relay'
const target = relay ? { host: '127.0.0.1', port: 9222 } : { path }

if (relay) {
  // The sole writer recreates the socket if the previous relay was killed.
  process.umask(0o077)
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}

const server = createServer(peer => {
  const upstream = connect(target)
  peer.once('error', () => upstream.destroy())
  upstream.once('error', () => peer.destroy())
  peer.once('close', () => upstream.destroy())
  upstream.once('close', () => peer.destroy())
  peer.pipe(upstream).pipe(peer)
})
server.listen(relay ? { path } : { host: '127.0.0.1', port: 9223 })
await once(server, 'listening')
if (!relay) await import('./server.mjs')
