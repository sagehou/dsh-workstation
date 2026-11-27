#!/usr/bin/env bash
# Derive the workstation addresses and refuse overlapping networks.
#
# Usage:
#   bash deploy/network.sh derive            # shell assignments (eval-safe)
#   bash deploy/network.sh derive --json     # the same values as JSON
#   bash deploy/network.sh check             # preflight; exits non-zero on conflict
#   bash deploy/network.sh check --routes FILE --docker-dump FILE
#
# Configuration (environment):
#   WORKSTATION_SUBNET   workstation network CIDR   (default 172.30.241.0/24)
#   WORKSTATION_ENTRY_SUBNET  preview-only edge CIDR (default 172.30.244.0/24)
#   DOCKER               docker binary              (default docker)
#
# Addresses are derived from the low end of each subnet, in a fixed order:
#   .1      Docker's gateway (never used here)
#   .2      Runtime on the workstation network
#   .3      Gateway on the workstation network
# Dynamic allocation is confined to the upper half of each subnet, so a
# container that starts first can never take a static address. That ordering
# matters: without it Docker hands out .2 and the runtime then fails to claim
# its own address with "Address already in use".
set -euo pipefail

# `-` rather than `:-`: only an unset variable takes the default. An explicitly
# empty subnet is a mistake, and defaulting it would silently deploy the
# addresses the operator was trying to avoid.
WORKSTATION_SUBNET=${WORKSTATION_SUBNET-172.30.241.0/24}
WORKSTATION_ENTRY_SUBNET=${WORKSTATION_ENTRY_SUBNET-172.30.244.0/24}
# The public CI stack creates its own throwaway Traefik proxy network. It is
# derived here too, so no script carries a literal and the fixture cannot land
# on top of a custom plan.
WORKSTATION_CI_PROXY_SUBNET=${WORKSTATION_CI_PROXY_SUBNET-172.30.242.0/24}
DOCKER=${DOCKER:-docker}

# Docker reserves the gateway and the broadcast address, so the smallest usable
# subnet is a /28 and the largest is a /16. Anything outside that range is far
# more likely to be a typo than a deliberate choice.
prefix_min=16
prefix_max=28

ip2int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  [[ $a =~ ^[0-9]{1,3}$ && $b =~ ^[0-9]{1,3}$ && $c =~ ^[0-9]{1,3}$ && $d =~ ^[0-9]{1,3}$ ]] || return 1
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || return 1
  printf '%s\n' "$(( (a << 24) | (b << 16) | (c << 8) | d ))"
}

int2ip() {
  local n=$1
  printf '%s.%s.%s.%s\n' "$(( (n >> 24) & 255 ))" "$(( (n >> 16) & 255 ))" "$(( (n >> 8) & 255 ))" "$(( n & 255 ))"
}

