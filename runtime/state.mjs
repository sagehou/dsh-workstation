#!/usr/bin/env node
// Backup manifests and state fingerprints.
//
// A backup is only a *data* backup when it can prove which Runtime image, DSH
// version and Profile dependency set it came from. This module writes that
// metadata next to the archive, and verifies an archive against it before a
// restore touches live state.
//
// A fingerprint deliberately describes *state*, not bytes: the Profile
// manifests, lockfiles, installed package versions and the DSH selection. That
// is what "the Profile/plugin state is consistent again" actually means, and it
// stays comparable across a restore even though tar cannot preserve mtimes
// exactly.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml']

export function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// pnpm records linked Profile packages relative to their original location.
// A probe copies DSH_HOME deeper into the volume, which changes external links.
function rebaseProbeLinks(source, copy) {
  source = resolve(source)
  copy = resolve(copy)
  const list = dir => lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(dir, { withFileTypes: true }) : []
  const profiles = join(copy, 'profiles')
  for (const profile of list(profiles).filter(entry => entry.isDirectory())) {
    const modules = join(profiles, profile.name, 'node_modules')
    const scopes = list(modules).filter(entry => entry.isDirectory() && entry.name.startsWith('@'))
    for (const dir of [modules, ...scopes.map(scope => join(modules, scope.name))]) {
      for (const entry of list(dir).filter(item => item.isSymbolicLink())) {
        const link = join(dir, entry.name)
        const stored = readlinkSync(link)
        const original = resolve(source, relative(copy, dir), stored)
        const path = relative(source, original)
        const target = path === '..' || path.startsWith('..' + sep) ? original : resolve(copy, path)
        if (resolve(dir, stored) === target) continue
        unlinkSync(link)
        symlinkSync(target, link)
      }
    }
  }
}

function tree(path) {
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
      // Join the directory that was actually read, not the walk root.
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(target)
      } else if (entry.isFile()) {
        try {
          const stat = statSync(target)
          files++
          bytes += stat.size
        } catch {}
      }
    }
  }
  return { files, bytes }
}

