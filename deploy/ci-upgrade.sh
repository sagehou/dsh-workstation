#!/usr/bin/env bash
# Transactional upgrade and matched-data-restore drill.
#
# The unit tests and runtime/test/e2e-upgrade.sh already prove the transaction
# logic in isolation. This drill proves the parts that only a real container
# can: that the Runtime image boots candidates, that volumes survive the
# switch, that a restored DSH_HOME serves again after recreation, and that a
# previous Runtime image can be brought back with the restored data.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/.."
compose() { docker compose -f compose.preview.yml "$@"; }
tool() { compose run --rm --no-deps -T maintenance "$@"; }
in_image() { compose run --rm --no-deps -T --entrypoint sh maintenance -ec "$1"; }
active() { tool status | sed -n 's/^Active: //p'; }
trap 'compose down --volumes --remove-orphans' EXIT

pass() { printf 'upgrade-drill %s: %s\n' "$1" "$2"; }
fail() { printf 'upgrade-drill %s FAILED: %s\n' "$1" "$2" >&2; exit 1; }
expect() { [[ $2 == "$3" ]] || fail "$1" "expected $3, got $2"; }

FROM=0.2.2-rc.1
TO=0.2.2-rc.5
INTERNAL=/dsh-home/profiles/web

# A hosted runner can still hold a previous run's project, and Docker then
# fails the static-IP attach with "Address already in use". That is host state,
# not the drill's subject, so clean first and retry the initial bring-up.
compose down --volumes --remove-orphans >/dev/null 2>&1 || true
attempt=1
until compose up -d --build --wait --wait-timeout 360; do
  attempt=$(( attempt + 1 ))
  (( attempt <= 3 )) || fail initial 'the preview did not come up after 3 attempts'
  printf 'upgrade-drill initial: retrying the stack bring-up (%s/3)\n' "$attempt" >&2
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  sleep 5
done
node deploy/check-preview.mjs || fail initial 'the preview did not become ready'
first_image="$(docker inspect --format '{{.Image}}' "$(compose ps -q runtime)")"
first_container="$(compose ps -q runtime)"
# Freeze the exact image so an image rollback can recreate without a rebuild.
docker tag "$first_image" dsh-workstation-runtime:rollback-drill
compose exec -T runtime sh -ec 'printf workspace-v1 > /workspace/.persistence'
pass initial 'preview ready; Runtime image captured for the image-rollback step'

# 1. An installed Profile bundle that pins another DSH version blocks the
#    switch. This is the real production constraint: the Workstation Bundle
#    declares engines.dsh, so DSH cannot move without a matching Bundle.
# Save the real Profile manifest first, so the drill can put it back after the
# synthetic cases and the readiness probe runs against real data.
in_image 'cp -a '"$INTERNAL"'/package.json /dsh-home/.drill-package.json 2>/dev/null || printf %s "{}" > /dsh-home/.drill-package.json'
in_image '
  mkdir -p '"$INTERNAL"'/node_modules/dsh-drill-pin
  printf %s "{\"name\":\"dsh-drill-pin\",\"version\":\"1.0.0\",\"engines\":{\"dsh\":\"'"$FROM"'\"}}" \
    > '"$INTERNAL"'/node_modules/dsh-drill-pin/package.json
  printf %s "{\"name\":\"web\",\"dependencies\":{\"dsh-drill-pin\":\"1.0.0\"}}" > '"$INTERNAL"'/package.json
'
# Remove the candidate if an earlier drill left it installed, so this step
# proves a blocked upgrade still installs the candidate beside the active one.
in_image 'rm -rf /dsh-home/runtime/versions/'"$TO"
compose stop runtime
tool upgrade "$TO" >/tmp/blocked.log 2>&1 && fail compat 'a bundle pinning another DSH did not block the upgrade'
grep -q "requires DSH $FROM" /tmp/blocked.log || fail compat "unexpected refusal: $(cat /tmp/blocked.log)"
expect compat "$(active)" "$FROM"
tool status | grep -qx "Installed: $TO" || fail compat 'the candidate must be installed beside the active version'
in_image '! test -f /dsh-home/runtime/audit.jsonl || ! grep -q switched /dsh-home/runtime/audit.jsonl' ||
  fail compat 'a blocked upgrade recorded a switch'
