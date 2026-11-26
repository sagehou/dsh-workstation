// The Gateway uses this private listener for inventory and online backups.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

const BACKUP_ID = /^[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{12}$/

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
  const action = String(parsed?.action ?? '')
  let argv
  try { argv = argvFor(action, parsed?.args) } catch (error) {
    return respond(res, 400, { error: String(error.message) })
  }
  const result = await run(argv)
  // A non-zero exit is a result, not a server error: the CLI prints why it
  // refused, and that text is what the operator needs to see.
  respond(res, 200, { action, argv, ok: result.code === 0, ...result })
})

const [host, port] = ADDR.split(':')
server.listen(Number(port), host, () => {
  console.log('maintenance: listening on ' + ADDR + (secret === '' ? ' (disabled)' : ''))
})
