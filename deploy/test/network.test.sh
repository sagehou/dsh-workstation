#!/usr/bin/env bash
# Network derivation and preflight tests.
#
# Everything here runs without Docker: the preflight takes its inputs from
# files, so a host route or an existing Docker network can be simulated exactly.
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

pass() { printf 'network: %s\n' "$1"; }
fail() { printf 'network FAILED: %s\n' "$1" >&2; exit 1; }
# Run the script and capture output and status without tripping `set -e`.
run() { set +e; out="$("$@" 2>&1)"; status=$?; set -e; }

# --- 1. the defaults reproduce the documented addresses --------------------
run bash deploy/network.sh derive
(( status == 0 )) || fail "derive failed: $out"
for expected in \
  'WORKSTATION_SUBNET=172.30.241.0/24' \
  'WORKSTATION_IP_RANGE=172.30.241.128/25' \
  'WORKSTATION_RUNTIME_IP=172.30.241.2' \
  'WORKSTATION_PROVIDER_IP=172.30.241.3' \
  'BROWSER_SUBNET=172.30.233.0/24' \
  'BROWSER_IP_RANGE=172.30.233.128/25' \
  'WORKSTATION_ENTRY_SUBNET=172.30.244.0/24' \
  'WORKSTATION_ENTRY_EDGE_IP=172.30.244.2'; do
  grep -Fxq "$expected" <<<"$out" || fail "missing default $expected in: $out"
done
pass 'the defaults reproduce every address the stack used before derivation'

# --- 2. the output is eval-safe and JSON matches --------------------------
eval "$out"
[[ $WORKSTATION_RUNTIME_IP == 172.30.241.2 ]] || fail 'eval did not set WORKSTATION_RUNTIME_IP'
run bash deploy/network.sh derive --json
node -e '
  const values = JSON.parse(process.argv[1])
  const want = {
    WORKSTATION_SUBNET: "172.30.241.0/24",
    WORKSTATION_RUNTIME_IP: "172.30.241.2",
    WORKSTATION_PROVIDER_IP: "172.30.241.3",
  }
  for (const [key, value] of Object.entries(want)) {
    if (values[key] !== value) throw Error(`${key} is ${values[key]}, expected ${value}`)
  }
' "$out" || fail 'the JSON form disagrees with the shell form'
pass 'derive emits eval-safe assignments and matching JSON'

# --- 3. a custom subnet moves every derived address -----------------------
run env WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 bash deploy/network.sh derive
(( status == 0 )) || fail "custom derive failed: $out"
grep -Fxq 'WORKSTATION_RUNTIME_IP=10.71.241.2' <<<"$out" || fail 'the runtime IP did not follow the subnet'
grep -Fxq 'WORKSTATION_PROVIDER_IP=10.71.241.3' <<<"$out" || fail 'the provider IP did not follow the subnet'
grep -Fxq 'WORKSTATION_IP_RANGE=10.71.241.128/25' <<<"$out" || fail 'the dynamic range did not follow the subnet'
pass 'a custom subnet moves the static addresses and the dynamic range together'

# --- 4. invalid CIDRs are refused before anything is created -------------
for cidr in '172.30.241.7/24' '172.30.241.0/30' '172.30.241.0/12' 'not-a-cidr' \
             '172.30.241/24' '300.1.1.0/24' '172.30.241.0/24/24' ''; do
  run env WORKSTATION_SUBNET="$cidr" bash deploy/network.sh derive
  (( status != 0 )) || fail "accepted an invalid subnet: ${cidr:-<empty>}"
done
run env WORKSTATION_SUBNET='172.30.241.7/24' bash deploy/network.sh derive
grep -q '172.30.241.0/24' <<<"$out" || fail "the host-bits message did not suggest the network address: $out"
pass 'invalid, tiny, huge and non-canonical subnets are all refused with a diagnosis'

# --- 5. overlapping workstation and browser subnets are refused ----------
run env WORKSTATION_SUBNET=10.1.0.0/16 BROWSER_SUBNET=10.1.5.0/24 bash deploy/network.sh derive
(( status != 0 )) || fail 'derive accepted overlapping workstation and browser subnets'
grep -q 'overlap' <<<"$out" || fail "the overlap message is missing: $out"
run env WORKSTATION_SUBNET=10.1.0.0/24 BROWSER_SUBNET=10.1.0.0/24 bash deploy/network.sh derive
(( status != 0 )) || fail 'derive accepted identical subnets'
pass 'overlapping workstation and browser subnets are refused by derive itself'

