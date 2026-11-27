#!/usr/bin/env bash
# Verify the core deployment shape: DSH and Gateway start and serve, and the
# browser stack is genuinely absent rather than merely unreachable.
#
#   bash deploy/public/ci-core.sh
#
# A separate script from ci.sh on purpose: ci.sh exercises the full stack end to
# end, and threading a second shape through it would put every existing
# assertion behind a conditional.
#
# Each assertion below can fail, which is the point:
#   - A browser service that is not behind a profile would still start, so the
#     check reads the resolved config rather than trusting the override file.
#   - Gateway must become healthy with no browser service running. A `depends_on`
#     added later turns this into a timeout.
#   - /browser/ must answer 503 from the core path. If GATEWAY_BROWSER_ENABLED stops
#     being honoured it proxies to nothing and becomes a 502 or a stall.
#   - The Runtime must not have installed the browser Bundle, which pins DSH
#     0.2.2-rc.1 and would fail an otherwise valid upgrade.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
cd -- "$(dirname -- "$0")/../.."

proxy=dsh-workstation-ci-core-proxy
edge=dsh-workstation-ci-core-traefik
derived="$(bash deploy/network.sh derive)"
eval "$derived"
edge_dir="$(mktemp -d)"
state="$PWD/.workstation"
traefik_version="${WORKSTATION_CI_TRAEFIK_VERSION:-$(bash deploy/public/traefik-image.sh --default)}"
traefik_image="$(bash deploy/public/traefik-image.sh "$traefik_version")"
echo "Traefik under test: $traefik_version ($traefik_image)"
compose_files=(-f compose.yml -f deploy/public/compose.core.yml -f deploy/public/compose.ci.yml)
compose() { docker compose --env-file .env.public "${compose_files[@]}" "$@"; }
cleanup() {
  if (( $? != 0 )); then
    # Traefik's own view is what distinguishes "the route is wrong" from "the
    # upstream is unreachable", and both look like a 502 from the client.
    docker logs --tail=60 "$edge" 2>&1 || true
    if [[ -f .env.public ]]; then compose logs --no-color --tail=60 gateway runtime || true; fi
  fi
  docker rm -f "$edge" >/dev/null 2>&1 || true
  if [[ -f .env.public ]]; then compose down --volumes --remove-orphans || true; fi
  docker network rm "$proxy" >/dev/null 2>&1 || true
  rm -rf -- "$edge_dir"
}
trap cleanup EXIT

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

WORKSTATION_TRAEFIK_RESOLVER='' bash deploy/public/init.sh workstation.test "$proxy" "$edge"
compose config -q
compose build gateway runtime

# --- the shape itself -------------------------------------------------------
# Read the resolved config, not this file: the question is what Compose will
# actually start. `compose config` drops `profiles` from its JSON output, so the
# only trustworthy statement about a profiled-out service is the one Compose
# itself makes -- `config --services` lists exactly the services that would run
# for the given files and profiles.
run_services="$(compose config --services | sort | tr '\n' ' ')"
printf 'Services that would start: %s\n' "$run_services"
[[ $run_services == 'gateway runtime ' ]] ||
  { echo "FAIL: unexpected core service set: $run_services" >&2; exit 1; }
echo "Core run set excludes the browser stack: $run_services"

if ! compose config --format json | node -e '
  const j = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
  const bundle = j.services.runtime?.environment?.WORKSTATION_BROWSER_MCP
  const enabled = j.services.gateway?.environment?.GATEWAY_BROWSER_ENABLED
  let bad = 0
  if (bundle !== "0") { console.log(`FAIL: WORKSTATION_BROWSER_MCP=${bundle}, expected 0`); bad++ }
  if (enabled !== "0") { console.log(`FAIL: GATEWAY_BROWSER_ENABLED=${enabled}, expected 0`); bad++ }
  process.exit(bad ? 1 : 0)
'; then
  echo 'FAIL: the resolved core shape is wrong' >&2
  exit 1
fi
echo 'Core shape: bundle disabled, browser proxy disabled'

# Gateway refuses to start before an administrator exists, so the bootstrap runs
# first, exactly as ci.sh does it. The bootstrap TOTP code is only valid for a
# short window, hence the sleep.
mkdir -m 0700 "$state/ci-state"
# otp.mjs reads the password from WORKSTATION_CI_STATE (default /ci-state), which
# is a path inside the viewer container. Without this export it looks for
# /ci-state/password on the host and the bootstrap fails with ENOENT.
export WORKSTATION_CI_STATE="$state/ci-state"
node deploy/public/otp.mjs password > "$state/ci-state/password"
if (( $(date +%s) % 30 > 20 )); then sleep "$((30 - $(date +%s) % 30 + 1))"; fi
node deploy/public/otp.mjs bootstrap | compose run --rm -T --no-deps gateway-admin bootstrap operator > "$state/ci-state/recovery" \
  || { echo 'FAIL: could not bootstrap the administrator in the core shape' >&2; exit 1; }
echo 'Administrator bootstrapped'

compose up -d --no-build --wait --wait-timeout 420

# The edge must join the workstation network and pick up the route file, or
# Traefik answers with its own 404 instead of reaching Gateway. Only the workstation
# network is connected here: the browser network exists but has no consumer, and
# connecting the edge to it would suggest the browser side is wired up.
docker network connect dsh-workstation_workstation "$edge"
install -m 0600 "$state/edge/routes.yml" "$edge_dir/.routes.tmp"
mv "$edge_dir/.routes.tmp" "$edge_dir/routes.yml"
# Traefik watches the directory, but give the file watcher a moment so the first
# request below does not race the reload.
sleep 3
started="$(compose ps --services --status running | sort | tr '\n' ' ')"
printf 'Running services: %s\n' "$started"
[[ "$started" == "gateway runtime " ]] \
  || { echo "FAIL: core started '$started', expected only gateway and runtime" >&2; exit 1; }
echo 'Only gateway and runtime are running'

# --- a real login, then DSH, then the core refusal --------------------------
# login-probe.mjs completes password + TOTP over HTTPS and asserts that the
# session reaches DSH and that /browser/ is refused *while signed in*. That last
# detail is why this is not a bare curl for a status code: unauthenticated
# requests are redirected to the login page before they reach the core branch.
node deploy/public/login-probe.mjs https://workstation.test "$edge_dir/cert.pem" 443 \
  || { echo 'FAIL: the core login probe failed' >&2; exit 1; }

# --- the handler-level refusal is covered by a Go test ---------------------
# The probe above proves the 503 over HTTP. The Go test covers the handler
# directly (a wrong method, a missing Origin, an already-revoked session), which
# would be expensive to reach over the wire. Failing here means the coverage was
# deleted, not that the code broke -- the code is compiled by the gateway image.
[ -f gateway/workstation_core_test.go ] \
  || { echo 'FAIL: the Go test for the core refusal is missing' >&2; exit 1; }
echo 'Core refusal has handler-level coverage: gateway/workstation_core_test.go'

# --- the Bundle must not have been installed --------------------------------
if compose exec -T runtime test -e /dsh-home/profiles/web/.workstation-browser-0.1.0; then
  echo 'FAIL: the browser Bundle was installed in a core deployment' >&2
  exit 1
fi
echo 'Runtime skipped the browser Bundle'

echo 'Core deployment verified: DSH and Gateway serve, the browser stack is absent'
