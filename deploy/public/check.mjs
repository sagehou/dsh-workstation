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
    const stolen = await context.cookies()
    assert.equal(await page.locator('form[action="/_auth/sessions/revoke-all"]').count(), 1)
    await page.getByRole('button', { name: '退出所有会话' }).click()
    await page.waitForURL('**/_auth/login')
    const revoked = await browser.newContext()
    await revoked.addCookies(stolen)
    assert.equal((await revoked.request.get(root + '/api/remote.mux')).status(), 401)
    await revoked.close()
    await page.goto(root + '/_auth/login?next=%2F_auth%2Faccount')
    await page.getByRole('button', { name: '用 Passkey 登录' }).click()
    await page.waitForURL('**/_auth/account')
    assert.equal(await page.getByRole('button', { name: '移除此 Passkey' }).count(), 1)
    console.log('Recreated Auth: saved session survived; revoke-all denied the prior cookie; restored passkey completed a separate login')
  } else if (phase === 'gateway') {
    await page.goto(root + '/')
    await page.waitForURL('**/_auth/login?*')
    await page.getByLabel('用户名').fill('operator')
    await page.getByLabel('密码', { exact: true }).fill(password())
    await page.getByRole('button', { name: '验证密码' }).click()
    await page.waitForURL('**/_auth/totp?*')
    assert.equal(await page.locator('[name=password]').count(), 0)
    assert.ok(!(await context.cookies()).some(c => c.name === '__Host-dsh_session'))
    await page.getByLabel('动态验证码').fill(code())
    await page.getByRole('button', { name: '登录', exact: true }).click()
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
    let frames = 0
    desktop.on('websocket', ws => {
      if (new URL(ws.url()).pathname === '/browser/api/websockets') ws.on('framereceived', () => frames++)
    })
    const response = await desktop.goto(root + '/_auth/browser')
    assert.ok(response?.ok(), 'Selkies page failed')
    assert.equal(new URL(desktop.url()).pathname, '/browser/')
    assert.ok(new URL(desktop.url()).hash.startsWith('#token='))
    await until('Selkies data frames on the authenticated WebSocket', () => frames >= 3, 40_000)
    console.log('Same origin: authenticated /browser/ receives Selkies WebSocket data frames')
    await desktop.close()

    async function rpc(endpoint, request) {
      const id = randomUUID()
      const response = await context.request.post(root + '/api/' + endpoint, {
        headers: { Origin: root, 'Sec-Fetch-Site': 'same-origin' },
        data: { type: 'client-request', rpcId: id, method: endpoint, payload: { args: { request } } },
      })
      assert.equal(response.status(), 200, endpoint + ' transport')
      const result = await response.json()
      if (!result.result?.ok) throw Error(endpoint + ' rejected: ' + (result.result?.error?.code ?? 'bad envelope'))
      return result.result.value
    }
    async function send(sessionId, label, operation, args = {}) {
      await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: 'compose-ci ' + JSON.stringify({ label, operation, args }) }] })
      return until(label + ' result', async () => {
        const result = await rpc('session/page', { address: { kind: 'session', sessionId }, maxMessages: 20 })
        const match = JSON.stringify(result).match(new RegExp('CI_RESULT_' + label + '=([A-Za-z0-9_:-]+)'))
        return match?.[1]
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
    assert.equal(await send(first, 'blocked', 'navigate', { generation, url: 'http://172.30.231.2:9223/json/version' }), 'ORIGIN_NOT_ALLOWED')
    assert.equal(await send(first, 'open1', 'navigate', { generation, url: 'https://fixture.test/alpha' }), 'OK')
    assert.equal(await send(first, 'read1', 'read', { generation }), 'WTAB_ALPHA')
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
} finally {
  await browser.close()
}
