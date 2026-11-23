import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { code, password } from './otp.mjs'

const root = 'https://workstation.test'
const browser = await chromium.launch({ args: ['--ignore-certificate-errors-spki-list=' + process.env.CI_EDGE_SPKI] })
const phase = process.argv[2]
const restore = phase === 'restore'
const context = await browser.newContext(phase !== 'gateway' ? { storageState: '/ci-state/browser.json' } : {})
const wait = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))
async function until(description, attempt, ms = 28_000) {
  const limit = Date.now() + ms
  while (Date.now() < limit) {
    const result = await attempt()
    if (result) return result
    await wait()
  }
  throw Error('Timed out: ' + description)
}

async function submit(page, label, path, status = 303) {
  const result = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST')
  await page.getByRole('button', { name: label, exact: true }).click()
  const response = await result
  const origin = await response.request().headerValue('origin')
  assert.equal(response.status(), status, path + ' (Origin: ' + (origin === root ? 'same origin' : origin ? 'other' : 'missing') + ')')
}

try {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true },
  })
  if (restore) {
    const credential = JSON.parse(await readFile('/ci-state/passkey.json', 'utf8'))
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential })
    await page.goto(root + '/_auth/account')
    await page.getByRole('heading', { name: '账户', exact: true }).waitFor()
    const dshPage = await context.newPage()
    await dshPage.goto(root + '/')
    await dshPage.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://' + location.host + '/api/remote.mux')
      window.ciGatewaySocket = socket
      socket.onopen = resolve
      socket.onerror = () => reject(Error('DSH WebSocket was not admitted'))
    }))
    const desktop = await context.newPage()
    let browserSocket, received = false
    desktop.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/browser/api/websockets') return
      socket.on('framereceived', () => {
        if (!browserSocket) browserSocket = socket
        received = true
      })
    })
    await desktop.goto(root + '/_auth/browser')
    await until('restored login admitted Selkies stream', () => received && !browserSocket.isClosed(), 40_000)
    const stolen = await context.cookies()
    assert.equal(await page.locator('form[action="/_auth/sessions/revoke-all"]').count(), 1)
    await page.getByRole('button', { name: '退出所有会话' }).click()
    await page.waitForURL('**/_auth/login')
    await until('revocation closed the established DSH WebSocket',
      () => dshPage.evaluate(() => window.ciGatewaySocket.readyState === WebSocket.CLOSED), 8000)
    await until('revocation closed the established Selkies WebSocket', () => browserSocket.isClosed(), 8000)
    await desktop.close()
    await dshPage.close()
    const revoked = await browser.newContext()
    await revoked.addCookies(stolen)
    assert.equal((await revoked.request.get(root + '/api/remote.mux')).status(), 401)
    await revoked.close()
    await page.goto(root + '/_auth/login?next=%2F_auth%2Faccount')
    await page.getByRole('button', { name: '用 Passkey 登录' }).click()
    await page.waitForURL('**/_auth/account')
    assert.equal(await page.getByRole('button', { name: '移除此 Passkey' }).count(), 1)
    await page.goto(root + '/_auth/login?next=%2F_auth%2Faccount')
    await page.getByLabel('用户名').fill('operator')
    await page.getByLabel('密码', { exact: true }).fill(password())
    await submit(page, '验证密码', '/_auth/password')
    await page.getByLabel('动态验证码').fill(code(1))
    await submit(page, '登录', '/_auth/totp')
    await page.waitForURL('**/_auth/account')
    await context.storageState({ path: '/ci-state/browser.json' })
    console.log('Auth backup restored to a fresh volume: session persisted; revoke-all closed DSH and Selkies sockets; Passkey and password/TOTP logins both passed')
  } else if (phase === 'gateway') {
    await page.goto(root + '/')
    await page.waitForURL('**/_auth/login?*')
    await page.getByLabel('用户名').fill('operator')
    await page.getByLabel('密码', { exact: true }).fill(password())
    await submit(page, '验证密码', '/_auth/password')
    await page.waitForURL('**/_auth/totp?*')
    assert.equal(await page.locator('[name=password]').count(), 0)
    assert.ok(!(await context.cookies()).some(c => c.name === '__Host-dsh_session'))
    await page.getByLabel('动态验证码').fill(code())
    await submit(page, '登录', '/_auth/totp')
    await page.waitForURL(root + '/')
    const cookies = await context.cookies()
    for (const name of ['__Host-dsh_session', 'dsh-auth-']) {
      const c = cookies.find(cookie => cookie.name.startsWith(name))
      assert.ok(c?.secure && c?.httpOnly && c?.path === '/', 'expected both Secure, HttpOnly cookies')
    }
    assert.equal(new URL(page.url()).search, '', 'DSH launch token appeared in the browser URL')
    const sessionDoc = await context.request.get(root + '/')
    assert.ok((await sessionDoc.text()).includes('__DSH_BOOT__'))
    console.log('HTTPS: separate password and TOTP screens; both Secure cookies; official DSH boots with no launch token in the browser URL')

    await page.goto(root + '/_auth/account')
    await page.getByRole('button', { name: '添加 Passkey' }).click()
    await page.getByRole('button', { name: '移除此 Passkey' }).waitFor()
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
    assert.equal(credentials.length, 1)
    await writeFile('/ci-state/passkey.json', JSON.stringify(credentials[0]), { mode: 0o600 })
    await context.storageState({ path: '/ci-state/browser.json' })
    console.log('WebAuthn: native browser registration with a resident, user-verified credential')
  }

  if (phase === 'browser') {
    const desktop = await context.newPage()
    let video = false
    desktop.on('websocket', ws => {
      if (new URL(ws.url()).pathname !== '/browser/api/websockets') return
      ws.on('framereceived', ({ payload }) => {
        if (Buffer.isBuffer(payload) && [0x03, 0x04].includes(payload[0])) video = true
      })
    })
    const response = await desktop.goto(root + '/_auth/browser')
    assert.ok(response?.ok(), 'Selkies page failed')
    assert.equal(new URL(desktop.url()).pathname, '/browser/')
    assert.ok(new URL(desktop.url()).hash.startsWith('#token='))
    const frame = response.headers()
    assert.match(frame['content-security-policy'] ?? '', /frame-ancestors 'self'/, 'browser CSP from the edge')
    assert.equal(frame['x-frame-options'], 'SAMEORIGIN', 'browser X-Frame-Options from the edge')
    await until('Selkies video on the authenticated WebSocket', () => video, 40_000)
    console.log('Same origin: authenticated /browser/ receives Selkies WebSocket video with a same-origin frame policy')
    await desktop.close()

    async function rpc(endpoint, request) {
      const id = randomUUID()
      const response = await context.request.post(root + '/api/' + endpoint, {
        headers: { Origin: root, 'Sec-Fetch-Site': 'same-origin' },
        data: { type: 'client-request', rpcId: id, method: endpoint, payload: { args: { request } } },
      })
      assert.equal(response.status(), 200, endpoint + ' transport')
      const result = await response.json()
      if (!result.result?.ok) {
        const error = result.result?.error
        const detail = String(error?.message ?? '').replace(/https?:\/\/[^\s"']+/gi, '[url]').slice(0, 220)
        throw Error(endpoint + ' rejected: ' + (error?.code ?? 'bad envelope') + ' ' + detail)
      }
      return result.result.value
    }
    async function send(sessionId, label, operation, args = {}) {
      await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: 'compose-ci ' + JSON.stringify({ label, operation, args }) }] })
      return until(label + ' result', async () => {
        const result = await rpc('session/page', { address: { kind: 'session', sessionId }, maxMessages: 20 })
        const match = JSON.stringify(result).match(new RegExp('CI_RESULT_' + label + '=([A-Za-z0-9_:-]+)'))
        if (!match) return
        const value = match[1]
        console.log('DSH MCP ' + label + ': ' + (/^[a-f0-9-]{36}:\d+$/.test(value) ? 'GENERATION' : value))
        return value
      })
    }
    const control = await context.newPage()
    async function action(name, session) {
      await control.goto(root + '/_auth/control')
      if (session) {
        await control.locator('select[name=peer]').selectOption({ label: session })
      }
      await control.getByRole('button', { name, exact: true }).click()
      assert.equal(new URL(control.url()).search, '', 'Provider refused operator action')
    }
    const first = (await rpc('session/create', { cwd: '/workspace' })).sessionId
    const second = (await rpc('session/create', { cwd: '/workspace' })).sessionId
    assert.ok(first && second && first !== second)
    assert.equal(await send(first, 'before', 'lease_status'), 'NO_LEASE')
    assert.equal(await send(second, 'before2', 'lease_status'), 'NO_LEASE')
    await action('将标签页交给 Agent', first)
    const generation = await send(first, 'lease1', 'lease_status')
    assert.match(generation, /^[a-f0-9-]{36}:\d+$/)
    assert.equal(await send(second, 'other', 'navigate', { generation, url: 'https://fixture.test/beta' }), 'NOT_OWNER')
    assert.equal(await send(first, 'blocked', 'navigate', { generation, url: 'http://127.0.0.1:9223/json/version' }), 'ORIGIN_NOT_ALLOWED')
    assert.equal(await send(first, 'open1', 'navigate', { generation, url: 'https://fixture.test/alpha' }), 'OK')
    assert.equal(await send(first, 'read1', 'read', { generation }), 'WTAB_ALPHA')

    // #4 on the real Selkies instance: a human presses and holds a pointer
    // button on the live desktop, then hands the tab to the Agent.
    //
    // The desk below is the operator's own Selkies session reached through the
    // input gate, authorised by the real token table. The press is a real
    // protocol frame on that socket, and the witness is the page the desktop is
    // actually driving -- the Agent's own tab. So `mousedown` and `mouseup` are
    // what Chromium received, not what the gate or the page claimed.
    await action('接管浏览器')
    const heldRedirect = await context.request.get(root + '/_auth/browser', { maxRedirects: 0 })
    assert.equal(heldRedirect.status(), 303, 'the desk entry point did not redirect')
    const heldToken = decodeURIComponent((heldRedirect.headers().location ?? '').split('#token=')[1] ?? '')
    assert.match(heldToken, /^[0-9a-f]{32,}$/, 'the desk entry point carried no session token')
    const desk = await context.newPage()
    // An authenticated same-origin document with no WebSocket of its own, so the
    // socket below is the only one and does not fight the page's own session.
    await desk.goto(root + '/_auth/account')
    // Selkies takes the token from the `selkies.token.<base64url>` subprotocol
    // (stream_server.py:1321-1346), which is what the real page offers.
    const heldProtocol = 'selkies.token.' + Buffer.from(heldToken, 'utf8').toString('base64url')
    await desk.evaluate(protocol => {
      // Speak the data protocol directly, which is how the page drives the
      // desktop and what makes a client-side toggle irrelevant here.
      const ws = new WebSocket('wss://' + location.host + '/browser/api/websockets', ['selkies', protocol])
      window.ciDesk = { ws, mk: null }
      ws.addEventListener('open', () => ws.send('SETTINGS,' + JSON.stringify({
        displayId: 'primary', tabId: 'ci-hold', encoder: 'jpeg',
        initialClientWidth: 1024, initialClientHeight: 768,
      })))
      ws.addEventListener('message', ({ data }) => {
        if (data === 'MK_ACCESS,1' || data === 'MK_ACCESS,0') window.ciDesk.mk = data.at(-1)
      })
    }, heldProtocol)
    await until('the desk socket to be granted input authority', async () =>
      desk.evaluate(() => window.ciDesk.mk === '1'), 30_000)
    // Press and hold, and leave it down: this is the state M0 recorded
    // surviving the whole Agent lease. The motion first is what M0's own pulse
    // does; Selkies needs a pointer position before it will act on a button.
    await desk.evaluate(() => window.ciDesk.ws.send('m,320,240,0,0'))
    await wait(300)
    await desk.evaluate(() => window.ciDesk.ws.send('m,320,240,1,0'))
    await wait(700)

    // Hand the tab over while the button is still down. The Provider refuses
    // the lease when its handover fails, so reaching AGENT here already means
    // the gate proved a release on this socket.
    await action('将标签页交给 Agent', first)
    const heldGeneration = await send(first, 'lease-held', 'lease_status')
    assert.match(heldGeneration, /^[a-f0-9-]{36}:\d+$/,
      'the grant was refused over a socket holding a button, so no release was proven')
    const held = await send(first, 'hold-witness', 'read', { generation: heldGeneration })
    const counts = /HOLD:(\d+):(\d+)/.exec(held ?? '')
    assert.ok(counts, 'the held-input witness was not readable: ' + held)
    const downs = Number(counts[1])
    const ups = Number(counts[2])
    // Positive control: without a press that actually landed, "released" would
    // prove nothing at all.
    assert.ok(downs >= 1, 'the press never reached the Agent tab, so this proves nothing: ' + held)
    assert.ok(ups >= downs, 'the desktop was left mid-press by the handover: ' + held)
    console.log('Held pointer: a button pressed and held on the real desktop was released at the Selkies boundary before the Agent took the tab')
    await desk.close()
    await action('接管浏览器')
    await action('将标签页交给 Agent', second)
    const other = await send(second, 'lease2', 'lease_status')
    assert.notEqual(other, generation)
    assert.equal(await send(second, 'stale', 'navigate', { generation, url: 'https://fixture.test/alpha' }), 'STALE_GENERATION')
    assert.equal(await send(second, 'open2', 'navigate', { generation: other, url: 'https://fixture.test/beta' }), 'OK')
    assert.equal(await send(second, 'read2', 'read', { generation: other }), 'WTAB_BETA')
    await action('接管浏览器')
    await control.goto(root + '/_auth/control')
    await control.locator('select[name=peer]').selectOption({ label: first + ' · 已绑定' })
    await control.getByRole('button', { name: '将标签页交给 Agent' }).click()
    const again = await send(first, 'lease3', 'lease_status')
    assert.equal(await send(first, 'readagain', 'read', { generation: again }), 'WTAB_ALPHA')
    await action('接管浏览器')
    console.log('Official Web RPC + MCP: two live sessions, two tabs, cross-session and stale-generation calls rejected, first tab retained')
  }
} catch (error) {
  // Playwright's request call log can contain Cookie or Authorization headers.
  const message = String(error?.message).split('\n', 1)[0]
  console.error(phase + ': ' + message.replace(/([?#]token=)[^\s"']+/gi, '$1[redacted]'))
  process.exitCode = 1
} finally {
  await browser.close()
}
