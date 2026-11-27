// This private listener stays up while the supervised DSH Web process restarts.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_ID, VERSION, manageWeb } from './managed-web.mjs'

const ADDR = process.env.MAINTENANCE_ADDR ?? '127.0.0.1:8099'
const SECRET_FILE = process.env.MAINTENANCE_SECRET ?? '/run/secrets/maintenance'
const RUNTIME = '/usr/local/bin/dsh-runtime'
const TIMEOUT_MS = Number(process.env.MAINTENANCE_TIMEOUT_MS ?? 600_000)

let secret = ''
try {
  secret = readFileSync(SECRET_FILE, 'utf8').trim()
} catch {
  console.error('maintenance: no secret at ' + SECRET_FILE + '; refusing to serve')
}

const equal = (a, b) => {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function respond (res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function argvFor (action, args) {
  switch (action) {
    case 'verify': {
      const id = String(args?.id ?? '')
      if (!BACKUP_ID.test(id)) throw Error('invalid backup id')
      return ['check', id]
    }
    case 'components':
    case 'versions':
    case 'backup': return [action]
    default: throw Error('unknown action')
  }
}

const commands = new Set()

function run (argv, supervised = false) {
  return new Promise(resolve => {
    const stdio = ['ignore', 'pipe', 'pipe']
    if (supervised) stdio[8] = 8
    const env = supervised ? { ...process.env, DSH_RUNTIME_MANAGED_UPGRADE: '1' } : process.env
    const child = spawn(RUNTIME, argv, { stdio, env, detached: true })
    let out = ''
    let err = ''
    let forced
    const signal = name => {
      if (child.pid) {
        try { process.kill(-child.pid, name) } catch (error) {
          if (error.code !== 'ESRCH') console.error('maintenance: could not stop a command')
        }
      }
    }
    const stop = () => {
      signal('SIGTERM')
      forced ??= setTimeout(() => signal('SIGKILL'), 5000)
    }
    commands.add(stop)
    const timer = setTimeout(stop, TIMEOUT_MS)
    child.stdout.on('data', chunk => { if (out.length < 64 * 1024) out += chunk })
    child.stderr.on('data', chunk => { if (err.length < 16 * 1024) err += chunk })
    function done(code) {
      clearTimeout(timer)
      clearTimeout(forced)
      commands.delete(stop)
      resolve({ code, stdout: out.slice(0, 64 * 1024), stderr: err.slice(0, 16 * 1024) })
    }
    child.once('close', done)
    child.once('error', () => {
      err = 'could not start the Runtime command'
      done(-1)
    })
  })
}

const launcher = process.argv[2]
const managed = launcher ? manageWeb(join(process.env.DSH_HOME, 'runtime'), launcher, run, shutdown) : null
let backups = 0
let stopping = false

const server = createServer(async (req, res) => {
  if (secret === '') return respond(res, 503, { error: 'MAINTENANCE_DISABLED' })
  if (req.method !== 'POST') return respond(res, 405, { error: 'METHOD' })
  if (!equal(req.headers.authorization ?? '', 'Bearer ' + secret)) {
    return respond(res, 401, { error: 'UNAUTHORIZED' })
  }
  let body = ''
  try {
    for await (const chunk of req) {
      body += chunk
      if (body.length > 8192) return respond(res, 413, { error: 'TOO_LARGE' })
    }
  } catch {
    return
  }
  let parsed = {}
  try { parsed = body === '' ? {} : JSON.parse(body) } catch { return respond(res, 400, { error: 'BAD_JSON' }) }
  const action = String(parsed?.action ?? '')
  if (action === 'upgrade') {
    const version = parsed.args?.version
    if (typeof version !== 'string' || version.length > 96 || !VERSION.test(version)) {
      return respond(res, 400, { error: 'INVALID_VERSION' })
    }
    if (!managed || stopping) return respond(res, 503, { error: 'UPGRADE_UNAVAILABLE' })
    if (backups) return respond(res, 409, { error: 'UPGRADE_BUSY' })
    try {
      const refused = managed.queue(version)
      if (refused) return respond(res, refused === 'UPGRADE_UNAVAILABLE' ? 503 : 409, { error: refused })
      return respond(res, 202, { action, ok: true })
    } catch {
      return respond(res, 503, { error: 'UPGRADE_UNAVAILABLE' })
    }
  }
  let argv
  try { argv = argvFor(action, parsed?.args) } catch (error) {
    return respond(res, 400, { error: String(error.message) })
  }
  if (action === 'backup') {
    if (stopping || managed?.busy) return respond(res, 409, { error: 'UPGRADE_BUSY' })
    backups++
  }
  const result = await run(argv).finally(() => { if (action === 'backup') backups-- })
  // A non-zero exit is a result, not a server error: the CLI prints why it
  // refused, and that text is what the operator needs to see.
  respond(res, 200, { action, argv, ok: result.code === 0, managedUpgrade: Boolean(managed), ...result })
})

function shutdown(code) {
  if (stopping) return
  stopping = true
  if (server.listening) server.close()
  for (const stop of commands) stop()
  void managed?.stop()
  process.exitCode = code
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
await managed?.start().catch(() => {
  console.error('maintenance: DSH could not start')
  shutdown(1)
})
const [host, port] = ADDR.split(':')
if (!stopping) {
  server.listen(Number(port), host, () => {
    console.log('maintenance: listening on ' + ADDR + (secret === '' ? ' (disabled)' : ''))
  })
}
