// Unit tests for the compatibility gate. Run with: node --test runtime/test/
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { check, compareVersions, parseVersion, satisfies } from '../compat.mjs'

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
  mkdirSync(join(dir, 'profiles', 'web', 'node_modules'), { recursive: true })
  mkdirSync(join(dir, 'runtime', 'versions'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'web', 'package.json'), '{"name":"web","dependencies":{}}')
  writeFileSync(join(dir, 'profiles', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  return dir
}

function install(dir, version, { engines = { node: '>=24.9.0' }, dependencies = {} } = {}) {
  const root = join(dir, 'runtime', 'versions', version)
  // Mirror the real layout: pnpm writes a workspace package.json at the version
  // root and installs the DSH release under node_modules/@deepseek-ai/dsh.
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  // pnpm keeps the DSH release behind a link and its tree in the virtual store.
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(join(root, 'package.json'),
    JSON.stringify({ name: 'dsh-workstation-runtime', private: true, dependencies: { '@deepseek-ai/dsh': version } }))
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, engines }))
  for (const [name, manifest] of Object.entries(dependencies)) {
    storePackage(join(root, 'node_modules', '.pnpm'), name, manifest)
  }
}

// Mirror pnpm's virtual-store layout: .pnpm/<slug>/node_modules/<name>.
function storePackage(store, name, manifest) {
  const slug = `${name.replace('/', '+')}@${manifest.version ?? '0.0.0'}`
  const target = join(store, slug, 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
}

function bundle(dir, name, manifest) {
  const target = join(dir, 'profiles', 'web', 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
  const manifestPath = join(dir, 'profiles', 'web', 'package.json')
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  pkg.dependencies[name] = manifest.version
  writeFileSync(manifestPath, JSON.stringify(pkg))
}

test('semver comparison orders pre-releases below the release', () => {
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.5'), -1)
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.9'), 1)
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.deepEqual(parseVersion('v3.7.19'), { major: 3, minor: 7, patch: 19, prerelease: [] })
  assert.equal(parseVersion('nonsense'), null)
})

test('range evaluation matches npm semantics for the forms DSH uses', () => {
  const cases = [
    ['>=24.9.0', '24.22.3', 'pass'],
    ['^24.9.0', '24.22.3', 'pass'],
    ['^25.0.0', '24.22.3', 'fail'],
    ['~3.7.0', '3.7.19', 'pass'],
    ['~3.7.0', '3.8.0', 'fail'],
    ['^0.2.2', '0.2.2-rc.5', 'fail'],
    ['^0.2.2-rc.1', '0.2.2-rc.5', 'pass'],
    ['^0.2.2-rc.1', '0.3.0', 'fail'],
    ['0.2.2-rc.1', '0.2.2-rc.5', 'fail'],
    ['', '9.9.9', 'pass'],
    ['*', '9.9.9', 'pass'],
    ['>=3 <4 || >=5', '5.0.1', 'pass'],
    ['>=3 <4 || >=5', '4.2.0', 'fail'],
    ['garbage@@', '1.0.0', 'unsupported'],
  ]
  for (const [range, version, want] of cases) {
    assert.equal(satisfies(range, version).verdict, want, `${JSON.stringify(range)} vs ${version}`)
  }
})

test('a candidate that rejects the image Node.js fails the gate', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1', { engines: { node: '>=99.0.0' } })
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.verdict, 'fail')
    assert.match(report.failures.join('\n'), /Node 24\.22\.3 is not accepted/)
    assert.equal(report.node.verdict, 'fail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a candidate declaring no Node range is unsupported, not assumed', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1', { engines: {} })
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.node.verdict, 'unsupported')
    assert.equal(report.verdict, 'fail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an installed bundle that pins another DSH blocks the switch', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1')
    install(dir, '0.2.2-rc.5')
    bundle(dir, 'dsh-workstation-browser', {
      name: 'dsh-workstation-browser',
      version: '0.1.0',
      engines: { dsh: '0.2.2-rc.1' },
      peerDependencies: { '@deepseek-ai/dsh-mcp-client': '0.2.2-rc.1' },
    })
    assert.equal(check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' }).verdict, 'pass')
    const blocked = check({ dshHome: dir, candidate: '0.2.2-rc.5', nodeVersion: '24.22.3' })
    assert.equal(blocked.verdict, 'fail')
    assert.match(blocked.failures.join('\n'), /dsh-workstation-browser requires DSH 0\.2\.2-rc\.1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bundle with no engines.dsh range warns but does not silently pass', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1')
    bundle(dir, 'dsh-unversioned', { name: 'dsh-unversioned', version: '1.0.0' })
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.profiles[0].bundles[0].verdict, 'unsupported')
    assert.match(report.warnings.join('\n'), /declares no engines\.dsh range/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function profilePackage(dir, name, manifest) {
  // pnpm installs into the virtual store and links from node_modules. Both
  // paths exist for a real Profile, so the fixture must provide both.
  storePackage(join(dir, 'profiles', 'web', 'node_modules', '.pnpm'), name, manifest)
  const target = join(dir, 'profiles', 'web', 'node_modules', name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
}

test('unapproved Profile lifecycle scripts block the switch until approved by name', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1')
    profilePackage(dir, 'native-thing', { name: 'native-thing', version: '2.0.0', scripts: { postinstall: 'node-gyp rebuild' } })
    profilePackage(dir, 'plain-thing', { name: 'plain-thing', version: '1.0.0' })
    const blocked = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(blocked.verdict, 'fail')
    assert.equal(blocked.dependencies.profile.pending, 1)
    assert.match(blocked.failures.join('\n'), /native-thing@2\.0\.0 declares postinstall/)

    const approved = check({
      dshHome: dir,
      candidate: '0.2.2-rc.1',
      nodeVersion: '24.22.3',
      approved: new Set(['native-thing@2.0.0']),
    })
    assert.equal(approved.verdict, 'pass')
    assert.equal(approved.dependencies.profile.pending, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scoped Profile packages are scanned for lifecycle scripts', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1')
    profilePackage(dir, '@scope/native', { name: '@scope/native', version: '3.1.0', scripts: { install: 'make' } })
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.dependencies.profile.pending, 1)
    assert.match(report.failures.join('\n'), /@scope\/native@3\.1\.0 declares install/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the DSH release tree is reported but never blocks a switch', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1', {
      dependencies: {
        'upstream-native': { name: 'upstream-native', version: '1.0.0', scripts: { postinstall: 'node-gyp rebuild' } },
      },
    })
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.verdict, 'pass', 'upstream install policy is fixed and cannot block a per-version switch')
    assert.equal(report.dependencies.upstream.withScripts, 1)
    assert.match(report.warnings.join('\n'), /upstream upstream-native@1\.0\.0 declares postinstall/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing candidate is reported instead of assumed installed', () => {
  const dir = home()
  try {
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.9', nodeVersion: '24.22.3' })
    assert.equal(report.verdict, 'fail')
    assert.match(report.failures.join('\n'), /not installed at versions\/0\.2\.2-rc\.9/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a version directory without the DSH package is not judged by its workspace manifest', () => {
  const dir = home()
  try {
    // A partial install leaves only the pnpm workspace file behind.
    mkdirSync(join(dir, 'runtime', 'versions', '0.2.2-rc.1'), { recursive: true })
    writeFileSync(join(dir, 'runtime', 'versions', '0.2.2-rc.1', 'package.json'),
      '{"name":"dsh-workstation-runtime","private":true}')
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.verdict, 'fail')
    assert.match(report.failures.join('\n'), /no @deepseek-ai\/dsh manifest/)
    assert.equal(report.node.engine, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an installed package whose version disagrees with the directory fails', () => {
  const dir = home()
  try {
    install(dir, '0.2.2-rc.1')
    // Simulate a directory that was relabelled without reinstalling.
    const manifest = join(dir, 'runtime', 'versions', '0.2.2-rc.1', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5', engines: { node: '>=24.9.0' } }))
    const report = check({ dshHome: dir, candidate: '0.2.2-rc.1', nodeVersion: '24.22.3' })
    assert.equal(report.verdict, 'fail')
    assert.match(report.failures.join('\n'), /installed package reports 0\.2\.2-rc\.5, expected 0\.2\.2-rc\.1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
