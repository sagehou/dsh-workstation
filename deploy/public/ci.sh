#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/../.."

proxy=dsh-workstation-ci-proxy
edge=dsh-workstation-ci-traefik
edge_dir="$(mktemp -d)"
state="$PWD/.workstation"
compose_files=(-f compose.yml -f deploy/public/compose.ci.yml)
compose() { docker compose --env-file .env.public "${compose_files[@]}" "$@"; }
cleanup() {
  if (( $? != 0 )); then
    docker logs --tail=30 "$edge" 2>&1 || true
    if [[ -f .env.public ]]; then
      compose logs --no-color --tail=25 auth runtime provider cdp-relay || true
    fi
  fi
  docker rm -f "$edge" >/dev/null 2>&1 || true
  if [[ -f .env.public ]]; then compose down --volumes --remove-orphans || true; fi
  if [[ -n ${restore_volume:-} ]]; then
    docker volume rm "$restore_volume" dsh-workstation_auth-data >/dev/null 2>&1 || true
  fi
  docker network rm "$proxy" >/dev/null 2>&1 || true
  rm -rf -- "$edge_dir"
}
trap cleanup EXIT

docker network create --subnet 172.30.242.0/24 "$proxy" >/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=workstation.test' \
  -addext 'subjectAltName=DNS:workstation.test' -keyout "$edge_dir/key.pem" -out "$edge_dir/cert.pem" 2>/dev/null
chmod 0444 "$edge_dir/cert.pem"
cat > "$edge_dir/test-certificate.yml" <<'TLS'
tls:
  certificates:
    - certFile: /dynamic/cert.pem
      keyFile: /dynamic/key.pem
TLS
docker run -d --name "$edge" --network "$proxy" --ip 172.30.242.2 \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:80:8080 -p 127.0.0.1:443:8443 \
  --mount "type=bind,src=$edge_dir,dst=/dynamic,readonly" \
  traefik:v3.7.19@sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4 \
  --entrypoints.http.address=:8080 \
  --entrypoints.http.http.redirections.entrypoint.to=:443 \
  --entrypoints.http.http.redirections.entrypoint.scheme=https \
  --entrypoints.websecure.address=:8443 \
  --providers.file.directory=/dynamic >/dev/null
WORKSTATION_TRAEFIK_RESOLVER='' bash deploy/public/init.sh workstation.test "$proxy" "$edge"
mkdir -m 0700 "$state/ci-state" "$state/fixture"
chmod 0755 "$state/fixture"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=fixture.test' \
  -addext 'subjectAltName=DNS:fixture.test' -keyout "$state/fixture/key.pem" -out "$state/fixture/cert.pem" 2>/dev/null
