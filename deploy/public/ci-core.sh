#!/usr/bin/env bash
# Verify the core deployment shape: DSH and Auth start and serve, and the
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
#   - Auth must become healthy with no browser service running. A `depends_on`
#     added later turns this into a timeout.
#   - /browser/ must answer 503 from the core path. If AUTH_BROWSER_ENABLED stops
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
    docker logs --tail=30 "$edge" 2>&1 || true
    if [[ -f .env.public ]]; then compose logs --no-color --tail=40 auth runtime || true; fi
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
compose build auth runtime

# --- the shape itself -------------------------------------------------------
# Read the resolved config, not this file: the question is what Compose will
# actually start. `compose config` drops `profiles` from its JSON output, so the
# only trustworthy statement about a profiled-out service is the one Compose
# itself makes -- `config --services` lists exactly the services that would run
# for the given files and profiles.
run_services="$(compose config --services | sort | tr '\n' ' ')"
printf 'Services that would start: %s\n' "$run_services"
# `compose config --services` lists services that are not profiled out, which
# includes the ones gated behind the `maintenance` profile (auth-admin,
# maintenance). Those do not start on `up`; only auth and runtime do. This
# assertion is about the *set*, so it checks for absence of the browser stack and
# presence of the two services rather than an exact string.
for n in browser-gate chromium cdp-relay provider fixture; do
  case " $run_services " in
    *" $n "*) echo "FAIL: $n would start in the core shape" >&2; exit 1 ;;
  esac
done
for n in auth runtime; do
  case " $run_services " in
    *" $n "*) ;;
    *) echo "FAIL: $n is missing from the core run set" >&2; exit 1 ;;
  esac
done
echo "Core run set excludes the browser stack: $run_services"

if ! compose config --format json | node -e '
  const j = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
  const bundle = j.services.runtime?.environment?.WORKSTATION_BROWSER_MCP
  const enabled = j.services.auth?.environment?.AUTH_BROWSER_ENABLED
  let bad = 0
  if (bundle !== "0") { console.log(`FAIL: WORKSTATION_BROWSER_MCP=${bundle}, expected 0`); bad++ }
  if (enabled !== "0") { console.log(`FAIL: AUTH_BROWSER_ENABLED=${enabled}, expected 0`); bad++ }
  process.exit(bad ? 1 : 0)
'; then
  echo 'FAIL: the resolved core shape is wrong' >&2
  exit 1
fi
echo 'Core shape: bundle disabled, browser proxy disabled'

compose up -d --no-build --wait --wait-timeout 420
started="$(compose ps --services --status running | sort | tr '\n' ' ')"
printf 'Running services: %s\n' "$started"
[[ "$started" == "auth runtime " ]] \
  || { echo "FAIL: core started '$started', expected only auth and runtime" >&2; exit 1; }
echo 'Only auth and runtime are running'

# --- Auth serves, and refuses /browser/ on purpose --------------------------
# /_auth/login is the public entry point ForwardAuth leaves open. There is no
# public health route: /health lives on the internal verify listener, which the
# edge reaches on 8081 rather than through the public origin.
curlcore() { curl -sS --max-time 10 --resolve workstation.test:443:127.0.0.1 --cacert "$edge_dir/cert.pem" "$@"; }
code="$(curlcore -o /dev/null -w '%{http_code}' https://workstation.test/_auth/login || true)"
[[ "$code" == 200 ]] \
  || { echo "FAIL: /_auth/login answered $code, expected 200" >&2; exit 1; }
echo 'Auth serves its login page with no browser service running'

body="$(mktemp)"
code="$(curlcore -o "$body" -w '%{http_code}' https://workstation.test/browser/ || true)"
printf '/browser/ -> %s %s\n' "$code" "$(cat "$body")"
[[ "$code" == 503 ]] || { echo "FAIL: /browser/ answered $code, expected 503" >&2; exit 1; }
grep -q 'not part of this deployment' "$body" \
  || { echo 'FAIL: the refusal did not come from the core path' >&2; exit 1; }
echo 'Core /browser/ refuses clearly instead of proxying to a missing upstream'

# --- the Bundle must not have been installed --------------------------------
if compose exec -T runtime test -e /dsh-home/profiles/web/.workstation-browser-0.1.0; then
  echo 'FAIL: the browser Bundle was installed in a core deployment' >&2
  exit 1
fi
echo 'Runtime skipped the browser Bundle'

echo 'Core deployment verified: DSH and Auth serve, the browser stack is absent'