# --- 5b. the CI-only proxy network cannot land on a real plan -----------
# ci.sh creates its own proxy network. If it overlapped the workstation or
# browser subnet, the CI stack would fight itself; the derivation refuses it.
run env WORKSTATION_SUBNET=172.30.0.0/16 BROWSER_SUBNET=10.71.233.0/24 bash deploy/network.sh derive
(( status != 0 )) || fail 'a plan overlapping the CI proxy network was accepted'
grep -q 'overlaps the workstation subnet' <<<"$out" || fail "the CI proxy overlap was not explained: $out"
pass 'a workstation subnet overlapping the CI proxy network is refused'

# --- 6. a host route conflict fails the preflight -------------------------
# /proc/net/route stores the destination little-endian. 172.30.0.0/16 is
# 00001EAC with mask 0000FFFF.
printf 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' > "$work/routes-conflict"
printf 'eth0\t00001EAC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n' >> "$work/routes-conflict"
printf 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' > "$work/routes-clear"
printf 'eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n' >> "$work/routes-clear"
: > "$work/no-docker"

run bash deploy/network.sh check --routes "$work/routes-conflict" --docker-dump "$work/no-docker"
(( status != 0 )) || fail 'a host route covering the subnet did not fail the preflight'
grep -q 'overlaps 172.30.0.0/16' <<<"$out" || fail "the conflict was not named: $out"
grep -q 'Neither network was created' <<<"$out" || fail 'the refusal did not state that nothing was changed'
pass 'a host route conflict fails the preflight and says nothing was created'

run bash deploy/network.sh check --routes "$work/routes-clear" --docker-dump "$work/no-docker"
(( status == 0 )) || fail "a clear host failed the preflight: $out"
pass 'a host without conflicts passes the preflight'

# --- 7. an existing Docker network conflict fails the preflight ----------
printf '172.30.241.0/24\n' > "$work/docker-conflict"
run bash deploy/network.sh check --routes "$work/routes-clear" --docker-dump "$work/docker-conflict"
(( status != 0 )) || fail 'an overlapping Docker network did not fail the preflight'
grep -q 'overlaps Docker network 172.30.241.0/24' <<<"$out" || fail "the Docker conflict was not named: $out"

# A subnet that only touches the boundary is not an overlap.
printf '172.30.242.0/24\n' > "$work/docker-adjacent"
run bash deploy/network.sh check --routes "$work/routes-clear" --docker-dump "$work/docker-adjacent"
(( status == 0 )) || fail "an adjacent subnet was treated as a conflict: $out"
pass 'Docker overlaps fail the preflight, adjacency does not'

# --- 8. a custom subnet that clears the conflict passes ------------------
run env WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 \
  bash deploy/network.sh check --routes "$work/routes-conflict" --docker-dump "$work/docker-conflict"
(( status == 0 )) || fail "a conflict-free custom subnet failed the preflight: $out"
pass 'a custom subnet that avoids both conflicts passes the preflight'

# --- 9. Compose resolves the same values ---------------------------------
# `docker compose config` needs the Docker CLI; when it is absent the mapping is
# checked directly so a missing daemon cannot hide a typo in compose.yml.
for file in compose.yml compose.preview.yml; do
  grep -q 'WORKSTATION_RUNTIME_IP' "$file" || fail "$file does not derive the runtime address"
  grep -q 'WORKSTATION_SUBNET' "$file" || fail "$file does not derive the workstation subnet"
done
grep -q 'BROWSER_SUBNET' compose.yml || fail 'compose.yml does not derive the browser subnet'
# No literal 172.30 address may remain outside a documented default.
if grep -nE '(^|[^-])\b172\.30\.[0-9]+\.[0-9]+' compose.yml compose.preview.yml |
     grep -vE ':-[0-9]' >"$work/literals"; then
  cat "$work/literals" >&2
  fail 'a hard-coded 172.30 address remains outside a default value'
fi
pass 'Compose derives every workstation address; literals survive only as defaults'

# A `${...}` inside a flow mapping `{key: value}` opens a nested mapping and the
# YAML parser rejects the document. That shipped once and failed every full-stack
# leg; this catches it without needing a YAML library.
if grep -nE '\{[^{}]*\$\{' compose.yml compose.preview.yml >"$work/flowmap" 2>/dev/null; then
  cat "$work/flowmap" >&2
  fail 'a variable sits inside a YAML flow mapping; use block style instead'
fi
pass 'no variable is interpolated inside a YAML flow mapping'