chmod 0444 "$state"/fixture/*.pem
spki() { openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A; }
export CI_EDGE_SPKI="$(spki "$edge_dir/cert.pem")"
export CI_FIXTURE_SPKI="$(spki "$state/fixture/cert.pem")"
export BROWSER_TOOL_ORIGINS=https://fixture.test

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
docker network connect dsh-workstation_workstation "$edge"
docker network connect dsh-workstation_browser "$edge"
install -m 0600 "$state/edge/routes.yml" "$edge_dir/.routes.tmp"
mv "$edge_dir/.routes.tmp" "$edge_dir/routes.yml"

for service in auth runtime chromium provider cdp-relay; do
  test -z "$(docker port "$(compose ps -q "$service")")"
done
networks="$(docker network ls --filter label=com.docker.compose.project=dsh-workstation --format '{{.Name}}' | sort)"
test "$networks" = $'dsh-workstation_browser\ndsh-workstation_workstation'
docker inspect "$edge" "$(compose ps -q auth)" "$(compose ps -q runtime)" \
  "$(compose ps -q chromium)" "$(compose ps -q provider)" "$(compose ps -q cdp-relay)" |
  node --input-type=module -e '
    import assert from "node:assert/strict"
    import { readFileSync } from "node:fs"
    const containers = JSON.parse(readFileSync(0, "utf8"))
    const mounts = containers.flatMap(container =>
      container.Mounts.filter(mount => mount.Name === "dsh-workstation_cdp-socket")
        .map(mount => [container.Config.Labels["com.docker.compose.service"], mount.Destination, mount.RW])
    )
    assert.deepEqual(mounts, [
      ["provider", "/run/workstation-cdp", false],
      ["cdp-relay", "/run/workstation-cdp", true]
    ])
  '
network_ip() { docker inspect --format "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }
browser_ip="$(network_ip "$(compose ps -q chromium)" dsh-workstation_browser)"
auth_ip="$(network_ip "$(compose ps -q auth)" "$proxy")"
compose exec -T runtime node - "$browser_ip" "$auth_ip" <<'NET'
const assert = require('node:assert/strict')
const [browser, auth] = process.argv.slice(2)
;(async () => {
  for (const url of [
    `http://${browser}:3000/browser/`,
    `http://${browser}:9222/json/version`,
    `http://${browser}:9223/json/version`,
    'http://provider:9223/json/version',
    'http://provider:8081/status',
    'http://172.30.233.2:8081/status',
    'http://auth:8081/verify',
    `http://${auth}:8081/verify`,
  ]) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1200) }), url)
  }
  assert.equal((await fetch('http://provider:8080/mcp')).status, 401)
  assert.equal((await fetch('http://provider:8080/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
  })).status, 401, 'unauthenticated MCP version probe')
  console.log('DSH cannot reach Selkies, CDP, Provider control or ForwardAuth; MCP requires a credential')
})().catch(error => { console.error('Network isolation check failed:', error.message); process.exitCode = 1 })
NET
for address in "$browser_ip" 172.30.241.3 172.30.233.2; do
  for port in 9222 9223; do
    if curl -s --noproxy '*' --connect-timeout 1 --max-time 2 -o /dev/null "http://$address:$port/json/version"; then
      echo 'Host reached a CDP listener' >&2
      exit 1
    fi
  done
done
echo 'Three Docker networks; CDP socket shared only by the Provider and relay; direct host CDP denied'

curlhere() { curl -sS --max-time 10 --resolve workstation.test:443:127.0.0.1 --cacert "$edge_dir/cert.pem" "$@"; }
expect_status() {
  local wanted="$1" observed
  shift
  observed="$(curlhere -o /dev/null -w '%{http_code}' "$@")"
  test "$wanted" = "$observed"
}
test "$(curl -sS --max-time 10 --resolve workstation.test:80:127.0.0.1 -o /dev/null -w '%{redirect_url}' http://workstation.test/)" = 'https://workstation.test/'
expect_status 303 -H 'Accept: text/html' https://workstation.test/
expect_status 401 -H 'Accept: application/json' https://workstation.test/api/remote.mux
expect_status 401 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://workstation.test/browser/api/websockets
expect_status 404 -X POST https://workstation.test/browser/api/tokens
echo 'TLS and ForwardAuth: HTTP redirects to HTTPS, documents to login, unauthenticated API/WebSocket denied, Selkies token API unrouted'
check() {
  docker run --rm --ipc=host --network host --add-host workstation.test:127.0.0.1 \
    -e CI_EDGE_SPKI -e NODE_EXTRA_CA_CERTS=/ci-edge.pem -v "$edge_dir/cert.pem:/ci-edge.pem:ro" \
    -v "$PWD/deploy/public:/m0/public:ro" -v "$state/ci-state:/ci-state" \
    workstation-ci-viewer node /m0/public/check.mjs "$1"
}
check gateway
compose stop auth
restore_volume=dsh-workstation_ci-auth-restore
docker volume create "$restore_volume" >/dev/null
cat > "$state/auth-restore.yml" <<'YAML'
volumes:
  auth-data:
    name: dsh-workstation_ci-auth-restore
    external: true
YAML
# The archive is created only while SQLite is stopped, and stays on the runner.
docker run --rm --network none --user 0:0 --entrypoint sh \
  -v dsh-workstation_auth-data:/source:ro -v "$restore_volume":/target \
  dsh-workstation-provider:0.2.0 -ec '
    tar -C /source -cf /tmp/auth.tar .
    tar -C /target -xpf /tmp/auth.tar
  '
compose_files+=(-f "$state/auth-restore.yml")
compose up -d --no-build --wait --wait-timeout 60 --force-recreate auth
check restore

browser_id() {
  compose exec -T provider node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(2000) })
    if (!response.ok) process.exit(1)
    console.log(new URL((await response.json()).webSocketDebuggerUrl).pathname)
  '
}
previous="$(browser_id)"
compose kill -s SIGKILL cdp-relay
compose up -d --no-build --force-recreate chromium cdp-relay
current=''
for attempt in {1..60}; do
  current="$(browser_id 2>/dev/null || true)"
  if [[ -n $current && $current != "$previous" ]]; then break; fi
  sleep 2
done
[[ -n $current && $current != "$previous" ]]
compose up -d --no-build --wait --wait-timeout 120 provider
echo 'Chromium and killed relay recreated; Provider reached a new Chromium instance through the reused socket volume'
check browser
