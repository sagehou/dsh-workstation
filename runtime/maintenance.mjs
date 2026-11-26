// Maintenance listener for the Runtime container (#32).
//
// The operations page can list versions and backups because the Gateway has the
// volumes mounted read-only. It cannot *change* them: upgrading rewrites
// DSH_HOME, and the Gateway has neither the toolchain nor a writable mount.
//
// This process is that missing half. It runs inside the Runtime container, next
// to `dsh-runtime`, and shells out to the very commands the CLI documents. It
// deliberately does not reimplement the upgrade transaction — `dsh-runtime
// upgrade` already installs into a separate directory, runs the compatibility
// gate, probes readiness and only then flips the pointer. A second
// implementation of that sequence would be a second thing to get wrong.
//
// Why not a Docker socket: AGENTS.md forbids mounting it into DSH and Auth, and
// a control endpoint that can start arbitrary containers is a bigger hole than
// the one it closes. This process can only run the five `dsh-runtime`
// subcommands below.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const ADDR = process.env.MAINTENANCE_ADDR ?? '127.0.0.1:8099'
const SECRET_FILE = process.env.MAINTENANCE_SECRET ?? '/run/secrets/maintenance'
const RUNTIME = '/usr/local/bin/dsh-runtime'
// Long enough for a real upgrade, which installs a version and probes it.
const TIMEOUT_MS = Number(process.env.MAINTENANCE_TIMEOUT_MS ?? 600_000)

let secret = ''
try {
  secret = readFileSync(SECRET_FILE, 'utf8').trim()
} catch {
  // Without a secret the listener stays closed. An open maintenance endpoint on
  // the workstation network would let any container change the DSH version.
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

// The allowlist is the security boundary: only these verbs reach a process.
// `run` takes a version argument that is validated against the version grammar,
// because it becomes an argv element.
const COMMANDS = {
  // Component inventory for the management page. It reports what this container
  // actually runs, not what a manifest claims: an image that ships a different
  // Node than the one the docs name is exactly what this is for.
  components: [],
  status: [],
  versions: [],
  backups: [],
  backup: [],
  verify: ['id'],
  restore: ['id'],
  upgrade: ['version'],
  rollback: [],
}

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/
const BACKUP_ID = /^[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{12}$/

function argvFor (action, args) {
  switch (action) {
    case 'upgrade': {
      const version = String(args?.version ?? '')
      if (!VERSION.test(version)) throw Error('invalid version')
      return ['upgrade', version]
    }
    case 'verify':
    case 'restore': {
      const id = String(args?.id ?? '')
      if (!BACKUP_ID.test(id)) throw Error('invalid backup id')
      return [action === 'verify' ? 'check' : 'restore', id]
    }
    case 'components': return ['components']
    case 'status': return ['status']
    case 'versions': return ['versions']
    case 'backups': return ['backups']
    case 'backup': return ['backup']
    case 'rollback': return ['rollback']
    default: throw Error('unknown action')
  }
}

// A change to DSH_HOME needs the Web supervisor stopped, because `dsh-runtime
// upgrade` refuses while `/run/dsh-runtime/.web-pid` names a live process — an
// upgrade under a running Web process rewrites the tree it is reading.
//
// This process cannot stop its own parent and survive: the shell traps the
// listener's death, so killing the supervisor kills the listener too. The change
// is therefore written as a *request* and the container is restarted, which is the
// one lifecycle transition that can both stop the tree and re-run the work:
//
//   write /run/dsh-runtime/.pending-maintenance {action, args}
//   exit non-zero  ->  `restart: on-failure` re-execs dsh-runtime serve
//   serve sees the request before starting Web, runs it with the tree idle,
//   then starts Web on the new selection.
//
// The caller gets "restart scheduled" rather than the command's output, because
// the command has not run yet when the response is written.
const PENDING_FILE = '/run/dsh-runtime/.pending-maintenance'

function scheduleAfterRestart (action, args) {
  writeFileSync(PENDING_FILE + '.new', JSON.stringify({ action, args, at: Date.now() }), { mode: 0o600 })
  renameSync(PENDING_FILE + '.new', PENDING_FILE)
}

function run (argv) {
  return new Promise(resolve => {
    // `spawn` without a shell: the argv elements were validated above, and no
    // string is ever interpreted.
    const child = spawn(RUNTIME, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, TIMEOUT_MS)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout: out.slice(0, 64 * 1024), stderr: err.slice(0, 16 * 1024) })
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: out, stderr: String(error?.message ?? error) })
    })
  })
}

const server = createServer(async (req, res) => {
  if (secret === '') return respond(res, 503, { error: 'MAINTENANCE_DISABLED' })
  if (req.method !== 'POST') return respond(res, 405, { error: 'METHOD' })
  if (!equal(req.headers.authorization ?? '', 'Bearer ' + secret)) {
    return respond(res, 401, { error: 'UNAUTHORIZED' })
  }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 8192) return respond(res, 413, { error: 'TOO_LARGE' })
  }
  let parsed = {}
  try { parsed = body === '' ? {} : JSON.parse(body) } catch { return respond(res, 400, { error: 'BAD_JSON' }) }
  const action = String(parsed.action ?? '')
  if (!(action in COMMANDS)) return respond(res, 400, { error: 'UNKNOWN_ACTION' })
  let argv
  try { argv = argvFor(action, parsed.args) } catch (error) {
    return respond(res, 400, { error: String(error.message) })
  }
  // Only the commands that rewrite DSH_HOME need the supervisor stopped. Reading
  // commands run as-is, so a status check never interrupts the service.
  // Commands that rewrite DSH_HOME are deferred to the next container start: this
  // process cannot stop the supervisor it belongs to and survive to run them.
  const NEEDS_RESTART = new Set(['upgrade', 'rollback', 'restore'])
  let result
  if (NEEDS_RESTART.has(action)) {
    scheduleAfterRestart(action, parsed.args ?? {})
    result = { code: 0, stdout: 'Change scheduled; the container restarts and applies it.', stderr: '' }
    respond(res, 200, { action, argv, ok: true, deferred: true, ...result })
    // Exit non-zero so `restart: on-failure` re-execs the supervisor, which reads
    // the request before it starts Web again.
    res.on('finish', () => setTimeout(() => process.exit(1), 300))
    return
  }
  result = await run(argv)
  // A non-zero exit is a result, not a server error: the CLI prints why it
  // refused, and that text is what the operator needs to see.
  respond(res, 200, { action, argv, ok: result.code === 0, ...result })
})

const [host, port] = ADDR.split(':')
server.listen(Number(port), host, () => {
  console.log('maintenance: listening on ' + ADDR + (secret === '' ? ' (disabled)' : ''))
})

// The secret is per-boot. Exposing it lets an operator curl the endpoint
// directly when debugging, without reading the container filesystem.
if (secret !== '' && process.env.MAINTENANCE_PRINT_SECRET === '1') {
  console.log('maintenance: token ' + secret)
}
