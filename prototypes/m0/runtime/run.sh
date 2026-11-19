#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dsh-m0-runtime}"

compose() { docker compose -f compose.yml "$@"; }
run() {
  echo "+ runtime.sh $*"
  compose exec -T runtime bash /m0/runtime.sh "$@"
}
trap 'compose down --volumes --remove-orphans' EXIT

base=0.2.2-rc.1
alternate=0.2.2-rc.5
compose up -d --build
run info
run install "$base"
run select "$base"
run plugins
run health
before="$(run fingerprint)"
printf '%s\n' "$before"
original="$(compose ps -q runtime)"
image="$(docker inspect -f '{{.Image}}' "$original")"
echo "runtime image: $image"
compose rm -sf runtime
compose up -d --no-build runtime
recreated="$(compose ps -q runtime)"
test "$original" != "$recreated"
test "$image" = "$(docker inspect -f '{{.Image}}' "$recreated")"
echo "container recreated: image unchanged"
test "$before" = "$(run fingerprint)"
run health
run install "$alternate"
both="$(run fingerprint)"
if run select "$alternate" fail-readiness; then exit 1; fi
run health
if run install 0.0.0; then exit 1; fi
run health
run select "$alternate" plugin
test "$both" = "$(run fingerprint)"
run select "$base" plugin
test "$both" = "$(run fingerprint)"
test "$image" = "$(docker inspect -f '{{.Image}}' "$(compose ps -q runtime)")"
echo "runtime/plugins: tested both DSH versions, recreation and two rollback paths on one image"
