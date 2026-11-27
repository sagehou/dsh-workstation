// Unit tests for backup manifests and state fingerprints.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diff, fingerprint } from '../state.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const state = join(here, '..', 'state.mjs')

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'))
  mkdirSync(join(dir, 'profiles', 'web', 'node_modules', 'dsh-thing'), { recursive: true })
  mkdirSync(join(dir, 'runtime', 'versions', '0.2.2-rc.1'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'web', 'package.json'), '{"name":"web","dependencies":{"dsh-thing":"1.0.0"}}')
  writeFileSync(join(dir, 'profiles', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(dir, 'profiles', 'web', 'node_modules', 'dsh-thing', 'package.json'),
    '{"name":"dsh-thing","version":"1.0.0"}')
  writeFileSync(join(dir, 'runtime', 'selection'), '0.2.2-rc.1\n')
  return dir
}

function run(args) {
  return execFileSync(process.execPath, [state, ...args], { encoding: 'utf8' })
}

test('the readiness copy keeps external Profile links and uses copied internal targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-links-'))
  try {
    const live = join(dir, 'live')
    const copy = join(live, 'runtime', '.probe')
    const external = join(dir, 'image-bundle')
    const local = join(live, 'local-bundle')
    const modules = 'profiles/web/node_modules'
    const relativeLink = relative(join(live, modules), external)
    mkdirSync(external)
    mkdirSync(local, { recursive: true })
    mkdirSync(join(live, modules, '@scope'), { recursive: true })
    symlinkSync(relativeLink, join(live, modules, 'external'))
    symlinkSync(local, join(live, modules, '@scope', 'local'))
    cpSync(join(live, 'profiles'), join(copy, 'profiles'), { recursive: true, verbatimSymlinks: true })
    cpSync(local, join(copy, 'local-bundle'), { recursive: true })
    run(['probe-links', '--dsh-home', live, '--copy', copy])
    assert.equal(realpathSync(join(copy, modules, 'external')), external)
    assert.equal(realpathSync(join(copy, modules, '@scope', 'local')), join(copy, 'local-bundle'))
    assert.equal(readlinkSync(join(live, modules, 'external')), relativeLink)
    assert.equal(readlinkSync(join(live, modules, '@scope', 'local')), local)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fingerprint captures the selection and Profile dependency set', () => {
  const dir = home()
  try {
    const print = fingerprint(dir)
    assert.equal(print.active, '0.2.2-rc.1')
    assert.deepEqual(print.versions, ['0.2.2-rc.1'])
    assert.equal(print.profiles.length, 1)
    assert.equal(print.profiles[0].packages, 1)
    assert.equal(print.profiles[0].files['pnpm-lock.yaml'].length, 64)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dependency change is reported with the file that moved', () => {
  const dir = home()
  try {
    const before = fingerprint(dir)
    writeFileSync(join(dir, 'profiles', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# migrated\n')
    const after = fingerprint(dir)
    const changes = diff(before, after)
    assert.equal(changes.length, 1)
    assert.deepEqual(changes[0].files, ['pnpm-lock.yaml'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dependency version bump inside the pnpm store is detected', () => {
  const dir = home()
  try {
    // pnpm keeps the installed dependency in the virtual store, so a real
    // migration changes .pnpm and not only the top-level link.
    const store = join(dir, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-thing@1.0.0', 'node_modules', 'dsh-thing')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'package.json'), '{"name":"dsh-thing","version":"1.0.0"}')
    const before = fingerprint(dir)
    assert.equal(before.profiles[0].packages, 1, 'the store copy and the link are the same package')

    rmSync(join(dir, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-thing@1.0.0'), { recursive: true, force: true })
    const bumped = join(dir, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-thing@1.0.1', 'node_modules', 'dsh-thing')
    mkdirSync(bumped, { recursive: true })
    writeFileSync(join(bumped, 'package.json'), '{"name":"dsh-thing","version":"1.0.1"}')
    writeFileSync(join(dir, 'profiles', 'web', 'node_modules', 'dsh-thing', 'package.json'), '{"name":"dsh-thing","version":"1.0.1"}')

    const after = fingerprint(dir)
    const changes = diff(before, after)
    assert.equal(changes.length, 1)
    // The digest must move even though no manifest or lockfile changed.
    assert.deepEqual(changes[0].files, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the reported tree size counts nested files', () => {
  const dir = home()
  try {
    const nested = join(dir, 'profiles', 'web', 'node_modules', 'dsh-thing', 'lib')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'index.js'), 'x'.repeat(100))
    const size = fingerprint(dir).profiles[0].size
    assert.ok(size.bytes >= 100, `expected at least 100 bytes, got ${size.bytes}`)
    assert.ok(size.files >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diff ignores the DSH selection and reports only data changes', () => {
  const dir = home()
  try {
    const before = fingerprint(dir)
    // A switch changes the pointer but must not count as a data migration.
    writeFileSync(join(dir, 'runtime', 'selection'), '0.2.2-rc.5 0.2.2-rc.1\n')
    assert.deepEqual(diff(before, fingerprint(dir)), [], 'a pointer move is not a data migration')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unchanged state reports no changes', () => {
  const dir = home()
  try {
    assert.deepEqual(diff(fingerprint(dir), fingerprint(dir)), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diff exits 10 when state moved and 0 when it did not', () => {
  const dir = home()
  try {
    const before = join(dir, 'before.json')
    const same = join(dir, 'same.json')
    writeFileSync(before, run(['fingerprint', '--dsh-home', dir]))
    writeFileSync(same, run(['fingerprint', '--dsh-home', dir]))
    assert.equal(run(['diff', '--before', before, '--after', same]).includes('"changed": false'), true)

    writeFileSync(join(dir, 'profiles', 'web', 'package.json'), '{"name":"web","dependencies":{}}')
    const after = join(dir, 'after.json')
    writeFileSync(after, run(['fingerprint', '--dsh-home', dir]))
    let status = 0
    try {
      run(['diff', '--before', before, '--after', after])
    } catch (error) {
      status = error.status
    }
    assert.equal(status, 10, 'a changed state must be distinguishable from a diff error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diff exits 0 when only the DSH pointer moved', () => {
  const dir = home()
  try {
    const before = join(dir, 'before.json')
    writeFileSync(before, run(['fingerprint', '--dsh-home', dir]))
    writeFileSync(join(dir, 'runtime', 'selection'), '0.2.2-rc.5 0.2.2-rc.1\n')
    const after = join(dir, 'after.json')
    writeFileSync(after, run(['fingerprint', '--dsh-home', dir]))
    const output = run(['diff', '--before', before, '--after', after])
    assert.match(output, /"changed": false/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a manifest records the archive checksum, image and DSH selection', () => {
  const dir = home()
  const archive = join(dir, 'dsh-home.test.tgz')
  const manifest = join(dir, 'dsh-home.test.json')
  try {
    writeFileSync(archive, 'pretend archive bytes')
    const manager = join(dir, 'dsh-runtime')
    writeFileSync(manager, '#!/usr/bin/env bash\ntrue\n')
    run(['manifest', '--dsh-home', dir, '--archive', archive, '--output', manifest,
      '--backup', 'test', '--runtime-image', 'sha256:abc', '--pnpm', '11.28.5',
      '--manager', manager, '--web', manager])
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    const expected = createHash('sha256').update('pretend archive bytes').digest('hex')
    assert.equal(parsed.archiveSha256, expected)
    assert.equal(parsed.runtime.image, 'sha256:abc')
    assert.equal(parsed.runtime.pnpm, '11.28.5')
    // A tag is mutable, so the manifest also digests the Runtime's own files.
    assert.equal(parsed.runtime.manager, createHash('sha256').update('#!/usr/bin/env bash\ntrue\n').digest('hex'))
    assert.equal(parsed.runtime.web, parsed.runtime.manager)
    // tar records numeric ids; a restore as another user would be unreadable.
    assert.equal(parsed.runtime.uid, process.getuid())
    assert.equal(parsed.runtime.gid, process.getgid())
    assert.equal(parsed.dsh.active, '0.2.2-rc.1')
    assert.equal(parsed.format, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verification fails closed on a changed archive', () => {
  const dir = home()
  const archive = join(dir, 'dsh-home.test.tgz')
  const manifest = join(dir, 'dsh-home.test.json')
  try {
    writeFileSync(archive, 'original bytes')
    run(['manifest', '--dsh-home', dir, '--archive', archive, '--output', manifest, '--backup', 'test'])
    assert.match(run(['verify', '--archive', archive, '--manifest', manifest]), /"ok": true/)

    writeFileSync(archive, 'tampered bytes')
    let status = 0
    let output = ''
    try {
      output = run(['verify', '--archive', archive, '--manifest', manifest])
    } catch (error) {
      status = error.status
      output = String(error.stdout)
    }
    assert.equal(status, 1)
    assert.match(output, /checksum does not match/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a manifest whose recorded size no longer matches is rejected', () => {
  const dir = home()
  const archive = join(dir, 'dsh-home.test.tgz')
  const manifest = join(dir, 'dsh-home.test.json')
  try {
    writeFileSync(archive, 'some bytes')
    run(['manifest', '--dsh-home', dir, '--archive', archive, '--output', manifest, '--backup', 'test'])
    // Editing the manifest's recorded size must be caught independently of the
    // checksum, so a truncated archive cannot slip through.
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    parsed.archiveSize = parsed.archiveSize + 1
    writeFileSync(manifest, JSON.stringify(parsed))
    let status = 0
    let output = ''
    try {
      output = run(['verify', '--archive', archive, '--manifest', manifest])
    } catch (error) {
      status = error.status
      output = String(error.stdout)
    }
    assert.equal(status, 1)
    assert.match(output, /size does not match/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a manifest with an unknown format version is rejected', () => {
  const dir = home()
  const archive = join(dir, 'dsh-home.test.tgz')
  const manifest = join(dir, 'dsh-home.test.json')
  try {
    writeFileSync(archive, 'some bytes')
    run(['manifest', '--dsh-home', dir, '--archive', archive, '--output', manifest, '--backup', 'test'])
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    parsed.format = 99
    writeFileSync(manifest, JSON.stringify(parsed))
    let status = 0
    let output = ''
    try {
      output = run(['verify', '--archive', archive, '--manifest', manifest])
    } catch (error) {
      status = error.status
      output = String(error.stdout)
    }
    assert.equal(status, 1)
    assert.match(output, /unsupported manifest format/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
