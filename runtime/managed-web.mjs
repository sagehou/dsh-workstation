import { fork } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/
export const BACKUP_ID = /^[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{12}$/

export function manageWeb(dir, launcher, command, onExit) {
  const statusFile = join(dir, 'upgrade-status.json')
  let web, operation, shuttingDown = false

  const selection = () => readFileSync(join(dir, 'selection'), 'utf8').trim().split(/\s+/)[0]
  function lastStatus() {
    try { return JSON.parse(readFileSync(statusFile, 'utf8')) } catch { return null }
  }
  function record(status, phase, result) {
    writeFileSync(statusFile + '.new', JSON.stringify({ ...status, phase, result, managed: true }) + '\n', { mode: 0o600 })
    renameSync(statusFile + '.new', statusFile)
  }

  async function startWeb(requireProfile = false) {
    const version = selection()
    if (!VERSION.test(version)) throw Error('invalid active DSH version')
    const bin = join(dir, 'versions', version, 'node_modules/.bin/dsh')
    const args = requireProfile ? ['serve', bin, '--require-profile'] : ['serve', bin]
    const child = fork(launcher, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const closed = new Promise(resolve => child.once('close', resolve))
    const instance = { child, closed }
    web = instance
    await new Promise((resolve, reject) => {
      let ready = false
      child.once('error', reject)
      child.on('message', message => {
        if (message !== 'ready') return
        ready = true
        resolve()
      })
      closed.then(code => {
        if (!ready) reject(Error('DSH did not start'))
        if (web !== instance) return
        web = undefined
        if (ready && !operation && !shuttingDown) onExit(code ?? 1)
      })
    })
  }

  async function stopWeb() {
    if (!web) return
    const { child, closed } = web
    web = undefined
    child.kill('SIGTERM')
    await closed
  }

  async function restore(status) {
    record(status, 'restore', 'running')
    if (!BACKUP_ID.test(status.backup ?? '')) throw Error('missing matched upgrade backup')
    const restored = await command(['restore', status.backup], true)
    if (restored.code !== 0 || selection() !== status.from) throw Error('could not restore the matched backup')
  }

  async function upgrade(status) {
    try {
      await stopWeb()
      if (shuttingDown) return
      const result = await command(['upgrade', status.to], true)
      const transaction = lastStatus()
      if (transaction?.from === status.from && transaction.to === status.to) status = transaction
      // Leave the durable transaction for start() when the container is stopping.
      if (shuttingDown) return
      if (result.code !== 0 || status.result !== 'selected' || selection() !== status.to) {
        throw Error('upgrade transaction failed')
      }
      record(status, 'restart', 'running')
      await startWeb(true)
      if (shuttingDown) return
      record(status, 'verify', 'running')
      const verified = await command(['verify'], true)
      if (shuttingDown) return
      if (!web) throw Error('upgraded DSH stopped during verification')
      if (verified.code !== 0) record(status, 'verify', 'verification-failed')
    } catch {
      if (shuttingDown) return
      await stopWeb()
      try {
        if (selection() === status.to) {
          await restore(status)
          await startWeb()
          record(status, 'restart', 'rolled-back')
        } else {
          await startWeb()
          record(status, status.phase, 'failed')
        }
      } catch {
        record(status, 'restore', 'recovery-failed')
      }
    }
  }

  return {
    async start() {
      const status = lastStatus()
      let restored
      if (status?.managed && ['running', 'selected', 'failed', 'recovery-failed'].includes(status.result)) {
        if (selection() === status.to) {
          if (status.phase === 'verify' && await startWeb(true).then(() => true, () => false)) {
            record(status, 'verify', 'verification-failed')
            return
          }
          await restore(status)
          restored = status
        } else if (status.result === 'running') {
          record(status, status.phase, 'interrupted')
        }
      }
      await startWeb()
      if (restored) record(restored, 'restart', 'rolled-back')
    },
    async stop() {
      shuttingDown = true
      await stopWeb()
      await operation
    },
    get busy() { return operation !== undefined },
    queue(to) {
      if (operation || shuttingDown) return 'UPGRADE_BUSY'
      if (!web) return 'UPGRADE_UNAVAILABLE'
      const from = selection()
      if (from === to) return 'VERSION_ACTIVE'
      const status = { from, to, phase: 'stop', result: 'running' }
      record(status, 'stop', 'running')
      operation = upgrade(status).catch(() => {
        console.error('maintenance: could not finalize managed upgrade')
        onExit(1)
      }).finally(() => { operation = undefined })
      return ''
    },
  }
}
