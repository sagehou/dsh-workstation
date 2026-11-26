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
# A backup only reads, so it must work while DSH serves — the management page is
# by definition used then, and refusing it made that page useless. An upgrade
# rewrites DSH_HOME and must still be refused.
if ! tool backup; then
  echo 'A backup was refused while DSH was serving, but it only reads' >&2
  exit 1
fi
if tool upgrade 0.2.2-rc.5; then
  echo 'An upgrade was allowed while DSH was serving' >&2
  exit 1
fi

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
echo 'Preview: read-only maintenance while serving, upgrade refused, version switch, rollback and recreation on one image'
