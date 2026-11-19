import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const [bin, mode] = process.argv.slice(2)
const dir = await mkdtemp(join(tmpdir(), 'dsh-m0-health-'))
const marker = join(dir, 'mounted')
const args = ['web', '--no-open', '--port', '0']
// The exact DSH releases reject wildcard binds; exercise the real startup failure path.
if (mode === 'fail-readiness') args.push('--host', '0.0.0.0')
const child = spawn(bin, args, {
  env: { ...process.env, M0_MOUNT_LOG: marker },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '', stderr = '', exited = false
const done = new Promise(resolve => {
  child.once('error', () => { exited = true; resolve() })
  child.once('exit', () => { exited = true; resolve() })
})
child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536) })
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
try {
  const deadline = Date.now() + 90_000
  let url
  while (!(url = /^dsh web: (http:\/\/\S+)\r?$/m.exec(stdout)?.[1])) {
    assert(!exited && Date.now() < deadline, 'DSH exited or did not advertise Web readiness')
    await setTimeout(250)
  }
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
  const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
  assert(cookie, 'Startup URL did not set a cookie')
  const page = await fetch(new URL('/', url), { headers: { cookie }, signal: AbortSignal.timeout(8000) })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /__DSH_BOOT__/)
  if (mode === 'plugin') assert.equal(await readFile(marker, 'utf8'), 'mounted\n')
  console.log(`authenticated Web boot OK; Git bundle apply: ${mode === 'plugin' ? 'observed' : 'not requested'}`)
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : error.code ?? error.name)
  console.error(stderr.replace(/https?:\/\/\S+/g, '[URL redacted]'))
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
  const force = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000)
  await done
  clearTimeout(force)
  await rm(dir, { recursive: true, force: true })
}
