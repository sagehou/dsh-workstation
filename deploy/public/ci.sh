#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/../.."
bash deploy/public/init.sh workstation.test ci@example.test
compose() { docker compose --env-file .env.public "$@"; }
trap 'compose down --volumes --remove-orphans' EXIT
compose config -q
compose build auth runtime provider
