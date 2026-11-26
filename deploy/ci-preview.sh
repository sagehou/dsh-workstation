#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/.."
compose() { docker compose -f compose.preview.yml "$@"; }
tool() { compose run --rm --no-deps -T maintenance "$@"; }
trap 'compose down --volumes --remove-orphans' EXIT

compose up -d --build --wait --wait-timeout 360
node deploy/check-preview.mjs
compose exec -T runtime sh -ec 'printf preview > /workspace/.persistence'
first="$(compose ps -q runtime)"
image="$(docker inspect --format '{{.Image}}' "$first")"
# Exercise the lock across the Runtime and the independent maintenance container.
backup="$(tool backup)"
id="$(sed -n 's/^Backup id: //p' <<<"$backup")"
test -n "$id"
tool check "$id"
for action in upgrade select rollback restore; do
  target=0.2.2-rc.5
  if [[ $action == restore ]]; then target="$id"; fi
  if output="$(tool "$action" "$target" 2>&1)"; then
    echo "$action was allowed while DSH was serving" >&2
    exit 1
  fi
  grep -F 'runtime is serving or being modified' <<<"$output"
done
tool status | grep -Fx 'Active: 0.2.2-rc.1'

compose stop runtime
tool install 0.2.2-rc.5
if tool select 0.0.0; then
  echo 'An uninstalled version was selected' >&2
  exit 1
fi
tool status | grep -Fx 'Active: 0.2.2-rc.1'
tool select 0.2.2-rc.5
tool status | grep -Fx 'Active: 0.2.2-rc.5'
tool rollback
tool status | grep -Fx 'Active: 0.2.2-rc.1'
compose up -d --force-recreate --no-build --wait --wait-timeout 360 runtime
node deploy/check-preview.mjs
test "$(compose exec -T runtime cat /workspace/.persistence)" = preview
test "$(compose ps -q runtime)" != "$first"
test "$(docker inspect --format '{{.Image}}' "$(compose ps -q runtime)")" = "$image"
echo 'Preview: online backup and verification, offline maintenance enforced, version switch, rollback and recreation on one image'
