import { createServer, connect } from 'node:net'

// Chromium's desktop DevTools listener binds to loopback. This relay is reachable
// only from the isolated CDP bridge. The production lease boundary is separate.
createServer(peer => {
  const chromium = connect(9222, '127.0.0.1')
  chromium.once('error', () => peer.destroy())
  peer.once('error', () => chromium.destroy())
  peer.once('close', () => chromium.destroy())
  chromium.once('close', () => peer.destroy())
  peer.pipe(chromium).pipe(peer)
}).listen(9223, '172.30.231.2')
