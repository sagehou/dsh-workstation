import { readFile } from 'node:fs/promises'

const command = process.argv[2]
const value = process.argv[3]
const admin = await readFile('/run/secrets/m0_admin', 'utf8')

async function control(path, body) {
  const response = await fetch('http://172.30.233.2:8081/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50_000),
  })
  const result = await response.json()
  if (!response.ok) throw Error(result.error)
  return result
}

switch (command) {
  case 'tickets': {
    const count = Number(value ?? 2)
    if (process.stdout.isTTY || !Number.isSafeInteger(count) || count < 1 || count > 32) {
      throw Error('Pipe 1–32 tickets directly to the Web launcher')
    }
    const tickets = []
    for (let i = 0; i < count; i++) tickets.push(await control('issue', { tab: true }))
    process.stdout.write(JSON.stringify(tickets))
    break
  }
  case 'grant': {
    if (!/^[0-9a-f-]{36}$/.test(value ?? '')) throw Error('Provide the peer ID printed by the Web launcher')
    const { generation } = await control('grant', { peer: value, ttl: 60_000 })
    console.log(generation)
    break
  }
  case 'recover':
  case 'takeover':
    console.log(JSON.stringify(await control(command, {})))
    break
  case 'status':
    console.log(JSON.stringify(await control(command)))
    break
  default:
    throw Error('Use recover, status, tickets, grant or takeover')
}
