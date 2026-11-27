#!/usr/bin/env bash
# Local end-to-end exercise of dsh-runtime's transaction logic.
#
# Docker is unavailable in some environments, and the DSH readiness probe needs
# a real DSH install. This harness runs the real script with:
#   - a temporary DSH_HOME and backup root,
#   - a stub `node` that satisfies the readiness probe for selected versions,
#   - a stub `pnpm` that materialises plausible version directories.
# It therefore proves the pointer/backup/restore mechanics, not DSH readiness.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
repo="$(cd -- .. && pwd)"
work="$(mktemp -d /tmp/dsh-runtime-e2e.XXXXXXXX)"
web_pid=
cleanup() {
  if [[ -n $web_pid ]]; then
    kill "$web_pid" 2>/dev/null || true
    wait "$web_pid" || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

home="$work/dsh-home"
backup="$work/backup"
stubs="$work/bin"
mkdir -p "$home/runtime/versions" "$backup" "$stubs" "$home/profiles/web"

pass() { printf 'runtime e2e %s: %s\n' "$1" "$2"; }
fail() { printf 'runtime e2e %s FAILED: %s\n' "$1" "$2" >&2; exit 1; }
expect() { [[ $2 == "$3" ]] || fail "$1" "expected $3, got $2"; }

# --- stubs -------------------------------------------------------------------
# pnpm materialises a version directory with a CLI that reports its version.
cat > "$stubs/pnpm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --version ]]; then printf '11.28.5\n'; exit 0; fi
if [[ ${1:-} == view ]]; then printf '["0.2.2-rc.1","0.2.2-rc.5"]\n'; exit 0; fi
dir=
pkg=
args=("$@")
while [[ $# -gt 0 ]]; do
  case $1 in
    --dir) dir=$2; shift 2 ;;
    @deepseek-ai/dsh@*) pkg=${1#@deepseek-ai/dsh@}; shift ;;
    *) shift ;;
  esac
done
[[ -n $dir && -n $pkg ]] || { echo "stub pnpm: cannot parse invocation: ${args[*]}" >&2; exit 2; }
mkdir -p "$dir/node_modules/.bin" "$dir/node_modules/@deepseek-ai/dsh"
printf '{"name":"@deepseek-ai/dsh","version":"%s","engines":{"node":">=24.9.0"}}\n' "$pkg" \
  > "$dir/node_modules/@deepseek-ai/dsh/package.json"
printf '{"name":"dsh-workstation-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"%s"}}\n' "$pkg" > "$dir/package.json"
cat > "$dir/node_modules/.bin/dsh" <<CLI
#!/usr/bin/env bash
if [[ \${1:-} == --version ]]; then printf '%s\n' '$pkg'; else printf 'dsh $pkg\n'; fi
CLI
chmod +x "$dir/node_modules/.bin/dsh"
STUB
chmod +x "$stubs/pnpm"

# node must serve the modules the script invokes and also the readiness probe.
# Real node is correct for the module calls; only `web.mjs probe` is stubbed.
real_node="$(command -v node)"
cat > "$stubs/node" <<STUB
#!/usr/bin/env bash
# Only the readiness probe is stubbed. It is the *script* argument, so match
# that position; state.mjs and compat.mjs also name web.mjs on their command
# lines and must still run for real.
if [[ \${1:-} == */web.mjs && \${2:-} == probe ]]; then
  exit 0
fi
if [[ \${1:-} == */web.mjs && \${2:-} == serve && -n \${DSH_TEST_WEB_READY:-} ]]; then
  trap 'exit 0' TERM
  touch "\$DSH_TEST_WEB_READY"
  while :; do sleep 0.1; done
fi
exec "$real_node" "\$@"
STUB
chmod +x "$stubs/node"

runtime="$repo/runtime/dsh-runtime"
export PATH="$stubs:$PATH" DSH_HOME="$home" DSH_RUNTIME_LIB="$repo/runtime" WORKSTATION_RUNTIME_IMAGE="sha256:drill-local"
# Point the backup root at the scratch directory.
export DSH_BACKUP_DIR="$backup"

runtime_cmd() {
  DSH_HOME="$home" DSH_RUNTIME_LIB="$repo/runtime" PATH="$stubs:$PATH" \
  WORKSTATION_RUNTIME_IMAGE="sha256:drill-local" DSH_BACKUP_DIR="$backup" \
  bash "$runtime" "$@"
}

# Seed a Profile with one bundle pinned to the initial version.
printf '{"name":"web","dependencies":{"dsh-drill-pin":"1.0.0"}}\n' > "$home/profiles/web/package.json"
printf 'lockfileVersion: 9\n' > "$home/profiles/web/pnpm-lock.yaml"
mkdir -p "$home/profiles/web/node_modules/dsh-drill-pin"
printf '{"name":"dsh-drill-pin","version":"1.0.0","engines":{"dsh":"0.2.2-rc.1"}}\n' \
  > "$home/profiles/web/node_modules/dsh-drill-pin/package.json"

# --- 1. install and initial selection ---------------------------------------
runtime_cmd install 0.2.2-rc.1 >/dev/null || fail install 'initial install failed'
runtime_cmd select 0.2.2-rc.1 >/dev/null || fail install 'initial select failed'
expect install "$(runtime_cmd status | sed -n 's/^Active: //p')" 0.2.2-rc.1
pass install 'installed and selected 0.2.2-rc.1 with a pinned bundle in place'

env -u MAINTENANCE_ADDR DSH_TEST_WEB_READY="$work/web-ready" bash "$runtime" serve &
web_pid=$!
for ((attempt=0; attempt<50; attempt++)); do
  [[ -f $work/web-ready ]] && break
  sleep 0.1
done
[[ -f $work/web-ready ]] || fail locking 'the Web supervisor did not start'
online_backup="$(runtime_cmd backup)"
online_id="$(sed -n 's/^Backup id: //p' <<<"$online_backup")"
runtime_cmd check "$online_id" >/dev/null
for action in upgrade select rollback restore; do
  target=0.2.2-rc.5
  if [[ $action == restore ]]; then target="$online_id"; fi
  if output="$(runtime_cmd "$action" "$target" 2>&1)"; then
    fail locking "$action was allowed while serving"
  fi
  [[ $output == *'runtime is serving or being modified'* ]] || fail locking "unexpected refusal: $output"
done
expect locking "$(runtime_cmd status | sed -n 's/^Active: //p')" 0.2.2-rc.1
[[ ! -e $home/runtime/versions/0.2.2-rc.5 ]] || fail locking 'the blocked upgrade modified the installation'
kill "$web_pid"
wait "$web_pid"
web_pid=
pass locking 'Web and an online backup coexist; independent write commands are refused until Web exits'

# --- 2. a bundle that pins another DSH blocks the switch --------------------
if runtime_cmd upgrade 0.2.2-rc.5 >"$work/blocked.log" 2>&1; then
  fail compat 'the upgrade was allowed although a bundle pins another DSH'
fi
grep -q 'requires DSH 0.2.2-rc.1' "$work/blocked.log" || fail compat "unexpected refusal: $(cat "$work/blocked.log")"
expect compat "$(runtime_cmd status | sed -n 's/^Active: //p')" 0.2.2-rc.1
grep -qx 'Installed: 0.2.2-rc.5' <(runtime_cmd status) || fail compat 'the candidate must be installed beside the active version'
pass compat 'a Profile bundle pinning 0.2.2-rc.1 blocked 0.2.2-rc.5 and left the pointer alone'

# --- 3. unapproved lifecycle scripts block, approval unblocks --------------
rm -rf "$home/profiles/web/node_modules/dsh-drill-pin"
printf '{"name":"web","dependencies":{}}\n' > "$home/profiles/web/package.json"
mkdir -p "$home/profiles/web/node_modules/native-drill"
printf '{"name":"native-drill","version":"1.0.0","scripts":{"postinstall":"node-gyp rebuild"}}\n' \
  > "$home/profiles/web/node_modules/native-drill/package.json"
if runtime_cmd upgrade 0.2.2-rc.5 >"$work/scripts.log" 2>&1; then
  fail scripts 'the upgrade was allowed with an unapproved postinstall'
fi
grep -q 'native-drill@1.0.0 declares postinstall' "$work/scripts.log" || fail scripts "unexpected refusal: $(cat "$work/scripts.log")"
runtime_cmd approve native-drill@1.0.0 >/dev/null || fail scripts 'approving the exact package failed'
grep -qx 'native-drill@1.0.0' "$home/approved-scripts.txt" || fail scripts 'the approval was not recorded in DSH_HOME'
# An approval must name an exact version, not a range or a bare name.
if runtime_cmd approve native-drill >/dev/null 2>&1; then
  fail scripts 'a bare package name was accepted as an approval'
fi
if runtime_cmd approve 'native-drill@^1.0.0' >/dev/null 2>&1; then
  fail scripts 'a range was accepted as an approval'
fi
if runtime_cmd approve 'native-drill@1.0.0extra' >/dev/null 2>&1; then
  fail scripts 'a suffixed version was accepted as an approval'
fi
if runtime_cmd approve 'native-drill@1.0.0@2.0.0' >/dev/null 2>&1; then
  fail scripts 'two versions were accepted as one approval'
fi
# A pre-release is a legal exact version and must be accepted.
if ! runtime_cmd approve 'other-thing@2.0.0-rc.1' >/dev/null 2>&1; then
  fail scripts 'a pre-release package@version was refused'
fi
pass scripts 'an unapproved postinstall blocked the switch; only an exact package@version was approved'

# --- 4. restart then upgrade verify ----------------------------------------
runtime_cmd upgrade 0.2.2-rc.5 >"$work/upgrade.log" 2>&1 ||
  fail upgrade "the approved upgrade failed: $(cat "$work/upgrade.log")"
expect upgrade "$(runtime_cmd status | sed -n 's/^Active: //p')" 0.2.2-rc.5
backup_id="$(sed -n 's/^Backup id: //p' "$work/upgrade.log")"
[[ -n $backup_id ]] || fail upgrade "no backup id: $(cat "$work/upgrade.log")"
[[ -f "$backup/dsh-home.$backup_id.json" ]] || fail upgrade 'no manifest was written'
pass upgrade "switched to 0.2.2-rc.5 with backup $backup_id"

# --- 5. verify reports an unchanged state ----------------------------------
runtime_cmd verify >"$work/verify.log" 2>&1 || fail verify "verify failed: $(cat "$work/verify.log")"
grep -q 'unchanged' "$work/verify.log" || fail verify "an untouched Profile was not reported unchanged: $(cat "$work/verify.log")"
grep -q "restore $backup_id\|matched backup is $backup_id" "$work/verify.log" || fail verify 'verify did not name the matched backup'
pass verify 'verify reported unchanged state and named the matched backup'

# --- 6. a migration is detected and points at the backup -------------------
printf '# drill migration\n' >> "$home/profiles/web/pnpm-lock.yaml"
runtime_cmd verify >"$work/verify2.log" 2>&1 || fail detect "verify failed: $(cat "$work/verify2.log")"
grep -q 'MIGRATED' "$work/verify2.log" || fail detect "a changed lockfile was not detected: $(cat "$work/verify2.log")"
grep -q "dsh-runtime restore $backup_id" "$work/verify2.log" || fail detect 'verify did not point at the matched backup'
pass detect 'a Profile lockfile change was reported as MIGRATED with the matching backup'

# --- 6b. restore must preserve the excluded caches ------------------------
# The archive omits pnpm and runtime, so the swap must not delete them. Losing
# the store would only cost a reinstall, but losing runtime would drop the
# audit log and every installed version.
mkdir -p "$home/pnpm/store/fake" && printf 'store-blob' > "$home/pnpm/store/fake/blob"
before_versions="$(ls "$home/runtime/versions" | tr '\n' ' ')"
before_store="$(cat "$home/pnpm/store/fake/blob")"
pass caches 'seeded pnpm store and installed versions before the restore'

# --- 7. pointer rollback does not revert data ------------------------------
runtime_cmd rollback >"$work/rollback.log" 2>&1 || fail pointer "rollback failed: $(cat "$work/rollback.log")"
grep -qi 'changes only the selected executable' "$work/rollback.log" || fail pointer 'the pointer rollback did not state its scope'
expect pointer "$(runtime_cmd status | sed -n 's/^Active: //p')" 0.2.2-rc.1
grep -q '# drill migration' "$home/profiles/web/pnpm-lock.yaml" || fail pointer 'the pointer rollback silently reverted data'
pass pointer 'pointer rollback restored the executable while the migrated data remained'

# --- 8. matched data restore returns the pre-migration state ---------------
runtime_cmd restore "$backup_id" >"$work/restore.log" 2>&1 || fail restore "restore failed: $(cat "$work/restore.log")"
expect restore "$(runtime_cmd status | sed -n 's/^Active: //p')" 0.2.2-rc.1
if grep -q '# drill migration' "$home/profiles/web/pnpm-lock.yaml"; then
  fail restore 'the migration marker survived the restore'
fi
pass restore "restored $backup_id and removed the simulated migration"

# --- 8b. check proves a backup is usable without restoring it -------------
runtime_cmd check "$backup_id" >"$work/check.log" 2>&1 || fail check "check failed: $(cat "$work/check.log")"
grep -q '"ok": true' "$work/check.log" || fail check 'check did not confirm the archive'
grep -q 'restores DSH 0.2.2-rc.1' "$work/check.log" || fail check 'check did not name the recorded version'
pass check 'check verified the archive and reported its DSH version without restoring'

# --- 8c. the restore kept the caches it never archived -------------------
[ "$(ls "$home/runtime/versions" | tr '\n' ' ')" == "$before_versions" ] ||
  fail caches 'the restore removed an installed version'
[ "$(cat "$home/pnpm/store/fake/blob" 2>/dev/null)" == "$before_store" ] ||
  fail caches 'the restore removed the pnpm store'
pass caches 'the restore left installed versions and the pnpm store intact'

# --- 9. tampered archive and unknown id are refused -----------------------
# Backups are written read-only, so the simulated tamper must be granted write
# access first. That is also why a real archive cannot be edited by accident.
cp "$backup/dsh-home.$backup_id.tgz" "$backup/dsh-home.tampered.tgz"
chmod u+w "$backup/dsh-home.tampered.tgz"
printf 'x' >> "$backup/dsh-home.tampered.tgz"
cp "$backup/dsh-home.$backup_id.json" "$backup/dsh-home.tampered.json"
if runtime_cmd restore tampered >"$work/tampered.log" 2>&1; then
  fail refuse 'a tampered archive was restored'
fi
grep -q 'failed verification' "$work/tampered.log" || fail refuse "unexpected refusal: $(cat "$work/tampered.log")"
if runtime_cmd restore nope >"$work/missing.log" 2>&1; then
  fail refuse 'an unknown backup id was accepted'
fi
grep -q 'no backup archive' "$work/missing.log" || fail refuse "unexpected refusal: $(cat "$work/missing.log")"
pass refuse 'a tampered archive and an unknown backup id were refused'

# --- 10. the audit trail records the transaction without credentials -------
for phase in start switched verified pointer-rollback restored script-approved; do
  grep -q "\"phase\":\"$phase\"" "$home/runtime/audit.jsonl" || fail audit "no $phase record"
done
if grep -qiE 'password|totp|secret|api[_-]?key' "$home/runtime/audit.jsonl"; then
  fail audit 'the audit log contains credential-like fields'
fi
pass audit 'start, switch, verify, pointer rollback and restore were recorded without credentials'

# --- 11. an installed-versions restore target must exist -------------------
python3 - "$backup" <<'PY' || fail mismatch 'restore did not require the matching version to be installed'
import hashlib, json, pathlib, sys
backup = pathlib.Path(sys.argv[1])
manifest = sorted(backup.glob('dsh-home.*.json'))[0]
data = json.loads(manifest.read_text())
data['dsh']['active'] = '0.2.2-rc.99'
target = backup / 'dsh-home.mismatch.json'
target.write_text(json.dumps(data))
# Copy the archive so verification passes for the rewritten manifest.
archive = backup / 'dsh-home.mismatch.tgz'
archive.write_bytes(pathlib.Path(str(manifest).replace('.json', '.tgz')).read_bytes())
data['archiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
data['archiveSize'] = archive.stat().st_size
target.write_text(json.dumps(data))
raise SystemExit(0)
PY
if runtime_cmd restore mismatch >"$work/mismatch.log" 2>&1; then
  fail mismatch 'a restore to an uninstalled version was allowed'
fi
grep -q 'is not installed' "$work/mismatch.log" || fail mismatch "unexpected refusal: $(cat "$work/mismatch.log")"
pass mismatch 'a backup whose DSH version is not installed was refused'

printf 'runtime e2e OK: gate, backup, detect, pointer vs data, restore, refusals, audit\n'
