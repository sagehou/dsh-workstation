import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const ticket = `__Host-m0_run=${randomBytes(24).toString('hex')}`
createServer((req, res) => {
  switch (req.url) {
    case '/__m0/bootstrap':
      res.writeHead(204, { 'Set-Cookie': `${ticket}; Secure; HttpOnly; SameSite=Lax; Path=/` }).end()
      return
    case '/__m0/verify':
      res.writeHead(req.headers.cookie?.split(';').some(value => value.trim() === ticket) ? 204 : 401).end()
      return
    case '/human':
      res.setHeader('Set-Cookie', 'm0_profile=human; Max-Age=3600; Path=/; SameSite=Lax; HttpOnly')
      break
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.url === '/') {
    const source = req.headers.host === 'foreign.m0.test' ? 'https://m0.test/browser/' : '/browser/'
    res.end(`<!doctype html><html lang="en"><title>M0 iframe</title><iframe title="Selkies" style="width:96vw;height:92vh" src="${source}"></iframe></html>`)
    return
  }
  if (req.url === '/agent') {
    res.end('<!doctype html><html lang="en"><title>M0 agent</title><style>body{background:#1755a0;color:white}</style><h1>M0 agent</h1><input aria-label="Agent page marker" autofocus></html>')
    return
  }
  res.end('<!doctype html><html lang="en"><title>M0 fixture</title><style>body{background:#882134;color:white}</style><h1>M0 fixture</h1></html>')
}).listen(8080, '0.0.0.0')
