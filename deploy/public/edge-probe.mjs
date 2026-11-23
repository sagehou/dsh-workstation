#!/usr/bin/env node
// Edge-contract probe for the public Compose stack.
//
// Inspects only the TLS edge published by Traefik, so it exercises the same
// path a browser takes before any session exists. The authenticated contract
// (DSH over internal TLS, Selkies video, CSP framing) lives in
// deploy/public/check.mjs, which runs with a signed-in browser context.
//
// Usage: node deploy/public/edge-probe.mjs <version> <ca.pem> <host:port>
//   version    pinned Traefik tag under test, for example v3.7.14
//   ca.pem     PEM of the disposable edge certificate
//   host:port  for example workstation.test:443
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import http2 from 'node:http2'

const [version, caPath, authority] = process.argv.slice(2)
assert.match(version ?? '', /^v\d+\.\d+\.\d+$/, 'usage: edge-probe.mjs <version> <ca.pem> <host:port>')
assert.ok(caPath && authority, 'usage: edge-probe.mjs <version> <ca.pem> <host:port>')

const ca = readFileSync(caPath)
const [hostname, portText] = authority.split(':')
const port = Number(portText)

// Version-sensitive upstream behaviour. Verified against the tagged source, not
// only the migration prose: `denyConnect`, which answers 501 before routing, is
// present and wired at the entry point from v3.7.15
// (pkg/server/server_entrypoint_tcp.go). Earlier tags have no such guard, so a
// CONNECT falls through the router and gets an ordinary 404. Both are "no
// tunnel", but only v3.7.15+ guarantees 501.
const [major, minor, patch] = version.slice(1).split('.').map(Number)
const atLeast = (wantMinor, wantPatch) => major > 3 || (major === 3 && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch)))
const rejectsConnectWith501 = atLeast(7, 15)

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, servername: hostname, ca, path,
      method: 'GET', headers: { Host: hostname, ...headers } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(Error(`edge did not answer ${path} within 10s`)))
    req.end()
  })
}

// Raw HTTP/1.1 on a fresh TLS connection: fetch and node:https both refuse to
// send CONNECT.
function rawHttp1(bytes) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, servername: hostname, ca, ALPNProtocols: ['http/1.1'] })
    let text = ''
    const timer = setTimeout(() => { socket.destroy(); reject(Error('edge did not answer CONNECT within 10s')) }, 10_000)
    socket.on('secureConnect', () => socket.write(bytes))
    socket.on('data', chunk => {
      text += chunk.toString('latin1')
      if (!text.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.destroy()
      const [head] = text.split('\r\n\r\n')
      const [statusLine, ...lines] = head.split('\r\n')
      resolve({ statusLine, status: Number(statusLine.split(' ')[1]), headers: lines })
    })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

let checked = 0
function pass(name, detail) {
  checked += 1
  console.log(`EDGE ${version} ${name}: ${detail}`)
}

// 1. The pinned certificate terminates TLS and the login document is served.
{
  const { status, headers } = await get('/_auth/login')
  assert.equal(status, 200, 'unauthenticated login document')
  assert.match(headers['strict-transport-security'] ?? '', /max-age=31536000/, 'HSTS from the security middleware')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'same-origin')
  pass('tls-security-headers', 'TLS terminated with the pinned certificate; HSTS, nosniff and referrer policy present')
}

// 2. ForwardAuth still denies API and document traffic without a session, and
//    identity headers cannot be spoofed through the proxy. The forged headers
//    are kept separate from Accept so the document/API branch stays explicit.
{
  const forged = { 'X-Workstation-User': 'operator', 'X-Forwarded-User': 'operator', 'Remote-User': 'operator' }
  assert.equal((await get('/api/remote.mux', { Accept: 'application/json' })).status, 401, 'unauthenticated API')
  assert.equal((await get('/api/remote.mux', { Accept: 'application/json', ...forged })).status, 401,
    'forged identity headers must not authenticate an API call')
  assert.equal((await get('/', { Accept: 'text/html', ...forged })).status, 303,
    'forged identity headers must not skip login for a document')
  const document = await get('/', { Accept: 'text/html' })
  assert.equal(document.status, 303, 'unauthenticated document redirect')
  assert.match(document.headers.location ?? '', /_auth\/login/, 'redirect target')
  pass('forward-auth', 'API 401 and document 303, with and without forged identity headers')
}

// 3. The browser prefix is routed and the Selkies token administration route
//    stays out of the routing table. The frame contract is asserted after login
//    in check.mjs, because the ForwardAuth redirect never reaches the framing
//    middleware.
{
  const browser = await get('/browser/', { Accept: 'text/html' })
  assert.equal(browser.status, 303, 'unauthenticated /browser/ must go to login')
  assert.match(browser.headers.location ?? '', /_auth\/login/, 'browser redirect target')
  assert.equal((await get('/browser/api/tokens')).status, 404, 'Selkies token API must stay unrouted')
  pass('browser-route', '/browser/ requires login; /browser/api/tokens is not routed')
}

// 4. No CONNECT tunnel on either version. v3.7.15+ rejects it with 501 from the
//    entry point; earlier tags have no guard and the router answers 404. Assert
//    the documented 501 only where upstream implements it.
{
  const { status, statusLine } = await rawHttp1('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
  if (rejectsConnectWith501) {
    assert.equal(status, 501, `HTTP/1 CONNECT must be 501 from v3.7.15, got ${statusLine}`)
  } else {
    assert.ok(!/^HTTP\/1\.[01] 2\d\d/.test(statusLine), `HTTP/1 CONNECT must not tunnel: ${statusLine}`)
  }
  pass('http1-connect', `no CONNECT tunnel (${statusLine})${rejectsConnectWith501 ? '' : '; 501 only from v3.7.15'}`)
}

// 5. The same split applies to HTTP/2. Only an HTTP status response counts as
//    evidence; a transport error proves nothing, so it fails rather than passing.
{
  const observed = await new Promise((resolve, reject) => {
    const session = http2.connect(`https://127.0.0.1:${port}`, { ca, servername: hostname })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(Error('HTTP/2 CONNECT got no response within 10s')), 10_000)
    session.on('error', error => finish(Error(`HTTP/2 session error before a CONNECT response: ${error.code ?? error.message}`)))
    session.on('connect', () => {
      const stream = session.request({ ':method': 'CONNECT', ':authority': 'example.com:443' })
      stream.on('response', headers => finish(null, headers[':status']))
      stream.on('error', error => finish(Error(`CONNECT stream error before a response: ${error.code ?? error.message}`)))
      stream.end()
    })
  })
  if (rejectsConnectWith501) {
    assert.equal(observed, 501, `HTTP/2 CONNECT must be 501 from v3.7.15, observed ${observed}`)
  } else {
    assert.ok(observed >= 400, `HTTP/2 CONNECT must not establish a tunnel, observed ${observed}`)
  }
  pass('http2-connect', `no CONNECT tunnel (observed ${observed})${rejectsConnectWith501 ? '' : '; 501 only from v3.7.15'}`)
}

console.log(`EDGE ${version} OK: ${checked} checks`)
