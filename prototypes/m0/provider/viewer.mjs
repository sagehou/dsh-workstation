import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright'

const [controller, admin] = await Promise.all(
  ['m0_controller', 'm0_admin'].map(name => readFile('/run/secrets/' + name, 'utf8')),
)
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await context.newPage()
const origin = 'https://m0.test'
const protocol = 'selkies.token.' + Buffer.from(controller).toString('base64url')
const input = createInterface({ input: process.stdin })

async function command(method, args) {
  switch (method) {
    case 'connect': {
      const auth = await context.request.get(origin + '/__m0/bootstrap', { timeout: 4000 })
      if (auth.status() !== 204) throw Error('fixture auth unavailable')
      const adminOutside = await context.request.post(origin + '/browser/api/tokens', { data: {}, timeout: 4000 })
      if (adminOutside.status() !== 404) throw Error('Selkies control endpoint exposed')
      await page.goto(origin + '/agent', { timeout: 4000 })
      await page.evaluate(token => {
        const ws = new WebSocket('wss://' + location.host + '/browser/api/websockets', ['selkies', token])
        ws.binaryType = 'arraybuffer'
        window.m0Wire = { ws, mk: null, video: 0 }
        ws.addEventListener('open', () => ws.send('SETTINGS,' + JSON.stringify({
          displayId: 'primary', tabId: 'm0-provider', encoder: 'jpeg',
          initialClientWidth: 1024, initialClientHeight: 768,
        })))
        ws.addEventListener('message', ({ data }) => {
          if (data === 'MK_ACCESS,1' || data === 'MK_ACCESS,0') window.m0Wire.mk = data.at(-1)
          if (data instanceof ArrayBuffer && [0x03, 0x04].includes(new Uint8Array(data)[0])) window.m0Wire.video++
        })
      }, protocol)
      return true
    }
    case 'wire': return page.evaluate(() => {
      const { ws, mk, video } = window.m0Wire
      return { mk, video, ready: ws.readyState }
    })
    case 'send': return page.evaluate(frames => {
      for (const frame of frames) window.m0Wire.ws.send(frame)
      return true
    }, args)
    case 'observe': return (await fetch('http://witness:8081/observe', { signal: AbortSignal.timeout(3000) })).json()
    case 'release': {
      const result = await fetch('http://witness:8081/release/' + args, { method: 'POST', signal: AbortSignal.timeout(3000) })
      return result.status
    }
    case 'control': {
      const { path, body } = args
      const response = await fetch('http://172.30.233.2:8081' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(50_000),
      })
      return { status: response.status, data: await response.json() }
    }
    default: throw Error('unknown viewer command')
  }
}

// Allow a takeover request to remain pending while the witness releases the browser barrier.
input.on('line', line => {
  const { id, method, params } = JSON.parse(line)
  command(method, params).then(
    result => process.stdout.write(JSON.stringify({ id, result }) + '\n'),
    () => process.stdout.write(JSON.stringify({ id, error: { message: 'viewer ' + method + ' failed' } }) + '\n'),
  )
})
input.on('close', () => { void browser.close() })
