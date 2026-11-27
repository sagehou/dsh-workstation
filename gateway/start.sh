#!/bin/bash
set -euo pipefail

if [[ ${1:-serve} != serve || ${GATEWAY_BROWSER_ENABLED:-${AUTH_BROWSER_ENABLED:-1}} == 0 ]]; then
  exec workstation-gateway "$@"
fi

supervise() {
  child=
  stop_worker() {
    if [[ -n $child ]]; then
      kill "$child" 2>/dev/null || true
      wait "$child" || true
    fi
    exit 0
  }
  trap stop_worker INT TERM
  while true; do
    node "$1" &
    child=$!
    wait "$child" || true
    child=
    sleep 2
  done
}

supervise /opt/workstation/gate/server.mjs &
gate=$!
supervise /opt/workstation/provider/cdp.mjs &
provider=$!
workstation-gateway "$@" &
gateway=$!

stop_all() {
  kill "$gateway" "$provider" "$gate" 2>/dev/null || true
  wait "$gateway" "$provider" "$gate" || true
}
trap stop_all EXIT
trap 'exit 0' INT TERM
wait "$gateway"
