// Complete a real password + TOTP login over HTTPS and prove the resulting
// session reaches DSH, without a browser.
//
//   node deploy/public/login-probe.mjs <base-url> <ca-file> [connect-host]
//
// check.mjs drives Playwright because the full-stack legs need a browser for
// Selkies. The core shape has no browser stack, so pulling in a Chromium viewer
// to read a few HTTP responses would cost more than the claim is worth. This
// talks to the Gateway directly: CSRF, password step, TOTP step, then DSH.
//
// Each assertion can fail, which is the point:
//   - the password step must return 303 and must NOT set a session. A session
//     after the password alone would mean TOTP is not a separate required
//     factor, which AGENTS.md forbids.
//   - DSH must answer the authenticated root with its boot marker. A 401 means
//     the session does not work for the Runtime, which is what core must show.
//   - /browser/ must be refused with 503 *while signed in*. Una authenticated
//     requests are redirected to the login page before reaching that branch, so
//     a 303 would prove nothing about the core refusal.
import { code, password } from './otp.mjs'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'

const root = process.argv[2] ?? 'https://workstation.test'
const ca = process.argv[3] ? readFileSync(process.argv[3]) : undefined
// The CI edge listens on 127.0.0.1 but the certificate names workstation.test, so
// the connection is dialled at the host given here while the Host header and SNI
// keep the certificate name. curl gets this from --resolve; node:https has no
// equivalent, so the address is substituted explicitly.
const connectAt = process.argv[4] ? Number(process.argv[4]) : undefined

const jar = new Map()
function store(headers) {
  for (const raw of headers['set-cookie'] ?? []) {
    const [pair, ...attributes] = raw.split(';').map(part => part.trim())
    const at = pair.indexOf('=')
    const name = pair.slice(0, at)
    const value = pair.slice(at + 1)
    const cleared = value === '' || attributes.some(a => /^max-age=0$/i.test(a))
    if (cleared) jar.delete(name)
    else jar.set(name, value)
  }
}
const cookies = () => [...jar].map(([n, v]) => `${n}=${v}`).join('; ')

async function request(path, { method = 'GET', form, headers = {} } = {}) {
  const url = new URL(path, root)
  const allHeaders = { cookie: cookies(), ...headers }
  let payload
  if (form) {
    payload = new URLSearchParams(form).toString()
    allHeaders['content-type'] = 'application/x-www-form-urlencoded'
    allHeaders['content-length'] = Buffer.byteLength(payload)
  }
  // node:https rather than fetch: the CI edge presents a certificate from a CA
  // that exists only for the run, and fetch has no per-request CA option.
  // Spreading a URL object copies internal symbols, not its fields, so the
  // address is substituted on a real URL instance instead.
  const target = new URL(url)
  if (connectAt) {
    target.hostname = '127.0.0.1'
    target.port = String(connectAt)
  }
  if (connectAt) allHeaders.host = url.host
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, { method, headers: allHeaders, ca, servername: url.hostname }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        store(response.headers)
        const text = Buffer.concat(chunks).toString()
        resolve({ status: response.statusCode, location: response.headers.location, text })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function csrfFrom(html) {
  const match = html.match(/name="csrf"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="csrf"/)
  if (!match) throw Error('the login page carried no csrf token')
  return match[1]
}
const has = name => jar.has(name)

// --- 1. the login page issues a CSRF token ---------------------------------
const login = await request('/_auth/login?next=%2F')
if (login.status !== 200) throw Error(`the login page answered ${login.status}, expected 200`)
const csrf = csrfFrom(login.text)
console.log('login page served; csrf issued')

// --- 2. the password alone must not produce a session ----------------------
const step = await request('/_auth/password', {
  method: 'POST',
  form: { csrf, username: 'operator', password: password() },
  headers: { origin: root, referer: `${root}/_auth/login` },
})
if (step.status !== 303) throw Error(`the password step answered ${step.status}, expected 303 to the TOTP screen`)
if (has('__Host-dsh_session')) throw Error('the password step issued a session, so TOTP is not a separate required factor')
if (!has('__Host-dsh_pre')) throw Error('the password step issued no pre-session cookie')
console.log('password accepted; no session issued yet')

// --- 3. TOTP completes the login -------------------------------------------
const totp = await request('/_auth/totp', {
  method: 'POST',
  form: { csrf, code: code() },
  headers: { origin: root, referer: `${root}/_auth/totp` },
})
if (totp.status !== 303) throw Error(`the TOTP step answered ${totp.status}, expected 303`)
if (!has('__Host-dsh_session')) throw Error('TOTP succeeded but no session cookie was issued')
console.log('password + TOTP issued a session')

// --- 4. that session reaches DSH -------------------------------------------
const dsh = await request('/')
if (dsh.status !== 200) throw Error(`the authenticated root answered ${dsh.status}, expected 200`)
if (!dsh.text.includes('__DSH_BOOT__')) throw Error('the authenticated root carried no DSH boot marker')
console.log('authenticated session reaches DSH; boot marker present')

// --- 5. /browser/ is refused by the core path, while signed in -------------
const browser = await request('/browser/')
if (browser.status !== 503) throw Error(`authenticated /browser/ answered ${browser.status}, expected 503 from the core path`)
if (!browser.text.includes('not part of this deployment')) throw Error('the refusal did not name the deployment shape')
console.log('authenticated /browser/ refused by the core path with 503')

console.log('core login verified: separate password and TOTP, session reaches DSH, /browser/ refused')
