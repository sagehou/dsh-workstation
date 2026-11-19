import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { chromium as playwright } from 'playwright'

const origin = 'https://m0.test'
const browserURL = origin + '/browser/'
const fixture = 'http://fixture:8080'
const cdp = 'http://172.30.231.2:9223'

async function poll(label, fn, ms = 60_000) {
  const deadline = Date.now() + ms
  let last
  do {
    try {
      const result = await fn()
      if (result) return result
    } catch (error) { last = error }
    await setTimeout(300)
  } while (Date.now() < deadline)
  throw new Error(label, { cause: last })
}

async function discovery(path) {
  const r = await fetch(cdp + path, { signal: AbortSignal.timeout(2000) })
  assert.equal(r.status, 200)
  return r.json()
}

const version = await poll('CDP did not answer from peer container', () => discovery('/json/version'))
assert.match(version.Browser, /Chrome\/156\.0\.8078\.79/)
assert.match(version.webSocketDebuggerUrl, /^ws:\/\/172\.30\.231\.2:9223\/devtools\/browser\//)
console.log(`private peer CDP: ${version.Browser}; protocol ${version['Protocol-Version']}`)

const desktop = await playwright.connectOverCDP(cdp)
try {
  assert.equal(desktop.contexts().length, 1)
  const managed = desktop.contexts()[0]
  if (process.argv.includes('--after-restart')) {
    assert((await managed.cookies(fixture)).some(c => c.name === 'm0_profile' && c.value === 'human'))
    console.log('persistent cookie still present in the default context after Chromium restart')
  } else {
    const outer = await playwright.launch({ args: ['--no-sandbox'] })
    try {
      const user = await outer.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1350, height: 850 } })
      assert.equal((await user.request.get(origin + '/')).status(), 401)
      assert.equal((await user.request.get(browserURL + 'api/status')).status(), 401)
      assert.equal((await user.request.get(origin + '/__m0/bootstrap')).status(), 204)
      const headers = (await poll('Selkies HTTP did not answer behind Traefik', async () => {
        const r = await user.request.get(browserURL, { timeout: 2000 })
        return r.ok() && r.headers()
      }))
      assert.equal(headers['content-security-policy'], "frame-ancestors 'self'")
      assert.equal(headers['x-frame-options'], 'SAMEORIGIN')

      const page = await user.newPage()
      await page.goto(origin + '/')
      const inner = page.frameLocator('iframe[title="Selkies"]')
      const overlay = inner.locator('#overlayInput')
      await overlay.waitFor({ state: 'visible', timeout: 90_000 })
      const frame = page.frames().find(item => item.url() === browserURL)
      assert(frame && await frame.evaluate(() => isSecureContext))
      await poll('no Selkies session on the WebSocket route', async () => {
        const response = await user.request.get(browserURL + 'api/sessions', { timeout: 2000 })
        assert(response.ok())
        const { sessions } = await response.json()
        return sessions.some(session => session.transport === 'websockets')
      })
      console.log('same-origin HTTPS iframe and WebSocket reached Selkies through the unchanged /browser/ prefix')

      await overlay.focus()
      await page.keyboard.press('Control+t')
      await page.keyboard.press('Control+l')
      await page.keyboard.type(fixture + '/human')
      await page.keyboard.press('Enter')
      await poll('Selkies keyboard navigation did not reach the managed Chromium', async () => {
        return (await discovery('/json/list')).some(t => t.type === 'page' && t.url === fixture + '/human')
      }, 20_000)
      assert((await managed.cookies(fixture)).some(c => c.name === 'm0_profile' && c.value === 'human'))
      console.log('human-side Selkies keyboard opened a tab visible in CDP and set a cookie in the default context')

      const agent = await managed.newPage()
      await agent.goto(fixture + '/agent')
      await agent.bringToFront()
      assert((await agent.context().cookies(fixture)).some(c => c.name === 'm0_profile' && c.value === 'human'))
      await overlay.focus()
      await page.keyboard.type('selkies')
      await poll('Selkies input did not land in the agent-created visible tab', async () => {
        return await agent.getByRole('textbox', { name: 'Agent page marker' }).inputValue() === 'selkies'
      }, 12_000)
      console.log('agent-created tab accepted Selkies input and shared the human-set cookie')

      assert.equal((await user.request.get('https://foreign.test/__m0/bootstrap')).status(), 204)
      const foreign = await user.newPage()
      const blocked = poll('cross-origin iframe was not blocked by frame-ancestors', () => {
        return foreign.frames().some(item => item.url() === 'chrome-error://chromewebdata/')
      }, 10_000)
      await foreign.goto('https://foreign.test/')
      await blocked
      console.log('cross-origin iframe navigated to Chromium error document under enforced frame-ancestors')
    } finally {
      await outer.close()
    }
  }
} finally {
  await desktop.close()
}