pass compat "a bundle pinning $FROM blocked $TO; the pointer and the audit log are unchanged"

# 2. Unapproved Profile lifecycle scripts block by exact package identity.
in_image '
  rm -rf '"$INTERNAL"'/node_modules/dsh-drill-pin
  printf %s "{\"name\":\"web\",\"dependencies\":{}}" > '"$INTERNAL"'/package.json
  mkdir -p '"$INTERNAL"'/node_modules/native-drill
  printf %s "{\"name\":\"native-drill\",\"version\":\"1.0.0\",\"scripts\":{\"postinstall\":\"node-gyp rebuild\"}}" \
    > '"$INTERNAL"'/node_modules/native-drill/package.json
'
tool upgrade "$TO" >/tmp/scripts.log 2>&1 && fail scripts 'an unapproved postinstall did not block the upgrade'
grep -q 'native-drill@1.0.0 declares postinstall' /tmp/scripts.log || fail scripts "unexpected refusal: $(cat /tmp/scripts.log)"
expect scripts "$(active)" "$FROM"
pass scripts 'an unapproved postinstall blocked the switch by package name'

# 3. Approving exactly that package version clears the gate. The synthetic
#    package is then removed before the real upgrade, so the DSH readiness
#    probe runs against a Profile that contains only real packages.
tool approve native-drill@1.0.0 >/tmp/approve.log 2>&1 || fail approve "approval failed: $(cat /tmp/approve.log)"
if tool approve 'native-drill@^1.0.0' >/dev/null 2>&1; then
  fail approve 'a semver range was accepted as an approval'
fi
if tool approve 'native-drill@1.0.0extra' >/dev/null 2>&1; then
  fail approve 'a suffixed version was accepted as an approval'
fi
tool compat "$TO" >/tmp/compat.log 2>&1 || fail approve "the approval did not clear the gate: $(cat /tmp/compat.log)"
grep -q '0 unapproved' /tmp/compat.log || fail approve 'the gate still reported an unapproved script'
in_image '
  rm -rf '"$INTERNAL"'/node_modules/native-drill
  if [[ -f /dsh-home/.drill-package.json ]]; then cp -a /dsh-home/.drill-package.json '"$INTERNAL"'/package.json; fi
'
pass approve 'an exact package@version approval cleared the gate; a range and a suffix were refused'

# 3b. The real upgrade runs against the real Profile.
upgrade_out="$(tool upgrade "$TO" 2>&1)" || fail upgrade "the approved upgrade failed: $upgrade_out"
expect upgrade "$(active)" "$TO"
backup_id="$(printf '%s\n' "$upgrade_out" | sed -n 's/^Backup id: //p')"
[[ -n $backup_id ]] || fail upgrade "no backup id was recorded: $upgrade_out"
printf '%s\n' "$upgrade_out" | grep -q '^Manifest: .*\.json' || fail upgrade 'no manifest was written'
pass upgrade "switched to $TO with backup $backup_id"

