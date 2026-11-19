#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
docker build --target sidebar --tag dsh-m0-sidebar .
docker run --init --rm dsh-m0-sidebar node /m0/sidebar/run.mjs
