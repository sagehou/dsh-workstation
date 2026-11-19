#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
files=(-f compose.yml)
scratch=
case "${1:-}" in
  --exclusive)
    export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dsh-m0-exclusive}"
    scratch="$(mktemp -d)"
    export M0_MASTER_FILE="$scratch/master"
    openssl rand -hex 32 > "$M0_MASTER_FILE"
    chmod 444 "$M0_MASTER_FILE"
    files+=(-f compose.exclusive.yml)
    ;;
  '') export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dsh-m0-browser}" ;;
  *) exit 2 ;;
esac
compose() { docker compose "${files[@]}" "$@"; }
cleanup() {
  compose down --volumes --remove-orphans
  if [[ -n "$scratch" ]]; then rm -rf "$scratch"; fi
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
if [[ -n "$scratch" ]]; then
  compose run --rm -T probe node /m0/probe.mjs --exclusive
  exit
fi
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
# A container stop can interrupt Chromium's asynchronous SQLite commit. Wait
# for the tracked persistent cookie to be on disk before testing restart.
compose exec -T chromium python3 - <<'PY'
import pathlib
import sqlite3
import time

profile = pathlib.Path('/config/m0-chromium/Default')
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    for path in (profile / 'Cookies', profile / 'Network' / 'Cookies'):
        try:
            with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
                row = db.execute("SELECT count(*) FROM cookies WHERE host_key = ? AND name = ?", ('fixture', 'm0_profile')).fetchone()
                if row[0] == 1:
                    print('test cookie committed to the persistent Chromium profile')
                    raise SystemExit(0)
        except sqlite3.OperationalError:
            pass
    time.sleep(1)
raise SystemExit('test cookie did not reach the persistent Chromium profile')
PY
compose stop -t 2 cdp-relay
compose restart -t 30 chromium
compose start cdp-relay
compose run --rm -T probe node /m0/probe.mjs --after-restart
