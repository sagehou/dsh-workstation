import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { manageWeb } from '../managed-web.mjs'

const from = '0.2.2-rc.1'
const to = '0.2.2-rc.5'
const backup = '20261127T120000Z.aabbccddeeff'

for (const scenario of ['verified', 'rejected', 'rolled-back', 'interrupted after switch', 'interrupted during verification']) {
  test('managed Web upgrade ' + scenario, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-dsh-'))
    const selected = join(dir, 'selection')
    const report = join(dir, 'upgrade-status.json')
    const launcher = join(dir, 'fixture.mjs')
    const steps = []
    const status = () => JSON.parse(readFileSync(report, 'utf8'))
    const announce = (phase, result, details = {}) => {
      writeFileSync(report, JSON.stringify({ from, to, backup, phase, result, managed: true, ...details }))
    }
    const interrupted = scenario.startsWith('interrupted')
    const available = ['rolled-back', 'interrupted during verification'].includes(scenario) ? from : 'all'
    writeFileSync(launcher, `
      if (${JSON.stringify(available)} === 'all' || process.argv[3].includes('/${from}/')) {
        process.send('ready')
        const keepAlive = setInterval(() => {}, 1000)
        process.on('SIGTERM', () => clearInterval(keepAlive))
      } else {
        process.exit(1)
      }
    `)
    writeFileSync(selected, from + '\n')
    if (interrupted) {
      writeFileSync(selected, to + '\n')
      announce(scenario === 'interrupted during verification' ? 'verify' : 'restart', 'running')
    }
    const supervisor = manageWeb(dir, launcher, async ([action, value], managed) => {
      assert.equal(managed, true)
      steps.push(action)
      if (action === 'upgrade' && scenario === 'rejected') {
        announce('compatibility', 'running', { backup: '', blockers: ['test-bundle'] })
        return { code: 1 }
      }
      if (action === 'upgrade') {
        assert.equal(value, to)
        writeFileSync(selected, to + '\n')
        announce('switch', 'running')
      } else if (action === 'verify') {
        assert.equal(status().phase, 'verify')
        announce('switch', 'verified')
      } else {
        assert.equal(action, 'restore')
        assert.equal(value, backup)
        writeFileSync(selected, from + '\n')
      }
      return { code: 0 }
    }, code => assert.fail('supervisor exited with ' + code))
    try {
      await supervisor.start()
      if (!interrupted) {
        assert.equal(supervisor.queue(from), 'VERSION_ACTIVE')
        assert.equal(supervisor.queue(to), '')
        assert.equal(status().phase, 'stop')
        assert.equal(supervisor.queue(to), 'UPGRADE_BUSY')
        for (let i = 0; i < 100 && supervisor.busy; i++) await setTimeout(30)
        assert.equal(supervisor.busy, false)
      }
      if (scenario === 'verified') {
        assert.deepEqual(steps, ['upgrade', 'verify'])
        assert.equal(status().result, 'verified')
        assert.equal(readFileSync(selected, 'utf8').trim(), to)
      } else {
        assert.equal(readFileSync(selected, 'utf8').trim(), from)
        if (scenario === 'rejected') {
          assert.deepEqual(steps, ['upgrade'])
          assert.equal(status().result, 'failed')
          assert.deepEqual(status().blockers, ['test-bundle'])
        } else {
          assert.equal(steps.at(-1), 'restore')
          assert.equal(status().result, 'rolled-back')
        }
      }
    } finally {
      await supervisor.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
