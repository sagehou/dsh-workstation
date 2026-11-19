import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { chromium } from 'playwright'

const work = await mkdtemp(join(tmpdir(), 'm0-sidebar-'))
const env = { ...process.env, DSH_HOME: join(work, 'dsh'), DSH_TELEMETRY_DISABLED: '1' }
const project = join(work, 'workspace')
const bin = join(work, 'node_modules/.bin/dsh')
await mkdir(project)
await writeFile(join(work, 'package.json'), '{"private":true}')
execFileSync('pnpm', ['add', '--save-exact', '--ignore-scripts', '@deepseek-ai/dsh@0.2.2-rc.1'], { cwd: work, stdio: 'inherit' })
execFileSync(bin, ['plugin', '--profile', 'web', 'add', '--ignore-scripts', 'file:/m0/sidebar/fixture'],
  { cwd: project, env, stdio: 'inherit' })

// The pinned DeepSeek adapter speaks Messages SSE. Settle one real Session with a
// recorded-success fixture on loopback; no provider credentials or API calls.
const reply = 'M0 sidebar fixture ready'
const mock = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    res.writeHead(404).end()
    return
  }
  req.resume()
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of [
    { type: 'message_start', message: { id: 'm0', type: 'message', role: 'assistant', model: 'm0', content: [],
      usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const server = spawn(bin, ['web', '--no-open', '--port', '0'], {
  cwd: project,
  env: { ...env, DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, DEEPSEEK_API_KEY: 'm0-fixture-key' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = '', err = '', exited = false
const done = new Promise(resolve => server.once('exit', () => { exited = true; resolve() }))
server.stdout.on('data', chunk => { out = (out + chunk).slice(-65536) })
server.stderr.on('data', chunk => { err = (err + chunk).slice(-8192) })
let browser, page
const problems = []
const redact = value => String(value)
  .replace(/(?:https?|wss?):\/\/\S+/g, '[URL redacted]')
  .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[value redacted]')
try {
  let url
  const deadline = Date.now() + 90_000
  while (!(url = /^dsh web: (http:\/\/\S+)\r?$/m.exec(out)?.[1])) {
    assert(!exited && Date.now() < deadline, 'Web Profile did not start')
    await setTimeout(250)
  }
  browser = await chromium.launch({ args: ['--no-sandbox'] })
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1680, height: 950 } })
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => problems.push(redact(error.message)))
  page.on('console', message => {
    if (message.type() === 'error') problems.push(redact(message.text()))
  })
  let loads = 0
  await page.route('**/browser/', route => {
    ++loads
    return route.fulfill({
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' },
      body: '<!doctype html><html lang="en"><title>M0 frame</title><label>Marker <input></label></html>',
    })
  })
  assert.equal((await page.goto(url))?.status(), 200, 'authenticated Web UI did not load')
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  const addKey = page.getByRole('button', { name: 'Add API Key', exact: true })
  const addWorkspace = page.getByRole('button', { name: 'Add workspace', exact: true })
  const drawer = page.locator('[data-sidebar-toggle]').and(page.getByRole('button', { name: 'Open sidebar', exact: true }))
  await notice.or(addKey).or(addWorkspace).or(drawer).first().waitFor()
  if (await notice.isVisible()) await notice.click()
  await addKey.or(addWorkspace).or(drawer).first().waitFor()
  if (await addKey.isVisible()) {
    await addKey.click()
    await page.getByRole('button', { name: 'Configure later', exact: true }).click()
  }
  if (await drawer.isVisible()) await drawer.click()
  await addWorkspace.click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const path = dialog.getByRole('textbox', { name: 'Edit path' })
  await path.fill(project)
  await path.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.fill('Open the M0 Sidebar probe.')
  await composer.press('Enter')
  await page.getByText(reply, { exact: true }).and(page.locator('p')).waitFor()
  const expand = page.locator('[data-sidebar-right-expand]')
  const guideEntry = page.locator('[data-sidebar-right-guide-entry="m0-browser"]')
  if (!(await guideEntry.isVisible())) await expand.click()
  await guideEntry.click()
  console.log('npm DSH loaded the external client plugin through its Profile bundle')

  const iframe = page.locator('iframe[title="M0 lifecycle probe"]')
  const marker = page.frameLocator('iframe[title="M0 lifecycle probe"]').getByRole('textbox', { name: 'Marker' })
  const action = name => page.getByRole('button', { name: 'M0 ' + name, exact: true })
  const retained = async () => {
    await iframe.waitFor({ state: 'visible' })
    assert.equal(await marker.inputValue(), 'preserved')
    assert.equal(loads, 1)
  }
  await marker.fill('preserved')
  await action('Guide').click()
  await iframe.waitFor({ state: 'hidden' })
  assert.equal(await iframe.count(), 1)
  await page.locator('[data-dockkit-tab]').filter({ hasText: 'M0 Browser Desktop', visible: true }).click()
  await retained()
  await action('Hide').click()
  await expand.waitFor()
  assert.equal(await iframe.count(), 1)
  await expand.click()
  await retained()
  console.log('iframe retained across tab selection and docked hide/show')

  const floating = page.locator('[data-dockkit-float]').filter({ has: iframe })
  await action('Float').click()
  await floating.waitFor()
  await retained()
  const box = await floating.boundingBox()
  const handle = await floating.locator('[data-dockkit-float-resize]').boundingBox()
  assert(box && handle)
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + handle.height / 2 + 65, { steps: 8 })
  await page.mouse.up()
  await page.waitForFunction(({ width, height }) => {
    const node = document.querySelector('[data-dockkit-float]')
    const box = node?.getBoundingClientRect()
    return box && box.width > width + 30 && box.height > height + 30
  }, { width: box.width, height: box.height })
  assert.equal(await floating.locator('[data-sidebar-right-mode]').count(), 0)
  await floating.locator('[data-dockkit-float-dock]').click()
  await floating.waitFor({ state: 'detached' })
  await retained()
  console.log('iframe retained across native float, resize and dock')

  const fullscreen = page.locator('[data-sidebar-right-mode]').first()
  const mode = await fullscreen.getAttribute('data-sidebar-right-mode')
  await fullscreen.click()
  await retained()
  assert.notEqual(await fullscreen.getAttribute('data-sidebar-right-mode'), mode)
  await fullscreen.click()
  await retained()
  assert.equal(await fullscreen.getAttribute('data-sidebar-right-mode'), mode)
  console.log('iframe retained across docked fullscreen and restore')
  await action('Float').click()
  await floating.waitFor()
  await action('Hide').click()
  await iframe.waitFor({ state: 'detached' })
  console.log('upstream floating hide closes the tab; its iframe does not survive')
} catch (error) {
  console.error(redact(error))
  const locale = await page?.locator('html').getAttribute('lang', { timeout: 1000 }).catch(() => null)
  const visible = await page?.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  console.error('fixture page language:', locale, '; browser errors:', problems.slice(-4))
  if (visible) console.error('fixture page:', redact(visible).slice(0, 1600))
  console.error(redact(err))
  process.exitCode = 1
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  const force = globalThis.setTimeout(() => server.kill('SIGKILL'), 5000)
  await done
  clearTimeout(force)
  mock.close()
  await rm(work, { recursive: true, force: true })
}
