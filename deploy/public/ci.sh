#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/../.."

proxy=dsh-workstation-ci-proxy
edge=dsh-workstation-ci-traefik
# Derive every address from the same configuration the initializer uses, so CI
# exercises the real derivation instead of asserting copies of the defaults.
derived="$(bash deploy/network.sh derive)"
eval "$derived"
edge_dir="$(mktemp -d)"
state="$PWD/.workstation"
# The version matrix lives in deploy/public/traefik-matrix.env. This script
# refuses versions that are not pinned there, so a CI job cannot test a
# floating tag by accident.
traefik_version="${WORKSTATION_CI_TRAEFIK_VERSION:-$(bash deploy/public/traefik-image.sh --default)}"
traefik_image="$(bash deploy/public/traefik-image.sh "$traefik_version")"
echo "Traefik under test: $traefik_version ($traefik_image)"
compose_files=(-f compose.yml -f deploy/public/compose.ci.yml)
compose() { docker compose --env-file .env.public "${compose_files[@]}" "$@"; }
cleanup() {
  if (( $? != 0 )); then
    docker logs --tail=30 "$edge" 2>&1 || true
    if [[ -f .env.public ]]; then
      compose logs --no-color --tail=25 gateway runtime browser || true
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

# The CI proxy network must leave room for the edge's static address, or Docker
# can hand it out first and the edge fails with "Address already in use". Both
# values come from the derivation so this fixture cannot collide with a custom
# workstation plan.
docker network create --subnet "$WORKSTATION_CI_PROXY_SUBNET" \
  --ip-range "$WORKSTATION_CI_PROXY_IP_RANGE" "$proxy" >/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=workstation.test' \
  -addext 'subjectAltName=DNS:workstation.test' -keyout "$edge_dir/key.pem" -out "$edge_dir/cert.pem" 2>/dev/null
chmod 0444 "$edge_dir/cert.pem"
cat > "$edge_dir/test-certificate.yml" <<'TLS'
tls:
  certificates:
    - certFile: /dynamic/cert.pem
      keyFile: /dynamic/key.pem
TLS
docker run -d --name "$edge" --network "$proxy" --ip "$WORKSTATION_CI_PROXY_EDGE_IP" \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:80:8080 -p 127.0.0.1:443:8443 \
  --mount "type=bind,src=$edge_dir,dst=/dynamic,readonly" \
  "$traefik_image" \
  --entrypoints.http.address=:8080 \
  --entrypoints.http.http.redirections.entrypoint.to=:443 \
  --entrypoints.http.http.redirections.entrypoint.scheme=https \
  --entrypoints.websecure.address=:8443 \
  --providers.file.directory=/dynamic >/dev/null
# CI mode selects how the Workstation images are obtained.
#
#   build   (default) build them from this checkout. Proves the source builds.
#   release pull the digests recorded in deploy/public/images.env. Proves the
#           published references actually pull and run the full stack, which is
#           the claim #10 makes and cannot be checked by building locally.
ci_image_mode="${WORKSTATION_CI_IMAGE_MODE:-build}"
case $ci_image_mode in
  build) WORKSTATION_TRAEFIK_RESOLVER='' bash deploy/public/init.sh workstation.test "$proxy" "$edge" ;;
  release)
    WORKSTATION_TRAEFIK_RESOLVER='' bash deploy/public/init.sh workstation.test "$proxy" "$edge" --release ||
      { echo 'the release initializer refused the recorded digests' >&2; exit 1; }
    # Refuse to continue if any reference is not pinned: a tag here would mean
    # the experiment proves nothing about immutable deployment.
    while IFS='=' read -r name reference; do
      [[ $reference == *'@sha256:'* ]] || { echo "$name is not pinned: $reference" >&2; exit 1; }
    done < <(for key in RUNTIME GATEWAY; do
      printf '%s=%s\n' "$key" "$(sed -n "s/^WORKSTATION_${key}_IMAGE=//p" .env.public)"
    done)
    echo "Pulling published digests:"
    compose pull --quiet gateway runtime browser
    ;;
  *) echo "Unknown WORKSTATION_CI_IMAGE_MODE: $ci_image_mode" >&2; exit 1 ;;
