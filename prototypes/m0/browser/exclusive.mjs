import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { chromium as playwright } from 'playwright'

export async function verifySelkiesInput({ managed, origin, fixture, poll }) {
  const master = (await readFile('/run/secrets/m0_master', 'utf8')).trim()
  const controller = randomBytes(24).toString('hex')
  const sentinel = randomBytes(24).toString('hex')
  const adminURL = 'http://chromium:3000/browser/api/tokens'
  const provision = async locked => {
    const table = { [controller]: { role: 'controller', slot: null } }
    if (locked) table[sentinel] = { role: 'viewer', slot: null, mk_control: true }
    const response = await fetch(adminURL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + master, 'Content-Type': 'application/json' },
      body: JSON.stringify(table),
      signal: AbortSignal.timeout(2000),
    })
    await response.body?.cancel()
    assert(response.ok, `internal Selkies token endpoint returned HTTP ${response.status}`)
    return true
  }
  await poll('Selkies secure-mode control plane unavailable', () => provision(false))
  const target = await managed.newPage()
  await target.goto(fixture + '/agent')
  await target.bringToFront()
  await target.evaluate(() => {
    window.m0Input = { keys: 0, clicks: 0 }
    document.addEventListener('keydown', () => window.m0Input.keys++)
    document.addEventListener('mousedown', () => window.m0Input.clicks++)
  })

  const outer = await playwright.launch({ args: ['--no-sandbox'] })
  try {
    const user = await outer.newContext({ ignoreHTTPSErrors: true })
    assert.equal((await user.request.get(origin + '/__m0/bootstrap')).status(), 204)
    assert.equal((await user.request.post(origin + '/browser/api/tokens', { data: {} })).status(), 404)
    const page = await user.newPage()
    await page.goto(origin + '/agent')
    // Send protocol frames directly so any client UI input toggle is bypassed.
    await page.evaluate(protocol => {
      const ws = new WebSocket('wss://' + location.host + '/browser/api/websockets', ['selkies', protocol])
      ws.binaryType = 'arraybuffer'
      window.m0Wire = { ws, mk: null, video: 0 }
      ws.addEventListener('open', () => ws.send('SETTINGS,' + JSON.stringify({
        displayId: 'primary', tabId: 'm0-input-probe', encoder: 'jpeg',
        initialClientWidth: 1024, initialClientHeight: 768,
      })))
      ws.addEventListener('message', ({ data }) => {
        if (data === 'MK_ACCESS,1' || data === 'MK_ACCESS,0') window.m0Wire.mk = data.at(-1)
        if (data instanceof ArrayBuffer && [0x03, 0x04].includes(new Uint8Array(data)[0])) window.m0Wire.video++
      })
    }, 'selkies.token.' + Buffer.from(controller).toString('base64url'))
    const wire = () => page.evaluate(() => ({ mk: window.m0Wire.mk, video: window.m0Wire.video }))
    const send = () => page.evaluate(() => {
      const ws = window.m0Wire.ws
      for (const frame of ['kd,97', 'ku,97', 'm,300,250,0,0', 'm,300,250,1,0', 'm,300,250,0,0']) ws.send(frame)
    })
    const input = () => target.evaluate(() => window.m0Input)

    await poll('no controller video or input permission', async () => {
      const { mk, video } = await wire()
      return mk === '1' && video > 0
    })
    await send()
    await poll('positive control: keyboard and mouse did not reach Chromium', async () => {
      const { keys, clicks } = await input()
      return keys > 0 && clicks > 0
    }, 10_000)
    assert(await provision(true))
    const locked = await poll('existing Selkies socket did not receive the server denial', async () => {
      const state = await wire()
      return state.mk === '0' && state
    })
    const before = await input()
    await send()
    await target.evaluate(() => { document.body.style.backgroundColor = 'red' })
    await page.evaluate(() => window.m0Wire.ws.send('REQUEST_KEYFRAME'))
    await poll('no new video on the same socket after removing input authority', async () => {
      return (await wire()).video > locked.video
    }, 15_000)
    await setTimeout(600)
    assert.deepEqual(await input(), before)
    console.log('Selkies server denied raw keyboard and mouse frames while the same socket received new video')

    assert(await provision(false))
    await poll('Selkies controller authority did not return', async () => (await wire()).mk === '1')
    await send()
    await poll('positive control: restored keyboard and mouse did not reach Chromium', async () => {
      const { keys, clicks } = await input()
      return keys > before.keys && clicks > before.clicks
    }, 10_000)
    console.log('restoring the token table re-enabled keyboard and mouse on the existing socket')
  } finally {
    await outer.close()
  }
}