# 4. The backup carries matched metadata: Runtime image, DSH version, checksum.
tool backups | grep -q "$backup_id" || fail backup 'the backup is not listed'
in_image '
  node -e "
    const m = JSON.parse(require(\"node:fs\").readFileSync(\"/backup/dsh-home.'"$backup_id"'.json\", \"utf8\"))
    if (!m.runtime.image || m.runtime.image === \"unpinned\") throw Error(\"no runtime image\")
    if (!m.runtime.manager || !m.runtime.web) throw Error(\"no runtime file digests\")
    if (m.runtime.uid !== 1000) throw Error(\"unexpected runtime uid \" + m.runtime.uid)
    if (m.dsh.active !== \"'"$FROM"'\") throw Error(\"wrong pre-upgrade version: \" + m.dsh.active)
    if (!m.archiveSha256 || !m.archiveSize) throw Error(\"no archive checksum\")
    if (m.format !== 1) throw Error(\"unexpected format\")
  "
' || fail backup 'the manifest is missing the image, the pre-upgrade version or the checksum'
# 4a. The archive must exclude the reinstallable caches. Measured on a real
#     install the pnpm store was 869 MB and inflated the archive to 223 MB,
#     while the actual Profile data was 40 KB.
in_image '
  tar -tzf /backup/dsh-home.'"$backup_id"'.tgz > /tmp/contents
  ! grep -qx "./runtime/" /tmp/contents || { echo "./runtime must be excluded" >&2; exit 1; }
  ! grep -q "^./pnpm/" /tmp/contents || { echo "./pnpm must be excluded" >&2; exit 1; }
  grep -q "^./profiles/" /tmp/contents || { echo "./profiles must be included" >&2; exit 1; }
' || fail backup 'the archive does not contain exactly the restorable state'
pass backup 'the archive keeps Profile data and excludes installed versions and the pnpm store'

# 4b. `check` must prove usability without restoring anything.
tool check "$backup_id" >/tmp/check.log 2>&1 || fail backup "check failed: $(cat /tmp/check.log)"
grep -q '"ok": true' /tmp/check.log || fail backup 'check did not confirm the archive'
grep -q "restores DSH $FROM" /tmp/check.log || fail backup 'check did not report the recorded DSH version'
pass backup 'check verified the archive and named the recorded DSH version without restoring'

# 5. The new version must actually boot and serve, then report whether it
#    migrated Profile state.
compose up -d --no-build --wait --wait-timeout 360 runtime || fail restart "$TO did not become ready"
node deploy/check-preview.mjs || fail restart "$TO did not serve"
expect restart "$(compose exec -T runtime cat /workspace/.persistence)" workspace-v1
compose stop runtime
verify_out="$(tool verify 2>&1)" || fail verify "verify failed: $verify_out"
if printf '%s\n' "$verify_out" | grep -q MIGRATED; then observed=migrated; else observed=unchanged; fi
printf '%s\n' "$verify_out"
pass verify "$FROM -> $TO left Profile state $observed (observed, not assumed)"

# 6. A changed Profile lockfile must be detected and point at the backup.
#    Synthetic: it proves detection and restore, not that DSH migrates.
compose up -d --no-build --wait --wait-timeout 360 runtime
compose exec -T runtime sh -ec 'printf "# drill migration\n" >> '"$INTERNAL"'/pnpm-lock.yaml'
compose stop runtime
after="$(tool verify 2>&1)"
printf '%s\n' "$after" | grep -q MIGRATED || fail detect "a changed lockfile was not reported as migrated: $after"
printf '%s\n' "$after" | grep -q "dsh-runtime restore $backup_id" || fail detect 'verify did not name the matched backup'
pass detect 'a changed Profile lockfile was reported as MIGRATED with the matched backup'

# 7. Pointer rollback changes the executable only, never the data.
tool rollback >/tmp/rollback.log 2>&1 || fail pointer "rollback failed: $(cat /tmp/rollback.log)"
grep -qi 'changes only the selected executable' /tmp/rollback.log || fail pointer 'the pointer rollback did not state its scope'
expect pointer "$(active)" "$FROM"
in_image 'grep -q "# drill migration" '"$INTERNAL"'/pnpm-lock.yaml' ||
  fail pointer 'the pointer rollback silently reverted data'
pass pointer "active returned to $FROM while the migrated data stayed in place"

# 8. A matched data restore returns the pre-migration Profile state.
tool restore "$backup_id" >/tmp/restore.log 2>&1 || fail restore "restore failed: $(cat /tmp/restore.log)"
expect restore "$(active)" "$FROM"
in_image '! grep -q "# drill migration" '"$INTERNAL"'/pnpm-lock.yaml' || fail restore 'the migration marker survived'
pass restore "restored $backup_id and removed the simulated migration"

# 8b. The restore must not delete what the archive never contained: the
#     installed versions, the pnpm store, and the audit log under runtime.
in_image 'test -d /dsh-home/pnpm/store && test -s /dsh-home/runtime/audit.jsonl &&
  test -x /dsh-home/runtime/versions/'"$FROM"'/node_modules/.bin/dsh' ||
  fail restore 'the restore removed a reinstallable cache or the audit log'
pass restore 'the restore kept the pnpm store, installed versions and audit log'

# 9. A tampered archive and an unknown id are refused without touching state.
# Backups are written read-only, so tampering means granting write access
# first. That is also why a real archive cannot be edited by accident.
in_image '
  cp /backup/dsh-home.'"$backup_id"'.tgz /backup/dsh-home.tampered.tgz
  chmod u+w /backup/dsh-home.tampered.tgz
  printf x >> /backup/dsh-home.tampered.tgz
  cp /backup/dsh-home.'"$backup_id"'.json /backup/dsh-home.tampered.json
'
tool restore tampered >/tmp/tampered.log 2>&1 && fail refuse 'a tampered archive was restored'
grep -q 'failed verification' /tmp/tampered.log || fail refuse "unexpected refusal: $(cat /tmp/tampered.log)"
tool restore does-not-exist >/tmp/missing.log 2>&1 && fail refuse 'an unknown backup id was accepted'
grep -q 'no backup archive' /tmp/missing.log || fail refuse "unexpected refusal: $(cat /tmp/missing.log)"
pass refuse 'a tampered archive and an unknown backup id were both refused'

# 10. The restored state serves after recreation, on the same Runtime image.
compose up -d --no-build --force-recreate --wait --wait-timeout 360 runtime ||
  fail serve 'the restored state did not become ready'
node deploy/check-preview.mjs || fail serve 'the restored state did not serve'
expect serve "$(compose exec -T runtime cat /workspace/.persistence)" workspace-v1
[[ $(compose ps -q runtime) != "$first_container" ]] || fail serve 'the runtime container was not recreated'
pass serve 'restored DSH_HOME served again after recreation'

# 11. The previous Runtime image plus the restored data and selection.
compose stop runtime
WORKSTATION_RUNTIME_IMAGE=dsh-workstation-runtime:rollback-drill \
  docker compose -f compose.preview.yml up -d --no-build --force-recreate --wait --wait-timeout 360 runtime ||
  fail combined 'the captured image did not restart'
node deploy/check-preview.mjs || fail combined 'the captured image did not serve the restored data'
expect combined "$(active)" "$FROM"
expect combined "$(docker inspect --format '{{.Image}}' "$(compose ps -q runtime)")" "$first_image"
pass combined 'image recreation kept the restored data and the restored selection'

# 12. The audit trail must describe the transaction without credentials.
phases="$(in_image 'cat /dsh-home/runtime/audit.jsonl 2>/dev/null || true')"
for phase in start switched verified pointer-rollback restored script-approved; do
  printf '%s\n' "$phases" | grep -q "\"phase\":\"$phase\"" || fail audit "no $phase record"
done
printf '%s\n' "$phases" | grep -qiE 'password|totp|secret|api[_-]?key' && fail audit 'credential-like fields in the audit log'
pass audit 'start, switch, verify, pointer rollback, restore and approval are recorded without credentials'

# Collect the evidence before the EXIT trap tears the stack down, because the
# archive and audit trail only exist inside the volumes.
mkdir -p evidence
in_image 'cat /dsh-home/runtime/audit.jsonl 2>/dev/null || true' > evidence/upgrade-audit.jsonl || true
in_image 'cat /backup/dsh-home.*.json 2>/dev/null || true' > evidence/upgrade-manifests.json || true
in_image 'dsh-runtime status; dsh-runtime backups' > evidence/upgrade-final-status.txt || true

printf 'upgrade-drill OK: compatibility gate, backup manifest, migration detection, pointer vs data rollback, restore, recreation and image rollback\n'