esac
mkdir -m 0700 "$state/ci-state" "$state/fixture"
chmod 0755 "$state/fixture"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=fixture.test' \
  -addext 'subjectAltName=DNS:fixture.test' -keyout "$state/fixture/key.pem" -out "$state/fixture/cert.pem" 2>/dev/null
chmod 0444 "$state"/fixture/*.pem
spki() { openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A; }
export CI_EDGE_SPKI="$(spki "$edge_dir/cert.pem")"
export CI_FIXTURE_SPKI="$(spki "$state/fixture/cert.pem")"
# Opt in only for the test stack, with the trusted fixture as its origin.
export WORKSTATION_BROWSER_MCP=1
export BROWSER_TOOL_ORIGINS=https://fixture.test
export WORKSTATION_CI_STATE="$state/ci-state"

compose config -q
services="$(docker compose --env-file .env.public -f compose.yml config --services | sort | paste -sd ' ')"
[[ $services == 'browser gateway runtime' ]] || { echo "Unexpected full service set: $services" >&2; exit 1; }
if [[ $ci_image_mode == build ]]; then
  compose build gateway runtime
else
  echo 'Skipping the image build: this leg runs the published digests.'
fi
# A COPY whose destination ends in `/` applies --chmod to the directory as well
# as to the files. A 0644 there made /usr/local/lib/dsh-runtime unenterable, so
# the published image could not find its own modules while a locally built one
# sometimes appeared to work. Assert the runtime can reach them as its own user,
# in both modes, before the stack is started.
runtime_image="$(sed -n 's/^WORKSTATION_RUNTIME_IMAGE=//p' .env.public)"
[[ -n $runtime_image ]] || { echo 'the initializer wrote no runtime image' >&2; exit 1; }
docker run --rm --entrypoint sh "$runtime_image" -c '
  for path in /usr/local/lib/dsh-runtime /usr/local/lib/dsh-runtime/compat.mjs \
              /usr/local/lib/dsh-runtime/state.mjs /usr/local/lib/dsh-runtime/web.mjs; do
    test -e "$path" || { echo "missing: $path" >&2; exit 1; }
  done
  test -x /usr/local/lib/dsh-runtime ||
    { echo "/usr/local/lib/dsh-runtime is not enterable by $(id -un)" >&2; exit 1; }
  test -r /usr/local/lib/dsh-runtime/compat.mjs ||
    { echo "compat.mjs is not readable by $(id -un)" >&2; exit 1; }
' || { echo "the runtime image $runtime_image cannot read its own modules" >&2; exit 1; }
echo "Runtime image can read its modules as its own user: $runtime_image"

docker build --target probe -t workstation-ci-viewer -f prototypes/m0/browser/Dockerfile prototypes/m0/browser
node deploy/public/otp.mjs password > "$state/ci-state/password"
# Keep the bootstrap code valid for the short container startup.
if (( $(date +%s) % 30 > 20 )); then sleep "$((30 - $(date +%s) % 30 + 1))"; fi
node deploy/public/otp.mjs bootstrap | compose run --rm -T --no-deps gateway-admin bootstrap operator > "$state/ci-state/recovery"
viewer_user="$(docker run --rm --entrypoint sh workstation-ci-viewer -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')"
sudo chown -R "$viewer_user" "$state/ci-state"
mkdir -p evidence/ui
sudo chown "$viewer_user" evidence/ui
compose up -d --no-build --wait --wait-timeout 360
docker network connect dsh-workstation_workstation "$edge"
install -m 0600 "$state/edge/routes.yml" "$edge_dir/.routes.tmp"
mv "$edge_dir/.routes.tmp" "$edge_dir/routes.yml"

running="$(compose ps --services --status running | sort | paste -sd ' ')"
[[ $running == 'browser fixture gateway runtime' ]] || { echo "Unexpected running services: $running" >&2; exit 1; }
echo "Full stack running: browser, gateway, runtime (+ CI fixture)"
for service in gateway runtime browser; do
  test -z "$(docker port "$(compose ps -q "$service")")"
done
networks="$(docker network ls --filter label=com.docker.compose.project=dsh-workstation --format '{{.Name}}' | sort)"
test "$networks" = dsh-workstation_workstation
docker inspect "$edge" "$(compose ps -q gateway)" "$(compose ps -q runtime)" \
  "$(compose ps -q browser)" |
  node --input-type=module -e '
    import assert from "node:assert/strict"
    import { readFileSync } from "node:fs"
    const containers = JSON.parse(readFileSync(0, "utf8"))
    const mounts = containers.flatMap(container =>
      container.Mounts.filter(mount => mount.Name === "dsh-workstation_cdp-socket")
        .map(mount => [container.Config.Labels["com.docker.compose.service"], mount.Destination, mount.RW])
    )
    assert.equal(mounts.length, 2)
    assert.deepEqual(Object.fromEntries(mounts.map(([service, path, writable]) => [service, [path, writable]])), {
      gateway: ["/run/workstation-cdp", false],
      browser: ["/run/workstation-cdp", true],
    })
    const workstation = "dsh-workstation_workstation"
    const proxy = process.argv[1]
    const networks = containers.map(container => Object.keys(container.NetworkSettings.Networks).sort())
    assert.deepEqual(networks, [[proxy, workstation], [proxy, workstation], [workstation], [workstation]])
    const oldAliases = ["provider", "dsh-workstation-runtime", "dsh-workstation-chromium"]
    for (const [index, container] of containers.slice(1).entries()) {
      const aliases = container.NetworkSettings.Networks[workstation].Aliases ?? []
      assert.ok(!aliases.includes(oldAliases[index]), `retired workstation alias ${oldAliases[index]}`)
    }
  ' "$proxy"
network_ip() { docker inspect --format "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }
browser_ip="$(network_ip "$(compose ps -q browser)" dsh-workstation_workstation)"
gateway_ip="$(network_ip "$(compose ps -q gateway)" "$proxy")"
compose exec -T runtime node - "$browser_ip" "$gateway_ip" "$WORKSTATION_PROVIDER_IP" <<'NET'
const assert = require('node:assert/strict')
const { lookup } = require('node:dns/promises')
const { request } = require('node:https')
const [browser, gateway, gatewayPeer] = process.argv.slice(2)
;(async () => {
  assert.equal((await lookup('browser')).address, browser)
  assert.equal((await lookup('gateway')).address, gatewayPeer)
  const origin = 'http://browser:3000'
  const document = await fetch(origin + '/browser/', { signal: AbortSignal.timeout(2000) })
  assert.equal(document.status, 200, 'Selkies HTML is reachable on the shared network')
  await document.body.cancel()
  for (const [path, method] of [
    ['/browser/api/websockets', 'GET'], ['/browser/api/websockets/', 'GET'], ['/browser/api/tokens', 'POST'],
  ]) {
    const headers = { 'X-Forwarded-For': gatewayPeer }
    const response = await fetch(origin + path, { method, headers, signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 403, path)
    assert.equal(await response.text(), 'Gateway required', path)
    await new Promise((resolve, reject) => {
      request(`https://${browser}:3001${path}`, {
        method, headers, rejectUnauthorized: false, signal: AbortSignal.timeout(2000),
      }, response => {
        response.resume()
        if (response.statusCode === 403) resolve()
        else reject(Error(`Selkies TLS listener answered ${response.statusCode} for ${path}`))
      }).on('error', reject).end()
    })
  }
  for (const url of [
    `http://${browser}:8082/`,
    `http://${browser}:9222/json/version`,
    `http://${browser}:9223/json/version`,
    'http://gateway:9223/json/version',
    'http://gateway:8081/status',
    'http://gateway:8082/health',
    'http://gateway:8081/verify',
    `http://${gateway}:8081/verify`,
  ]) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1200) }), url)
  }
  assert.equal((await fetch('http://gateway:8080/mcp')).status, 401)
  assert.equal((await fetch('http://gateway:8080/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
  })).status, 401, 'unauthenticated MCP version probe')
  console.log('Shared-network Selkies HTML works. HTTP and HTTPS reject direct input and token administration.')
})().catch(error => { console.error('Workstation network check failed:', error.message); process.exitCode = 1 })
NET
compose exec -T browser python3 - "$WORKSTATION_PROVIDER_IP" <<'NET'
import http.client
import socket
import sys

for port in (8081, 8082, 9223):
    try:
        connection = socket.create_connection((sys.argv[1], port), timeout=1)
    except OSError:
        continue
    with connection:
        raise SystemExit(f"Browser reached a private Gateway listener on port {port}")

connection = http.client.HTTPConnection("runtime", 8099, timeout=2)
try:
    connection.request("POST", "/", body="{}")
    response = connection.getresponse()
    if response.status != 401:
        raise SystemExit(f"Runtime maintenance answered {response.status} without a credential")
finally:
    connection.close()
NET
for address in "$browser_ip" "$gateway_ip" "$WORKSTATION_PROVIDER_IP"; do
  for port in 9222 9223; do
    if curl -s --noproxy '*' --connect-timeout 1 --max-time 2 -o /dev/null "http://$address:$port/json/version"; then
      echo 'Host reached a CDP listener' >&2
      exit 1
    fi
  done
done
echo 'CDP socket shared only by Browser and Gateway. CDP and control listeners stay private.'

curlhere() { curl -sS --max-time 10 --resolve workstation.test:443:127.0.0.1 --cacert "$edge_dir/cert.pem" "$@"; }
expect_status() {
  local wanted="$1" observed
  shift
  observed="$(curlhere -o /dev/null -w '%{http_code}' "$@")"
  if [[ $observed != "$wanted" ]]; then
    printf 'Expected HTTPS %s, received %s for %s\n' "$wanted" "$observed" "${@: -1}" >&2
    return 1
  fi
}
test "$(curl -sS --max-time 10 --resolve workstation.test:80:127.0.0.1 -o /dev/null -w '%{redirect_url}' http://workstation.test/)" = 'https://workstation.test/'
expect_status 303 -H 'Accept: text/html' https://workstation.test/
expect_status 401 -H 'Accept: application/json' https://workstation.test/api/remote.mux
expect_status 401 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://workstation.test/browser/api/websockets
expect_status 404 -X POST https://workstation.test/browser/api/tokens
echo 'TLS and ForwardAuth: HTTP redirects to HTTPS, documents to login, unauthenticated API/WebSocket denied, Selkies token API unrouted'
# The edge reaches DSH over verified internal TLS. DSH binds the concrete
# container IPv4 (DSH_BIND_IP), not loopback, so probe that address. Plain HTTP
# on the same port must fail, and the HTTPS chain must verify against the pinned
# Runtime CA.
compose exec -T runtime node --input-type=module -e '
  import assert from "node:assert/strict"
  import { readFileSync } from "node:fs"
  import { request } from "node:https"
  const bind = process.env.DSH_BIND_IP
  const port = Number(process.env.DSH_BIND_PORT ?? 3080)
  assert.match(bind ?? "", /^\d+\.\d+\.\d+\.\d+$/, "DSH_BIND_IP must be a concrete IPv4 address")
  const ca = readFileSync("/run/secrets/runtime_ca")

  // A plaintext request must not be served. A refused connection or a TLS
  // handshake error both count as refusal; what must not happen is a plain HTTP
  // response, so record any answer and assert on it below.
  let plaintext = null
  try {
    const response = await fetch(`http://${bind}:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(4000) })
    await response.body?.cancel()
    plaintext = `HTTP ${response.status}`
  } catch {}
  assert.equal(plaintext, null, `plaintext HTTP was answered with ${plaintext} on the DSH listener`)

  const status = await new Promise((resolve, reject) => {
    request({ host: bind, port, path: "/", ca }, response => { response.resume(); resolve(response.statusCode) })
      .on("error", reject).end()
  })
  assert.equal(status, 401, "DSH must challenge unauthenticated requests over internal TLS")
  console.log(`DSH serves HTTPS with the pinned Runtime CA on ${bind}:${port} and does not answer plaintext`)
'
node deploy/public/edge-probe.mjs "$traefik_version" "$edge_dir/cert.pem" workstation.test:443
check() {
  docker run --rm --ipc=host --network host --add-host workstation.test:127.0.0.1 \
    -e CI_EDGE_SPKI -e NODE_EXTRA_CA_CERTS=/ci-edge.pem -v "$edge_dir/cert.pem:/ci-edge.pem:ro" \
    -v "$PWD/deploy/public:/m0/public:ro" -v "$state/ci-state:/ci-state" \
    -v "$PWD/evidence/ui:/ci-ui" \
    workstation-ci-viewer node /m0/public/check.mjs "$1"
}
check gateway
compose stop gateway
restore_volume=dsh-workstation_ci-auth-restore
docker volume create "$restore_volume" >/dev/null
cat > "$state/gateway-restore.yml" <<'YAML'
volumes:
  auth-data:
    name: dsh-workstation_ci-auth-restore
    external: true
YAML
# The archive is created only while SQLite is stopped, and stays on the runner.
docker run --rm --network none --user 0:0 --entrypoint sh \
  -v dsh-workstation_auth-data:/source:ro -v "$restore_volume":/target \
  "$runtime_image" -ec '
    tar -C /source -cf /tmp/auth.tar .
    tar -C /target -xpf /tmp/auth.tar
  '
compose_files+=(-f "$state/gateway-restore.yml")
compose up -d --no-build --wait --wait-timeout 60 --force-recreate gateway
check restore

browser_id() {
  compose exec -T gateway node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(2000) })
    if (!response.ok) process.exit(1)
    console.log(new URL((await response.json()).webSocketDebuggerUrl).pathname)
  '
}
profile_lock() {
  compose exec -T browser sh -c 'hostname; readlink /config/chromium/SingletonLock || true'
}
previous="$(browser_id)"
echo 'Chromium host and profile lock before replacement'
profile_lock
compose exec -T -u 1000:1000 browser touch /config/.ci-profile-witness
compose kill -s SIGKILL browser
compose up -d --no-build --force-recreate browser
current=''
for attempt in {1..60}; do
  current="$(browser_id 2>/dev/null || true)"
  if [[ -n $current && $current != "$previous" ]]; then break; fi
  sleep 2
done
if [[ -z $current || $current == "$previous" ]]; then
  echo 'No new CDP instance after recreation. Chromium host and profile lock:' >&2
  profile_lock >&2 || true
  browser_id >&2 || true
  exit 1
fi
compose exec -T browser test -f /config/.ci-profile-witness
compose up -d --no-build --wait --wait-timeout 120 browser gateway
echo 'Browser recreated. Gateway reached the new Chromium instance through the reused CDP socket volume.'
check browser

# The exclusive-handoff requirement (#4) at the real Selkies boundary. This is
# the case M0 recorded as Gate C: a pointer button pressed while HUMAN holds
# control, then authority moved to the Agent. Before the input gate, the
# release frame the page sent afterwards was dropped along with every other
# input frame, so the desktop spent the whole lease mid-drag.
gate_release() {
  compose exec -T -e PHASE="$1" gateway node --input-type=module -e '
    import assert from "node:assert/strict"
    import { readFile } from "node:fs/promises"
    const secret = (await readFile("/run/secrets/gate_control", "utf8")).trim()
    const gate = process.env.GATEWAY_BROWSER_UPSTREAM
    const call = (path, method = "POST") => fetch(gate + path, {
      method, headers: { Authorization: "Bearer " + secret }, signal: AbortSignal.timeout(8000),
    })
    if (process.env.PHASE === "status") {
      const response = await call("/status", "GET")
      assert.equal(response.status, 200, "the gate status endpoint is unreachable")
      const body = await response.json()
      assert.ok(["CLOSED", "OPEN", "RELEASING"].includes(body.state), "unexpected gate state " + body.state)
      // The shape must not depend on whether a page is attached: a probe that
    // reads .authority should get false, not undefined.
    assert.equal(typeof body.authority, "boolean", "gate status omitted authority")
    assert.equal(typeof body.permitted, "boolean", "gate status omitted permitted")
    console.log("gate state:", body.state, "authority:", body.authority, "permitted:", body.permitted)
      process.exit(0)
    }
    // No operator connection is live in CI, so the handover has nothing held to
    // release. What this proves is the control path the Provider depends on:
    // an authenticated handover succeeds and reports that it released, and an
    // unauthenticated one is refused. The held-input proof itself runs in
    // browser-gate/test against a fake Selkies that enforces the real ordering.
    const ok = await call("/handover")
    assert.equal(ok.status, 200, "authenticated handover was refused")
    assert.equal((await ok.json()).released, true, "handover did not report a release")
    const denied = await fetch(gate + "/handover", {
      method: "POST", headers: { Authorization: "Bearer " + "0".repeat(64) },
    })
    assert.equal(denied.status, 401, "the gate accepted an unauthenticated handover")
    console.log("input gate handover is authenticated and reports a completed release")
  '
}
gate_release status
gate_release handover
# The gate must be healthy after the handover it just performed.
compose up -d --no-build --wait --wait-timeout 60 gateway
check browser
echo 'Input gate verified: authenticated handover, refusal of unauthenticated, stack healthy after'

# Exercise the persisted Browser Bundle after a real DSH version switch once
# in the source matrix and again from the pinned release images.
if [[ $ci_image_mode == release || ( $traefik_version == "$(bash deploy/public/traefik-image.sh --default)" && ${WORKSTATION_CI_SUBNETS:-default} == default ) ]]; then
  check sidebar
  # A disposable Profile pin exercises the error feedback on the upgrade page.
  compose exec -T runtime sh -ec '
    dir=/dsh-home/profiles/drill-gate
    mkdir -p "$dir/node_modules/dsh-drill-pin"
    printf "%s" "{\"name\":\"drill-gate\",\"dependencies\":{\"dsh-drill-pin\":\"1.0.0\"}}" > "$dir/package.json"
    printf "%s" "lockfileVersion: 9" > "$dir/pnpm-lock.yaml"
    printf "%s" "{\"name\":\"dsh-drill-pin\",\"version\":\"1.0.0\",\"engines\":{\"dsh\":\"0.2.2-rc.1\"}}" \
      > "$dir/node_modules/dsh-drill-pin/package.json"
  '
  check upgrade-failure
  compose exec -T runtime dsh-runtime status | grep -Fx 'Active: 0.2.2-rc.1'
  compose exec -T runtime rm -rf /dsh-home/profiles/drill-gate
  runtime_id="$(compose ps -q runtime)"
  check upgrade
  test "$(compose ps -q runtime)" = "$runtime_id"
  compose exec -T runtime dsh-runtime status | grep -Fx 'Active: 0.2.2-rc.5'
  check browser
  check sidebar
  echo 'Gateway upgraded DSH from 0.2.2-rc.1 to 0.2.2-rc.5 and the installed Browser Bundle served real MCP tools'
fi