# Every consumer of a static address must get it from the derivation, not from
# a copy. The provider bound 172.30.241.3 from a constant and died with
# EADDRNOTAVAIL on the custom plan, so a presence check is not enough: each line
# has to name the derived variable.
check_binding() {
  local file=$1 pattern=$2 why=$3
  grep -qE "$pattern" "$file" || fail "$file does not $why"
}
check_binding compose.yml 'PROVIDER_IP: \$\{WORKSTATION_PROVIDER_IP' 'bind MCP to the derived workstation address'
check_binding compose.yml 'ipv4_address: \$\{WORKSTATION_PROVIDER_IP' 'assign Gateway its derived workstation address'
check_binding compose.yml 'ipv4_address: \$\{WORKSTATION_RUNTIME_IP' 'assign the runtime its derived address'
check_binding compose.yml 'DSH_BIND_IP: \$\{WORKSTATION_RUNTIME_IP' 'bind the runtime to its derived address'
check_binding compose.yml 'subnet: \$\{WORKSTATION_SUBNET' 'derive the workstation subnet'
check_binding compose.yml 'subnet: \$\{BROWSER_SUBNET' 'derive the browser subnet'
check_binding compose.yml 'PROVIDER_CONTROL_IP: 127\.0\.0\.1$' 'keep the provider control listener on loopback'
check_binding compose.yml 'GATE_ADDR: 127\.0\.0\.1:8082$' 'keep the input gate on loopback'
# The provider reads these from its environment; the code must not carry its own.
grep -q 'process.env.PROVIDER_IP' prototypes/m0/provider/server.mjs ||
  fail 'the provider does not read PROVIDER_IP from its environment'
grep -q 'process.env.PROVIDER_CONTROL_IP' prototypes/m0/provider/server.mjs ||
  fail 'the provider does not read PROVIDER_CONTROL_IP from its environment'
# Gateway calls the provider's loopback control listener.
if grep -q '"http://172\.30\.[0-9]' gateway/workstation.go; then
  fail 'gateway still calls the provider by a literal address'
fi
grep -q 'providerControlAddr' gateway/workstation.go ||
  fail 'gateway does not read the provider control address from configuration'
check_binding compose.yml 'GATEWAY_PROVIDER_CONTROL_ADDR: 127\.0\.0\.1:8081$' 'use the loopback control address'
check_binding gateway/main.go 'gatewayEnv\("PROVIDER_CONTROL_ADDR"' 'read the provider control address from its environment'
pass 'every consumer takes its address from the derivation'

# A literal address compiled into a shipped image cannot follow a custom subnet.
# The provider bound 172.30.241.3 from a constant and died with EADDRNOTAVAIL on
# the custom plan; this is the check that would have caught it.
# A literal is acceptable only where it is a fallback for an environment
# variable or the non-public prototype branch. A bare literal is not.
address_re='172\.30\.[0-9]{1,3}\.[0-9]{1,3}'
: >"$work/baked"
while IFS= read -r line; do
  # `file:lineno:content`
  body=${line#*:*:}
  case $body in
    *'process.env'*|*'??'*|*'publicMode ?'*|*'publicMode &&'*) continue ;;
    # A fallback assigned when the configured value is empty is still
    # configured; the guard exists to catch an unconditional literal.
    *'controlAddr ='*|*'Host ='*) continue ;;
  esac
  printf '%s\n' "$line" >>"$work/baked"
done < <(grep -nE "$address_re" prototypes/m0/provider/server.mjs gateway/workstation.go 2>/dev/null || true)
if [[ -s $work/baked ]]; then
  cat "$work/baked" >&2
  fail 'a shipped image binds a literal address instead of a configured one'
fi
pass 'no shipped image hard-codes a routable address'

# Every ${VAR:-default} must equal the derived value, or an existing deployment
# without an override would move to a different address when it upgrades.
node --input-type=module -e '
  import { execFileSync } from "node:child_process"
  import { readFileSync } from "node:fs"
  const derived = JSON.parse(execFileSync("bash", ["deploy/network.sh", "derive", "--json"], { encoding: "utf8" }))
  const pattern = /\$\{(WORKSTATION_(?:SUBNET|IP_RANGE|RUNTIME_IP|PROVIDER_IP|ENTRY_SUBNET|ENTRY_IP_RANGE|ENTRY_EDGE_IP)|BROWSER_(?:SUBNET|IP_RANGE)):-([^}]*)\}/g
  let checked = 0
  const bad = []
  for (const file of ["compose.yml", "compose.preview.yml"]) {
    for (const [, name, fallback] of readFileSync(file, "utf8").matchAll(pattern)) {
      checked += 1
      if (derived[name] !== fallback) bad.push(`${file}: ${name} falls back to ${fallback}, derivation gives ${derived[name]}`)
    }
  }
  if (checked === 0) throw Error("no network variables found in the Compose files")
  if (bad.length) throw Error(bad.join("\n"))
  console.log(`  ${checked} Compose defaults match the derivation`)
' || fail 'a Compose default disagrees with the derivation'
pass 'every Compose default equals the value the derivation produces'

printf 'network OK: derivation, custom subnets, invalid input, route and Docker conflicts\n'
