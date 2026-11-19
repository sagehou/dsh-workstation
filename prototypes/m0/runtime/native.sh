#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -ne 0
test -f /usr/local/include/node/node.h
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
echo '{"private":true}' > package.json
npm install --ignore-scripts --no-audit --no-fund --save-exact node-pty@1.2.0-beta.15 node-gyp@11.5.0
rm -rf node_modules/node-pty/prebuilds
node node_modules/node-gyp/bin/node-gyp.js rebuild --directory node_modules/node-pty --nodedir=/usr/local
test -f node_modules/node-pty/build/Release/pty.node
node --input-type=commonjs <<'JS'
const assert = require('node:assert/strict')
const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf m0-native'], { cols: 40, rows: 8 })
let output = ''
const timeout = setTimeout(() => { pty.kill(); process.exit(1) }, 5000)
pty.onData(data => { output += data })
pty.onExit(({ exitCode }) => {
  clearTimeout(timeout)
  assert.equal(exitCode, 0)
  assert.equal(output, 'm0-native')
  assert(Object.keys(require.cache).some(path => path.endsWith('/build/Release/pty.node')))
  console.log(`source-built node-pty emitted expected PTY output as uid ${process.getuid()}`)
})
JS
