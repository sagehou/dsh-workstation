import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The deliberately fixed seed belongs only to the disposable Actions account.
const seed = '12345678901234567890'
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const bits = [...Buffer.from(seed)].map(value => value.toString(2).padStart(8, '0')).join('')
const base32 = bits.match(/.{5}/g).map(group => alphabet[parseInt(group, 2)]).join('')
export function code(offset = 0) {
  const time = Buffer.alloc(8)
  time.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset))
  const bytes = createHmac('sha1', seed).update(time).digest()
  return String((bytes.readUInt32BE(bytes.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, '0')
}
export const password = () => readFileSync((process.env.WORKSTATION_CI_STATE ?? '/ci-state') + '/password', 'utf8').trim()
if (process.argv[2] === 'password') process.stdout.write(randomBytes(24).toString('hex'))
if (process.argv[2] === 'bootstrap') process.stdout.write(password() + '\n' + base32 + '\n' + code(-1) + '\n')
