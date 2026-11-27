import { spawn } from 'node:child_process'
import { access, rename, rm, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { createInterface } from 'node:readline'

const [mode, bin] = process.argv.slice(2)
const launchFile = '/run/dsh-runtime/launch-url'
const bind = process.env.DSH_BIND_IP
const port = Number(process.env.DSH_BIND_PORT ?? 3080)
const args = ['web', '--no-open']
const tls = process.env.WORKSTATION_INTERNAL_TLS === '1'

class StartupError extends Error {}

function listener() {
  if (!isIPv4(bind ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new StartupError('set DSH_BIND_IP to the concrete container IPv4 address and use a valid DSH_BIND_PORT')
  }
  return new URL((tls ? 'https://' : 'http://') + bind + ':' + port + '/')
}

async function readyPage(launch, target) {
  const authURL = new URL(launch)
  const root = target ?? new URL('/', launch)
  authURL.hostname = root.hostname
  authURL.port = root.port
  authURL.protocol = root.protocol
  const request = { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { host: launch.host } }
  const exchange = await fetch(authURL, request).catch(() => {
    throw new StartupError('could not reach the Web listener for the token exchange')
  })
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  await exchange.body?.cancel()
  if (!cookie || exchange.status < 300 || exchange.status >= 400) throw new StartupError(`token exchange refused (HTTP ${exchange.status})`)
  const page = await fetch(root, { ...request, signal: AbortSignal.timeout(8000), headers: { ...request.headers, cookie } }).catch(() => {
    throw new StartupError('could not read the authenticated Web page')
  })
  if (page.status !== 200 || !(await page.text()).includes('__DSH_BOOT__')) throw new StartupError(`authenticated Web page did not boot (HTTP ${page.status})`)
}

async function run() {
  if (mode === 'health') {
    await access(launchFile)
    const response = await fetch(listener(), { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    await response.body?.cancel()
    if (response.status !== 401) throw new StartupError('Web listener did not return the expected authentication challenge')
    return
  }
  if (!bin || !['probe', 'serve'].includes(mode)) throw new StartupError('invalid Web launcher mode')
  let publicRoot, target
  if (mode === 'serve') {
    target = listener()
    publicRoot = new URL(process.env.DSH_PUBLIC_ORIGIN)
    if (!['http:', 'https:'].includes(publicRoot.protocol) || publicRoot.pathname !== '/' ||
      publicRoot.username || publicRoot.password || publicRoot.search || publicRoot.hash) {
      throw new StartupError('DSH_PUBLIC_ORIGIN must be an HTTP(S) origin')
    }
    await rm(launchFile, { force: true })
    if (tls) args.push('--tls-cert', '/run/secrets/runtime_cert', '--tls-key', '/run/secrets/runtime_key')
    args.push('--host', bind, '--port', String(port), '--public-url', publicRoot.href, '--trusted-host', publicRoot.host)
  } else {
    args.push('--port', '0')
  }

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let finish, announce, expired, incompatible = false, stopping = false, timer, force
  const closed = new Promise(resolve => { finish = resolve })
  const announcement = new Promise(resolve => { announce = resolve })
  const timeout = new Promise(resolve => { expired = resolve })
  child.once('error', () => finish('could not start the DSH executable'))
  child.once('close', code => finish(code ?? 1))
  const stop = () => {
    stopping = true
    child.kill('SIGTERM')
    force ??= setTimeout(() => child.kill('SIGKILL'), 5000)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  const output = createInterface({ input: child.stdout })
  output.on('line', line => {
    const url = /^dsh web: (https?:\/\/\S+)$/.exec(line)
    if (url) announce(url[1])
  })
  const errors = createInterface({ input: child.stderr })
  errors.on('line', line => {
    if (/skipping profile bundle|is incompatible with dsh|\b(?:entry|entries) did not activate\b/i.test(line)) incompatible = true
    if (process.env.WORKSTATION_MCP_DIAGNOSTICS === '1' &&
      /^Workstation MCP: (?:skipped|ready|missing|(?:config|plugin) (?:http-denied|schema|duplicate|unknown))$/.test(line)) {
      console.error(line)
    }
  })
  timer = setTimeout(() => expired(null), 90_000)
  try {
    const text = await Promise.race([announcement, timeout, closed.then(code => {
      if (typeof code === 'string') throw new StartupError(code)
      throw new StartupError(`DSH exited before Web readiness (exit ${code})`)
    })])
    if (!text) throw new StartupError('timed out waiting for the DSH Web listener')
    const url = new URL(text)
    if ((publicRoot && url.origin !== publicRoot.origin) ||
      (!publicRoot && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'))) {
      throw new StartupError('DSH announced an unexpected Web address')
    }
    await readyPage(url, target)
    if (incompatible && (mode === 'probe' || process.argv[4] === '--require-profile')) {
      throw new StartupError('DSH skipped an incompatible or inactive Profile entry')
    }
    console.log('Authenticated DSH Web boot ready')
    if (mode === 'serve') {
      await writeFile(launchFile + '.new', text + '\n', { mode: 0o600 })
      await rename(launchFile + '.new', launchFile)
      process.send?.('ready')
      const code = await closed
      process.exitCode = stopping ? 0 : code
    }
  } finally {
    clearTimeout(timer)
    stop()
    await closed
    clearTimeout(force)
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    if (mode === 'serve') {
      await rm(launchFile, { force: true })
      await rm(launchFile + '.new', { force: true })
    }
  }
}

try {
  await run()
} catch (error) {
  // The launch URL and DSH's own startup output may contain credentials.
  const reason = error instanceof StartupError ? error.message : 'check the selected version, Profile and listener configuration'
  console.error('DSH Web startup: ' + reason)
  process.exitCode = 1
}