// Enumerates installed packages from the pnpm virtual store. pnpm links only
// the direct dependency into node_modules and keeps the rest in .pnpm, so a
// top-level walk would miss a dependency version bump and report unchanged
// state after a real migration.
function installedPackages(dir) {
  const root = join(dir, 'node_modules')
  const packages = []
  const seen = new Set()
  const add = (name, manifest) => {
    if (!manifest?.version) return
    const key = `${name}@${manifest.version}`
    if (seen.has(key)) return
    seen.add(key)
    packages.push({ name, version: manifest.version })
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
  // Direct links live outside the store.
  let direct = []
  try {
    direct = readdirSync(root, { withFileTypes: true })
  } catch {
    direct = []
  }
  for (const entry of direct.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = readdirSync(join(root, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const inner of scoped) {
        if (!inner.isDirectory() && !inner.isSymbolicLink()) continue
        add(`${entry.name}/${inner.name}`, readJSON(join(root, entry.name, inner.name, 'package.json')))
      }
    } else {
      add(entry.name, readJSON(join(root, entry.name, 'package.json')))
    }
  }
  return packages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
}

export function fingerprint(dshHome) {
  const selection = join(dshHome, 'runtime', 'selection')
  let active = null
  let previous = null
  try {
    const [first, second] = readFileSync(selection, 'utf8').trim().split(/\s+/)
    active = first ?? null
    previous = second ?? null
  } catch {}

  const profilesDir = join(dshHome, 'profiles')
  const profiles = []
  let names = []
  try {
    names = readdirSync(profilesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {}
  for (const name of names.sort()) {
    const dir = join(profilesDir, name)
    const files = {}
    for (const file of PROFILE_FILES) {
      const digest = sha256File(join(dir, file))
      if (digest) files[file] = digest
    }
    const packages = installedPackages(dir)
    const digest = createHash('sha256')
    digest.update(JSON.stringify({ files, packages }))
    profiles.push({ name, files, packages: packages.length, digest: digest.digest('hex'), size: tree(dir) })
  }

  const versions = []
  try {
    for (const entry of readdirSync(join(dshHome, 'runtime', 'versions'), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) versions.push(entry.name)
    }
  } catch {}

  return { active, previous, versions: versions.sort(), profiles }
}

// Compares persistent state only. The DSH selection is deliberately excluded:
// a switch always changes it, and migration detection must answer "did the
// upgrade rewrite Profile data", not "did the pointer move".
export function diff(before, after) {
  const changes = []
  const beforeProfiles = new Map(before.profiles.map(profile => [profile.name, profile]))
  const afterProfiles = new Map(after.profiles.map(profile => [profile.name, profile]))
  for (const [name, profile] of afterProfiles) {
    const prior = beforeProfiles.get(name)
    if (!prior) {
      changes.push({ field: `profile ${name}`, before: null, after: profile.digest })
      continue
    }
    if (prior.digest !== profile.digest) {
      const files = []
      for (const file of new Set([...Object.keys(prior.files), ...Object.keys(profile.files)])) {
        if (prior.files[file] !== profile.files[file]) files.push(file)
      }
      changes.push({ field: `profile ${name}`, before: prior.digest, after: profile.digest, files })
    }
  }
  for (const [name, profile] of beforeProfiles) {
    if (!afterProfiles.has(name)) changes.push({ field: `profile ${name}`, before: profile.digest, after: null })
  }
  return changes
}

function flags(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) continue
    const next = argv[index + 1]
    parsed[argv[index].slice(2)] = next === undefined || next.startsWith('--') ? true : argv[++index]
  }
  return parsed
}

function streamDigest(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2)
  const options = flags(rest)
  const home = options['dsh-home'] ?? process.env.DSH_HOME

  try {
    if (command === 'fingerprint') {
      console.log(JSON.stringify(fingerprint(home), null, 2))
    } else if (command === 'probe-links') {
      rebaseProbeLinks(home, options.copy)
    } else if (command === 'diff') {
      const before = JSON.parse(readFileSync(options.before, 'utf8'))
      const after = JSON.parse(readFileSync(options.after, 'utf8'))
      const changes = diff(before, after)
      console.log(JSON.stringify({ changed: changes.length > 0, changes }, null, 2))
      process.exitCode = changes.length > 0 ? 10 : 0
    } else if (command === 'manifest') {
      const state = fingerprint(home)
      // A tag is mutable, so record digests of the Runtime's own files too.
      // Together with image, node and pnpm they identify the image well enough
      // to reproduce the environment the data belongs to.
      const runtimeManager = options.manager ? sha256File(options.manager) : null
      const runtimeWeb = options.web ? sha256File(options.web) : null
      const manifest = {
        format: 1,
        backup: options.backup,
        createdAt: new Date().toISOString(),
        archive: options.archive,
        archiveSha256: await streamDigest(options.archive),
        archiveSize: statSync(options.archive).size,
        runtime: {
          image: options['runtime-image'] ?? null,
          node: process.versions.node,
          pnpm: options.pnpm ?? null,
          manager: runtimeManager,
          web: runtimeWeb,
          // tar records the numeric owner; a restore as another user would
          // leave the restored tree unreadable, so the ids are part of the
          // matched set.
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          gid: typeof process.getgid === 'function' ? process.getgid() : null,
        },
        dsh: { active: state.active, previous: state.previous, installed: state.versions },
        state,
        note: options.note ?? null,
      }
      writeFileSync(options.output, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ manifest: options.output, backup: manifest.backup, archiveSha256: manifest.archiveSha256 }))
    } else if (command === 'verify') {
      const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'))
      const digest = await streamDigest(options.archive)
      const problems = []
      if (manifest.format !== 1) problems.push(`unsupported manifest format ${manifest.format}`)
      if (digest !== manifest.archiveSha256) problems.push('archive checksum does not match the manifest')
      if (statSync(options.archive).size !== manifest.archiveSize) problems.push('archive size does not match the manifest')
      if (problems.length > 0) {
        console.log(JSON.stringify({ ok: false, problems }, null, 2))
        process.exitCode = 1
      } else {
        console.log(JSON.stringify({ ok: true, backup: manifest.backup, active: manifest.dsh.active, createdAt: manifest.createdAt }, null, 2))
      }
    } else if (command === 'record') {
      // Append one audit record from a file, so a record larger than the
      // command-line limit still works. The file is removed after it is read.
      const entry = JSON.parse(readFileSync(options['json-file'], 'utf8'))
      writeFileSync(options.append, JSON.stringify(entry) + '\n', { flag: 'a', mode: 0o600 })
      rmSync(options['json-file'], { force: true })
      console.log(JSON.stringify({ recorded: entry.phase }))
    } else {
      console.error('usage: state.mjs {fingerprint|probe-links|diff|manifest|verify|record}')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(`state: ${error.message}`)
    process.exitCode = 2
  }
}
