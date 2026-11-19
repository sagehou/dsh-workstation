#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/../browser"
export COMPOSE_PROJECT_NAME=dsh-m0-provider
scratch="$(mktemp -d)"
export M0_MASTER_FILE="$scratch/master" M0_CONTROLLER_FILE="$scratch/controller"
export M0_SENTINEL_FILE="$scratch/sentinel" M0_ADMIN_FILE="$scratch/admin"
for secret in "$M0_MASTER_FILE" "$M0_CONTROLLER_FILE" "$M0_SENTINEL_FILE" "$M0_ADMIN_FILE"; do
  openssl rand -hex 32 | tr -d '\n' > "$secret"
  chmod 444 "$secret"
done
files=(-f compose.yml -f compose.exclusive.yml -f ../provider/compose.yml)
compose() { docker compose "${files[@]}" "$@"; }
cleanup() {
  compose down --volumes --remove-orphans
  rm -rf -- "$scratch"
}
trap cleanup EXIT
compose build provider dsh viewer
compose run --rm --no-deps --no-build -T install-dsh
compose up --no-build -d fixture witness chromium cdp-relay edge provider dsh viewer

for service in chromium cdp-relay provider edge dsh; do
  test -z "$(docker port "$(compose ps -q "$service")")"
done
cdp_net="$(docker network inspect dsh-m0-provider_cdp --format '{{range .Containers}}{{println .Name}}{{end}}' | sort)"
diff -u <(printf '%s\n' dsh-m0-provider-chromium-1 dsh-m0-provider-provider-1) <(printf '%s\n' "$cdp_net")
node ../provider/run.mjs "${files[@]}"
