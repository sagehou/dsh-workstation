#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dsh-m0-browser}"
compose() { docker compose -f compose.yml "$@"; }
cleanup() {
  compose down --volumes --remove-orphans
}
trap cleanup EXIT

compose up -d chromium cdp-relay edge fixture
compose build probe
for service in chromium cdp-relay edge; do
  test -z "$(docker port "$(compose ps -q "$service")")"
done
for host in 127.0.0.1:9222 127.0.0.1:9223 172.30.231.2:9223; do
  if curl --noproxy '*' -fsS --max-time 2 "http://$host/json/version" >/dev/null 2>&1; then
    echo "unexpected host CDP access at $host"
    exit 1
  fi
done
echo "no host ports published; host CDP probes denied"
compose run --rm -T probe
compose exec -T chromium bash -euc '
  count=0
  for proc in /proc/[0-9]*/cmdline; do
    args=$(tr "\0" " " < "$proc" 2>/dev/null) || continue
    if [[ "$args" == /usr/lib/chromium/chromium\ * && "$args" == *"--remote-debugging-port=9222"* && "$args" != *"--type="* ]]; then
      [[ "$args" == *"--user-data-dir=/config/m0-chromium"* ]]
      echo "$args"
      count=$((count+1))
    fi
  done
  test "$count" -eq 1
  test -f /config/m0-chromium/Local\ State
'
compose stop cdp-relay
compose restart -t 30 chromium
compose start cdp-relay
compose run --rm -T probe node /m0/probe.mjs --after-restart
