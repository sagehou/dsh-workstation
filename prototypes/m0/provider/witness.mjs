import { createServer } from 'node:http'

const events = [], barriers = new Map()
createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://witness')
  if (req.method === 'GET' && pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.end(`<!doctype html><html lang="en"><title>M0 browser witness</title>
      <body style="background:lightblue"><h1>M0 browser witness</h1>
      <script>
        let count = 0
        const post = async path => {
          const response = await fetch(path, { method: 'POST' })
          if (!response.ok) throw Error('witness refused')
        }
        for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'wheel', 'mousemove']) {
          document.addEventListener(type, event => {
            if (event.isTrusted) void post('/event/' + type).catch(() => {})
          })
        }
        window.m0Mark = async (marker, hold) => {
          await post('/started/' + marker)
          if (hold) await post('/barrier/' + marker)
          document.body.dataset.lastMark = marker
          document.body.style.background = ++count % 2 ? 'lightgreen' : 'lightblue'
          await post('/finished/' + marker)
          return 'done'
        }
        void post('/event/ready')
      </script></body></html>`)
  }
  if (req.method === 'GET' && pathname === '/observe') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(events))
  }
  const [, action, marker] = pathname.split('/')
  if (req.method === 'POST' && /^[a-z0-9-]{1,40}$/.test(marker ?? '')) {
    if (action === 'barrier' && !barriers.has(marker)) {
      barriers.set(marker, res)
      const timeout = setTimeout(() => res.writeHead(504).end(), 45_000)
      res.once('close', () => { clearTimeout(timeout); barriers.delete(marker) })
      events.push(action + ':' + marker)
      return
    }
    if (action === 'release' && barriers.has(marker)) {
      barriers.get(marker).writeHead(204).end()
      return res.writeHead(204).end()
    }
    if (['event', 'started', 'finished'].includes(action)) {
      events.push(action + ':' + marker)
      return res.writeHead(204).end()
    }
  }
  res.writeHead(404).end()
}).listen(8081, '0.0.0.0')