# Split a CIDR into its numeric network and prefix length. Host bits set in the
# address are rejected rather than silently masked: "172.30.241.7/24" is almost
# always a mistake, and masking it would hide the intent.
cidr_parse() {
  local cidr=$1 address prefix network mask
  [[ $cidr == */* ]] || { printf 'Not a CIDR: %s\n' "$cidr" >&2; return 1; }
  address=${cidr%/*}
  prefix=${cidr##*/}
  [[ $prefix =~ ^[0-9]{1,2}$ ]] || { printf 'Unsupported prefix in %s\n' "$cidr" >&2; return 1; }
  (( prefix >= prefix_min && prefix <= prefix_max )) || {
    printf 'Prefix /%s in %s is outside the supported /%s../%s\n' "$prefix" "$cidr" "$prefix_min" "$prefix_max" >&2
    return 1
  }
  local value
  value="$(ip2int "$address")" || { printf 'Not an IPv4 address: %s\n' "$address" >&2; return 1; }
  mask=$(( (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
  network=$(( value & mask ))
  (( network == value )) || {
    printf '%s has host bits set; use %s/%s instead\n' "$address" "$(int2ip "$network")" "$prefix" >&2
    return 1
  }
  printf '%s %s\n' "$network" "$prefix"
}

# Emit the derived addresses for one network: its CIDR, the dynamic pool, and
# the static hosts at .2 and .3.
derive_network() {
  local label=$1 cidr=$2 parsed network prefix size pool_start pool_prefix
  parsed="$(cidr_parse "$cidr")" || return 1
  network=${parsed% *}
  prefix=${parsed#* }
  size=$(( 1 << (32 - prefix) ))
  # The upper half is dynamic, so the static band at .2/.3 stays uncontended.
  pool_start=$(( network + size / 2 ))
  pool_prefix=$(( prefix + 1 ))
  printf '%s_SUBNET=%s/%s\n' "$label" "$(int2ip "$network")" "$prefix"
  printf '%s_IP_RANGE=%s/%s\n' "$label" "$(int2ip "$pool_start")" "$pool_prefix"
  printf '%s_STATIC_2=%s\n' "$label" "$(int2ip $(( network + 2 )))"
  printf '%s_STATIC_3=%s\n' "$label" "$(int2ip $(( network + 3 )))"
}

derive() {
  derive_network WORKSTATION "$WORKSTATION_SUBNET" || return 1
  derive_network ENTRY "$WORKSTATION_ENTRY_SUBNET" || return 1
  derive_network CI_PROXY "$WORKSTATION_CI_PROXY_SUBNET" || return 1
}

# Fold the raw derivation into the names Compose and the initializer use.
# The Gateway MCP listener keeps the previous Provider address.
# Keep any comment outside the heredoc below: `derive --json` parses its output.
named() {
  local body
  body="$(derive)" || return 1
  eval "$body"
  if overlaps "$WORKSTATION_SUBNET" "$WORKSTATION_CI_PROXY_SUBNET"; then
    printf 'The CI proxy subnet %s overlaps the workstation subnet %s\n' \
      "$WORKSTATION_CI_PROXY_SUBNET" "$WORKSTATION_SUBNET" >&2
    return 1
  fi
  cat <<EOF
WORKSTATION_SUBNET=$WORKSTATION_SUBNET
WORKSTATION_IP_RANGE=$WORKSTATION_IP_RANGE
WORKSTATION_RUNTIME_IP=$WORKSTATION_STATIC_2
WORKSTATION_PROVIDER_IP=$WORKSTATION_STATIC_3
WORKSTATION_ENTRY_SUBNET=$WORKSTATION_ENTRY_SUBNET
WORKSTATION_ENTRY_IP_RANGE=$ENTRY_IP_RANGE
WORKSTATION_ENTRY_EDGE_IP=$ENTRY_STATIC_2
WORKSTATION_CI_PROXY_SUBNET=$WORKSTATION_CI_PROXY_SUBNET
WORKSTATION_CI_PROXY_IP_RANGE=$CI_PROXY_IP_RANGE
WORKSTATION_CI_PROXY_EDGE_IP=$CI_PROXY_STATIC_2
EOF
}

# --- preflight -------------------------------------------------------------

# Convert a Linux route table destination to CIDR. /proc/net/route stores the
# destination little-endian and in hex, with the prefix as a separate field.
route_file_cidrs() {
  local file=$1 iface dest gateway flags refcnt use metric mask mtu window irtt value prefix bits
  [[ -r $file ]] || return 0
  # /proc/net/route is: Iface Destination Gateway Flags RefCnt Use Metric Mask
  # MTU Window IRTT. Reading one field short silently uses MTU as the mask, so
  # every column is named here.
  while read -r iface dest gateway flags refcnt use metric mask mtu window irtt; do
    [[ $iface == Iface ]] && continue
    [[ $dest =~ ^[0-9A-Fa-f]{8}$ && $mask =~ ^[0-9A-Fa-f]{8}$ ]] || continue
    # Little-endian hex, so the bytes are reversed before conversion.
    value=$(( 16#${dest:6:2}${dest:4:2}${dest:2:2}${dest:0:2} ))
    prefix=0
    bits=$(( 16#${mask:6:2}${mask:4:2}${mask:2:2}${mask:0:2} ))
    while (( bits & 0x80000000 )); do
      prefix=$(( prefix + 1 ))
      bits=$(( (bits << 1) & 0xFFFFFFFF ))
    done
    # The default route covers every address by definition, and every host has
    # one. Docker's own subnet route is more specific, so it wins; treating the
    # default route as a conflict would fail every host for no reason.
    (( prefix == 0 )) && continue
    printf '%s/%s\n' "$(int2ip "$value")" "$prefix"
  done <"$file"
}

# Docker network subnets, one CIDR per line. A failure to talk to Docker is not
# a conflict: the preflight must not block a host that has not started Docker
# yet, but it must say so.
docker_cidrs() {
  local dump=${1:-}
  if [[ -n $dump ]]; then
    cat -- "$dump"
    return 0
  fi
  "$DOCKER" network ls --format '{{.ID}}' 2>/dev/null | while read -r id; do
    [[ -n $id ]] || continue
    "$DOCKER" network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' "$id" 2>/dev/null
  done | sed '/^$/d' || true
}

# Numeric bounds for any IPv4 prefix. Route and Docker comparisons accept the
# full 0..32 range: a host route of /8 or /32 is normal, and rejecting it as
# "unsupported" would hide the conflict this check exists to find.
range_bounds() {
  local cidr=$1 address prefix mask value
  [[ $cidr == */* ]] || return 1
  address=${cidr%/*}
  prefix=${cidr##*/}
  [[ $prefix =~ ^[0-9]{1,2}$ ]] && (( prefix <= 32 )) || return 1
  value="$(ip2int "$address")" || return 1
  mask=$(( prefix == 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
  printf '%s %s %s\n' "$(( value & mask ))" "$prefix" "$(( 1 << (32 - prefix) ))"
}

# Two CIDRs overlap when one network starts inside the other's range.
overlaps() {
  local a b a_net a_size b_net b_size
  a="$(range_bounds "$1")" || return 2
  b="$(range_bounds "$2")" || return 2
  read -r a_net _ a_size <<<"$a"
  read -r b_net _ b_size <<<"$b"
  (( a_net < b_net + b_size && b_net < a_net + a_size ))
}

# Report a subnet that would collide with a host route or an existing Docker
# network. Both are checked because Docker happily creates a bridge that shadows
# a host route, and that failure surfaces later as unreachable containers.
check_conflict() {
  local label=$1 cidr=$2 file=$3 source
  local found=0 line
  while read -r line; do
    [[ -n $line ]] || continue
    if overlaps "$cidr" "$line"; then
      printf '  %s %s overlaps %s\n' "$label" "$cidr" "$line" >&2
      found=1
    fi
  done < <(route_file_cidrs "$file")
  return $found
}

check() {
  local routes=/proc/net/route docker_dump=
  while (( $# )); do
    case $1 in
      --routes) routes=${2:-}; shift 2 ;;
      --docker-dump) docker_dump=${2:-}; shift 2 ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; return 1 ;;
    esac
  done

  local values
  values="$(named)" || return 1
  eval "$values"

  local status=0
  printf 'Workstation network %s (dynamic %s)\n' "$WORKSTATION_SUBNET" "$WORKSTATION_IP_RANGE"
  printf 'Runtime %s, Gateway MCP %s\n' \
    "$WORKSTATION_RUNTIME_IP" "$WORKSTATION_PROVIDER_IP"

  # A host route for the whole RFC1918 block is common on VPN hosts, and a
  # conflict there is exactly what this check exists to catch.
  printf 'Checking host routes from %s\n' "$routes"
  check_conflict workstation "$WORKSTATION_SUBNET" "$routes" || status=1

  local docker_lines
  docker_lines="$(docker_cidrs "$docker_dump")"
  if [[ -z $docker_lines ]]; then
    printf 'No Docker networks reported; skipping the Docker overlap check\n'
  else
    printf 'Checking %s existing Docker subnet(s)\n' "$(printf '%s\n' "$docker_lines" | wc -l | tr -d ' ')"
    while read -r line; do
      [[ -n $line ]] || continue
      if overlaps "$WORKSTATION_SUBNET" "$line"; then
        printf '  workstation %s overlaps Docker network %s\n' "$WORKSTATION_SUBNET" "$line" >&2
        status=1
      fi
    done <<<"$docker_lines"
  fi

  if (( status )); then
    cat >&2 <<'EOF'

Refusing to continue. No network was created or changed.

Choose a different subnet, for example:

  WORKSTATION_SUBNET=10.71.241.0/24 \
    bash deploy/public/init.sh <domain> <proxy> <traefik>

Use an unused RFC1918 subnet with a /16 through /28 prefix. Re-run the preflight before
starting Compose; no existing Docker network or host route is modified here.
EOF
    return 1
  fi
  printf 'No overlap with host routes or existing Docker networks\n'
}

json() {
  local values
  values="$(named)" || return 1
  printf '%s\n' "$values" | awk -F= '
    BEGIN { printf "{" }
    { printf "%s\"%s\":\"%s\"", (NR > 1 ? "," : ""), $1, $2 }
    END { printf "}\n" }'
}

case ${1:-} in
  derive)
    shift
    case ${1:-} in
      --json) json ;;
      *) named ;;
    esac
    ;;
  check) shift; check "$@" ;;
  --help|-h) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) printf 'Usage: bash deploy/network.sh {derive [--json]|check}\n' >&2; exit 1 ;;
esac
