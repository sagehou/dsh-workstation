import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const base = 'http://127.0.0.1:3080'
const compose = (...args) => execFileSync('docker', ['compose', '-f', 'compose.preview.yml', ...args], { encoding: 'utf8' }).trim()
const request = (url, headers) => fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(5000) })

try {
  assert.equal(compose('port', 'edge', '8080'), '127.0.0.1:3080', 'entrypoint must publish only to host loopback')
  const unauthenticated = await request(base)
  assert.equal(unauthenticated.status, 401, 'DSH did not challenge a request before bootstrap')
  await unauthenticated.body?.cancel()

  const launch = new URL(compose('exec', '-T', 'runtime', 'dsh-runtime', 'launch-url'))
  assert.equal(launch.origin, base, 'wrong DSH advertised origin')
  const response = await request(launch)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  await response.body?.cancel()
  assert(cookie, 'launch URL must set the browser session cookie')
  const boot = await request(base, { cookie })
  assert.equal(boot.status, 200, 'authenticated request did not boot through the edge')
  assert((await boot.text()).includes('__DSH_BOOT__'), 'response was not the official DSH Web boot page')

  const deadline = Date.now() + 90_000
  for (;;) {
    const browser = await request(base + '/browser/').catch(() => null)
    const available = browser?.status === 200 && browser.headers.get('content-type')?.includes('text/html')
    await browser?.body?.cancel()
    if (available) {
      assert.equal(browser.headers.get('content-security-policy'), "frame-ancestors 'self'")
      break
    }
    assert(Date.now() < deadline, 'Selkies did not serve HTML at the same origin')
    await delay(1500)
  }
  console.log('Preview: loopback only, authenticated DSH Web and same-origin /browser/ respond through Traefik')
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : 'Preview startup request failed')
  process.exitCode = 1
}
