#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/../.."
bash deploy/public/init.sh workstation.test ci@example.test
state="$PWD/.workstation"
mkdir -m 0700 "$state/ci-state" "$state/fixture"
chmod 0755 "$state/fixture"
for setup in edge:workstation.test fixture:fixture.test; do
  dir="$state/${setup%:*}"
  host="${setup#*:}"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=$host" \
    -addext "subjectAltName=DNS:$host" -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
done
chmod 0444 "$state"/fixture/*.pem "$state/edge/cert.pem"
sed -i 's/tls: {certResolver: public}/tls: {}/g' "$state/edge/routes.yml"
cat > "$state/edge/test-certificate.yml" <<'TLS'
tls:
  certificates:
    - certFile: /etc/traefik/dynamic/cert.pem
      keyFile: /etc/traefik/dynamic/key.pem
TLS
spki() { openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A; }
export CI_EDGE_SPKI="$(spki "$state/edge/cert.pem")"
export CI_FIXTURE_SPKI="$(spki "$state/fixture/cert.pem")"
export BROWSER_TOOL_ORIGINS=https://fixture.test
export WORKSTATION_CI_STATE="$state/ci-state"
compose() { docker compose --env-file .env.public -f compose.yml -f deploy/public/compose.ci.yml "$@"; }
cleanup() {
  if (( $? != 0 )); then compose logs --no-color --tail=25 edge auth runtime provider || true; fi
  compose down --volumes --remove-orphans
}
trap cleanup EXIT
compose config -q
compose build auth runtime provider
docker build --target probe -t workstation-ci-viewer -f prototypes/m0/browser/Dockerfile prototypes/m0/browser
node deploy/public/otp.mjs password > "$state/ci-state/password"
# Keep the bootstrap code valid for the short container startup.
if (( $(date +%s) % 30 > 20 )); then sleep "$((30 - $(date +%s) % 30 + 1))"; fi
node deploy/public/otp.mjs bootstrap | compose run --rm -T --no-deps auth-admin bootstrap operator > "$state/ci-state/recovery"
viewer_user="$(docker run --rm --entrypoint sh workstation-ci-viewer -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')"
sudo chown -R "$viewer_user" "$state/ci-state"
compose up -d --no-build --wait --wait-timeout 360
for service in auth runtime chromium provider; do
  test -z "$(docker port "$(compose ps -q "$service")")"
done
members="$(docker network inspect dsh-workstation_cdp --format '{{range .Containers}}{{println .Name}}{{end}}' | sed '/^$/d' | sort)"
diff -u <(printf '%s\n' dsh-workstation-chromium-1 dsh-workstation-provider-1) <(printf '%s\n' "$members")
compose exec -T runtime node - <<'NET'
const assert = require('node:assert/strict')
;(async () => {
  for (const url of ['http://172.30.231.2:9223/json/version', 'http://provider:8081/status',
    'http://172.30.233.2:8081/status', 'http://172.30.242.3:8081/verify']) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1200) }))
  }
  assert.equal((await fetch('http://provider:8080/mcp')).status, 401)
  console.log('Network: DSH cannot reach CDP, Provider control or ForwardAuth; MCP requires a credential')
})().catch(() => { console.error('Network isolation check failed'); process.exitCode = 1 })
NET
curlhere() { curl -sS --max-time 10 --resolve workstation.test:443:127.0.0.1 --cacert "$state/edge/cert.pem" "$@"; }
expect_status() {
  local wanted="$1" observed
  shift
  observed="$(curlhere -o /dev/null -w '%{http_code}' "$@")"
  if [[ $observed != "$wanted" ]]; then
    printf 'Expected HTTP %s, got %s for %s\n' "$wanted" "$observed" "$*" >&2
    return 1
  fi
}
test "$(curl -sS --max-time 10 --resolve workstation.test:80:127.0.0.1 -o /dev/null -w '%{redirect_url}' http://workstation.test/)" = 'https://workstation.test/'
expect_status 303 -H 'Accept: text/html' https://workstation.test/
expect_status 401 -H 'Accept: application/json' https://workstation.test/api/remote.mux
expect_status 401 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://workstation.test/browser/api/websockets
expect_status 404 -X POST https://workstation.test/browser/api/tokens
echo 'TLS and ForwardAuth: HTTP redirects to HTTPS, documents to login, unauthenticated API/WebSocket denied, Selkies token API unrouted'
check() {
  docker run --rm --ipc=host --network host --add-host workstation.test:127.0.0.1 \
    -e CI_EDGE_SPKI -e NODE_EXTRA_CA_CERTS=/ci-edge.pem -v "$state/edge/cert.pem:/ci-edge.pem:ro" \
    -v "$PWD/deploy/public:/m0/public:ro" -v "$state/ci-state:/ci-state" \
    workstation-ci-viewer node /m0/public/check.mjs "$1"
}
check gateway
compose stop auth
restore_volume=dsh-workstation_ci-auth-restore
docker volume create "$restore_volume" >/dev/null
restore_compose() {
  compose -f "$state/auth-restore.yml" "$@"
}
cat > "$state/auth-restore.yml" <<'YAML'
volumes:
  auth-data:
    name: dsh-workstation_ci-auth-restore
    external: true
YAML
restore_cleanup() {
  if (( $? != 0 )); then restore_compose logs --no-color --tail=15 edge auth provider || true; fi
  restore_compose down --volumes --remove-orphans
  compose down --volumes --remove-orphans
  docker volume rm "$restore_volume" >/dev/null
}
trap restore_cleanup EXIT
# The archive is created only while SQLite is stopped, and stays on the runner.
docker run --rm --network none --user 0:0 --entrypoint sh \
  -v dsh-workstation_auth-data:/source:ro -v "$restore_volume":/target \
  dsh-workstation-provider:0.1.0 -ec '
    tar -C /source -cf /tmp/auth.tar .
    tar -C /target -xpf /tmp/auth.tar
  '
restore_compose up -d --no-build --wait --wait-timeout 60 --force-recreate auth
check restore
check browser
