#!/usr/bin/env node
// Compatibility checks for a candidate DSH release.
//
// The runtime installs with lifecycle scripts disabled, so this module answers
// three questions before a switch is allowed:
//
//   1. Does the candidate accept the Node.js the Runtime image ships?
//   2. Do the installed Profile bundles accept the candidate DSH version?
//   3. Which dependencies declare lifecycle scripts that were therefore never
//      run, and has the operator approved each one explicitly?
//
// It also records the Profile lockfile digests so a backup can prove which
// dependency set the restored state belonged to.
//
// Supported semver subset: `||`, whitespace conjunctions, `=`, `>`, `>=`, `<`,
// `<=`, `^`, `~`, `x`/`*` wildcards and bare versions. Pre-release identifiers
// order below the corresponding release and compare lexically among themselves.
// Anything outside that subset is reported as unsupported rather than guessed.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff) return diff < 0 ? -1 : 1
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (!left || !right) throw Error(`cannot compare ${JSON.stringify(a)} with ${JSON.stringify(b)}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function partial(text) {
  const wildcard = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(text.replace(/^v/, ''))
  if (!wildcard) return null
  const numbers = [wildcard[1], wildcard[2], wildcard[3]]
  const filled = []
  for (const part of numbers) {
    if (part === undefined || /^[xX*]$/.test(part)) break
    filled.push(Number(part))
  }
  if (filled.length === 0) return null
  return { specified: filled, omitted: numbers.slice(filled.length) }
}

function upperBound(base, level) {
  if (level === 'major') return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
  if (level === 'minor') return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }
  return { major: base.major, minor: base.minor, patch: base.patch + 1, prerelease: [] }
}

// Returns { verdict: 'pass' | 'fail' | 'unsupported', reason } for one range.
export function satisfies(range, version) {
  const candidate = parseVersion(version)
  if (!candidate) return { verdict: 'unsupported', reason: `invalid candidate version ${JSON.stringify(version)}` }
  const alternatives = String(range).split('||')
  const failures = []
  for (const alternative of alternatives) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean)
    // An empty range (or an empty `||` branch) means "any version".
    if (tokens.length === 0) return { verdict: 'pass', reason: 'empty range accepts any version' }
    let ok = true
    let unsupported
    for (const token of tokens) {
      const result = satisfiesComparator(token, candidate)
      if (result.verdict === 'unsupported') { unsupported = result; break }
      if (result.verdict === 'fail') { ok = false; failures.push(result.reason) }
    }
    if (unsupported) return unsupported
    if (ok) return { verdict: 'pass', reason: `${version} satisfies ${range}` }
  }
  return { verdict: 'fail', reason: failures[0] ?? `${version} does not satisfy ${range}` }
}

function satisfiesComparator(token, candidate) {
  const operator = /^(>=|<=|>|<|=|\^|~)/.exec(token)?.[1] ?? ''
  const operand = token.slice(operator.length)
  if (operand === '' || /^[xX*]$/.test(operand)) return { verdict: 'pass' }
  const exact = parseVersion(operand)

  if (operator === '^' || operator === '~') {
    const base = exact ?? (partial(operand) ? buildPartial(operand) : null)
    if (!base) return { verdict: 'unsupported', reason: `unsupported range ${token}` }
    const level = operator === '^'
      ? (base.major > 0 ? 'major' : base.minor > 0 ? 'minor' : 'patch')
      : (base.major > 0 ? 'minor' : 'patch')
    const lower = compareVersions(candidate, base) >= 0
    const upper = compareVersions(candidate, upperBound(base, level)) < 0
    return lower && upper
      ? { verdict: 'pass' }
      : { verdict: 'fail', reason: `${candidate.major}.${candidate.minor}.${candidate.patch} is outside ${token}` }
  }

  if (!exact) {
    const spec = partial(operand)
    if (!spec) return { verdict: 'unsupported', reason: `unsupported range ${token}` }
    const base = buildPartial(operand)
    const matchesPrefix = spec.specified.every((value, index) =>
      [candidate.major, candidate.minor, candidate.patch][index] === value)
    if (operator === '' || operator === '=') {
      return matchesPrefix ? { verdict: 'pass' } : { verdict: 'fail', reason: `${operator || '='}${operand} rejects the candidate` }
    }
    const order = compareVersions(candidate, base)
    const result = operator === '>=' ? order >= 0
      : operator === '>' ? order > 0
        : operator === '<=' ? order <= 0
          : order < 0
    return result ? { verdict: 'pass' } : { verdict: 'fail', reason: `${token} rejects the candidate` }
  }

  const order = compareVersions(candidate, exact)
  const result = operator === '>=' ? order >= 0
    : operator === '>' ? order > 0
      : operator === '<=' ? order <= 0
        : operator === '<' ? order < 0
          : order === 0
  return result ? { verdict: 'pass' } : { verdict: 'fail', reason: `${token} rejects the candidate` }
}

function buildPartial(text) {
  const spec = partial(text)
  if (!spec) return null
  const [major = 0, minor = 0, patch = 0] = spec.specified
  return { major, minor, patch, prerelease: [] }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function directorySize(path) {
  let files = 0
  let bytes = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) {
        files++
        try { bytes += statSync(target).size } catch {}
      }
    }
  }
  return { files, bytes }
}

// Reads installed packages from the pnpm virtual store. pnpm links only the
// direct dependency at the top level and keeps the rest in .pnpm, so walking
// only node_modules would report a tree that is not there.
function installedPackages(root) {
  const found = []
  const seen = new Set()
  const add = (name, manifest) => {
    if (!manifest?.name || seen.has(`${manifest.name}@${manifest.version}`)) return
    seen.add(`${manifest.name}@${manifest.version}`)
    found.push({ name: manifest.name, version: manifest.version ?? 'unknown', manifest })
  }
  const store = join(root, '.pnpm')
  let entries = []
  try {
    entries = readdirSync(store, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Entries look like `name@version` or `@scope+name@version`, and each keeps
    // its package under .pnpm/<slug>/node_modules/<name>.
    const nested = join(store, entry.name, 'node_modules')
    let candidates = []
    try {
      candidates = readdirSync(nested, { withFileTypes: true })
    } catch {
      continue
    }
    for (const candidate of candidates) {
      if (candidate.name.startsWith('@')) {
        let scoped = []
        try {
          scoped = readdirSync(join(nested, candidate.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const inner of scoped) {
          if (!inner.isDirectory() && !inner.isSymbolicLink()) continue
          add(`${candidate.name}/${inner.name}`, readJSON(join(nested, candidate.name, inner.name, 'package.json')))
        }
      } else if (candidate.isDirectory() || candidate.isSymbolicLink()) {
        add(candidate.name, readJSON(join(nested, candidate.name, 'package.json')))
      }
    }
  }
  // Also include direct links, which pnpm keeps outside the store.
  let direct = []
  try {
    direct = readdirSync(root, { withFileTypes: true })
  } catch {
    direct = []
  }
  for (const entry of direct.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.isDirectory() || entry.isSymbolicLink()) add(entry.name, readJSON(join(root, entry.name, 'package.json')))
  }
  return found.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
}

// Lifecycle scripts among installed packages. The Runtime installs with
// --ignore-scripts, so such a script never ran.
//
// Profile dependencies are the operator's own additions, so each one needs an
// explicit approval. The DSH release's own tree is reported but never blocks a
// switch: its install policy is fixed (--ignore-scripts) and identical for
// every version, and the readiness probe is what proves a candidate boots.
export function unapprovedScripts(root, approved) {
  const installed = installedPackages(root)
  const scripts = []
  for (const entry of installed) {
    const declared = entry.manifest.scripts ?? {}
    const present = SCRIPT_KEYS.filter(key => typeof declared[key] === 'string')
    if (present.length === 0) continue
    const key = `${entry.name}@${entry.version}`
    scripts.push({ package: key, hooks: present, approved: approved.has(key) })
  }
  return { scanned: installed.length, scripts }
}

function profileState(dshHome) {
  const profilesDir = join(dshHome, 'profiles')
  const profiles = []
  let names = []
  try {
    names = readdirSync(profilesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return profiles
  }
  for (const name of names.sort()) {
    const dir = join(profilesDir, name)
    const manifest = readJSON(join(dir, 'package.json')) ?? {}
    const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
    const bundles = Object.entries(dependencies)
      .filter(([packageName]) => packageName.startsWith('dsh-') || packageName.includes('workstation'))
      .map(([packageName, requested]) => {
        const installed = readJSON(join(dir, 'node_modules', packageName, 'package.json'))
        const engines = installed?.engines ?? {}
        const peers = Object.entries(installed?.peerDependencies ?? {})
          .filter(([peer]) => peer.startsWith('@deepseek-ai/dsh'))
          .map(([peer, peerRange]) => ({ peer, range: peerRange }))
        return {
          package: packageName,
          requested,
          installed: installed?.version ?? null,
          engines: engines.dsh ?? null,
          peers,
        }
      })
    profiles.push({
      name,
      lockfile: sha256(join(dir, 'pnpm-lock.yaml')),
      manifest: sha256(join(dir, 'package.json')),
      bundles,
    })
  }
  return profiles
}

export function check({ dshHome, candidate, nodeVersion, approved = new Set() }) {
  const versionDir = join(dshHome, 'runtime', 'versions', candidate)
  // The version directory root is the workspace package.json that pnpm writes;
  // the DSH release manifest is the installed package itself. Read the package
  // first and fall back to the workspace manifest only if it is missing.
  const manifestPath = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const manifest = readJSON(manifestPath) ?? readJSON(join(versionDir, 'package.json'))
  const failures = []
  const warnings = []

  const node = { version: nodeVersion, engine: null, verdict: 'unsupported', reason: 'candidate manifest is missing' }
  if (!manifest) {
    failures.push(`the candidate is not installed at versions/${candidate}`)
  } else if (manifest.name !== '@deepseek-ai/dsh') {
    failures.push(`versions/${candidate} has no @deepseek-ai/dsh manifest; refusing to infer compatibility from the workspace file`)
  } else {
    node.package = manifest.name
    node.installed = manifest.version ?? null
    node.engine = manifest.engines?.node ?? null
    if (node.engine === null) {
      node.verdict = 'unsupported'
      node.reason = 'candidate declares no Node engine range'
    } else {
      const result = satisfies(node.engine, nodeVersion)
      node.verdict = result.verdict
      node.reason = result.reason
    }
    if (node.verdict !== 'pass') failures.push(`Node ${nodeVersion} is not accepted by the candidate (${node.engine ?? 'no range'})`)
    if (node.installed !== candidate) failures.push(`installed package reports ${node.installed}, expected ${candidate}`)
  }

  const profiles = profileState(dshHome)
  let scripts = { scanned: 0, scripts: [] }
  for (const profile of profiles) {
    if (!profile.lockfile) warnings.push(`profile ${profile.name} has no pnpm-lock.yaml`)
    for (const bundle of profile.bundles) {
      if (bundle.installed === null) {
        warnings.push(`profile ${profile.name} lists ${bundle.package} but it is not installed`)
        continue
      }
      if (bundle.engines) {
        const result = satisfies(bundle.engines, candidate)
        bundle.verdict = result.verdict
        bundle.reason = result.reason
        if (result.verdict === 'unsupported') failures.push(`${bundle.package} declares an unsupported engines.dsh range ${bundle.engines}`)
        else if (result.verdict === 'fail') failures.push(`${bundle.package} requires DSH ${bundle.engines}, candidate is ${candidate}`)
      } else {
        bundle.verdict = 'unsupported'
        bundle.reason = 'no engines.dsh range'
        warnings.push(`${bundle.package} declares no engines.dsh range`)
      }
      for (const peer of bundle.peers) {
        const result = peer.range === '*' ? { verdict: 'pass', reason: 'any version' } : satisfies(peer.range, candidate)
        if (result.verdict === 'fail') failures.push(`${bundle.package} peer ${peer.peer} requires ${peer.range}, candidate is ${candidate}`)
        if (result.verdict === 'unsupported') failures.push(`${bundle.package} peer ${peer.peer} range ${peer.range} is unsupported`)
      }
    }
    // A Profile's own dependency tree is the operator's additions. Lifecycle
    // scripts there were skipped during install, so each needs approval.
    const found = unapprovedScripts(join(dshHome, 'profiles', profile.name, 'node_modules'), approved)
    scripts.scanned += found.scanned
    scripts.scripts.push(...found.scripts.map(script => ({ ...script, profile: profile.name })))
  }

  // Report the DSH release's own tree for visibility, but do not block on it.
  const upstream = unapprovedScripts(join(versionDir, 'node_modules'), new Set())
  for (const script of upstream.scripts) {
    warnings.push(`upstream ${script.package} declares ${script.hooks.join(', ')} and was installed with --ignore-scripts`)
  }

  const pending = scripts.scripts.filter(script => !script.approved)
  for (const script of pending) {
    failures.push(`${script.package} declares ${script.hooks.join(', ')}; it was installed with --ignore-scripts and is not approved`)
  }

  return {
    candidate,
    node,
    profiles,
    dependencies: {
      upstream: { scanned: upstream.scanned, withScripts: upstream.scripts.length },
      profile: { scanned: scripts.scanned, total: scripts.scripts.length, pending: pending.length, scripts: scripts.scripts },
    },
    verdict: failures.length === 0 ? 'pass' : 'fail',
    failures,
    warnings,
  }
}

export function inventory(dshHome) {
  const home = directorySize(join(dshHome, 'profiles'))
  return { profiles: profileState(dshHome), size: home }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2)
  const flags = {}
  for (let index = 0; index < rest.length; index++) {
    if (rest[index].startsWith('--')) flags[rest[index].slice(2)] = rest[index + 1]?.startsWith('--') ? true : rest[++index]
  }
  try {
    if (command === 'check') {
      const approved = new Set()
      if (typeof flags['approve-scripts'] === 'string') {
        for (const line of readFileSync(flags['approve-scripts'], 'utf8').split('\n')) {
          const entry = line.trim()
          if (entry && !entry.startsWith('#')) approved.add(entry)
        }
      }
      const report = check({
        dshHome: flags['dsh-home'] ?? process.env.DSH_HOME,
        candidate: flags.candidate,
        nodeVersion: flags.node ?? process.versions.node,
        approved,
      })
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.verdict === 'pass' ? 0 : 1
    } else if (command === 'inventory') {
      console.log(JSON.stringify(inventory(flags['dsh-home'] ?? process.env.DSH_HOME), null, 2))
    } else {
      console.error('usage: compat.mjs {check --dsh-home DIR --candidate VERSION [--node VERSION] [--approve-scripts FILE] | inventory --dsh-home DIR}')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(`compat: ${error.message}`)
    process.exitCode = 2
  }
}
