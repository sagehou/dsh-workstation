#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."
umask 077
reissue=false
# A released deployment pulls digest-pinned images from GHCR. The default builds
# them locally, which is what CI and development do; neither mode ever writes a
# floating tag into .env.public.
release=false
args=()
for arg in "$@"; do
  case $arg in
    --reissue) reissue=true ;;
    --release) release=true ;;
    *) args+=("$arg") ;;
  esac
done
domain=${args[0]:-}
proxy=${args[1]:-}
traefik=${args[2]:-}
state=${WORKSTATION_STATE:-.workstation}
entrypoint=${WORKSTATION_TRAEFIK_ENTRYPOINT:-websecure}
resolver=${WORKSTATION_TRAEFIK_RESOLVER-letsencrypt}
name_pattern='^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'
[[ $domain =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ &&
   $state =~ ^[a-zA-Z0-9_./-]+$ && $state != / &&
   $proxy =~ $name_pattern && $traefik =~ $name_pattern && $entrypoint =~ $name_pattern &&
   ( -z $resolver || $resolver =~ $name_pattern ) && $(id -u) != 0 ]] || {
  echo 'Run as a non-root Docker operator: bash deploy/public/init.sh workstation.example.net proxy traefik' >&2
  exit 1
}
traefik_ip="$(docker inspect --type container --format "{{with index .NetworkSettings.Networks \"$proxy\"}}{{.IPAddress}}{{end}}" "$traefik")"
[[ $traefik_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
  echo 'The running Traefik container needs an IPv4 address on the selected proxy network.' >&2
  exit 1
}

# Every address below is derived from the two configured subnets. Nothing is
# created before the preflight passes, so a conflict cannot leave a half-built
# state directory or a new Docker network behind.
derived="$(bash deploy/network.sh derive)" || exit 1
eval "$derived"
bash deploy/network.sh check || exit 1

fresh=false
if [[ -e $state || -e .env.public ]]; then
  if [[ ! -d $state || ! -f .env.public || ! -s $state/secrets/runtime-ca.pem ]] ||
     ! grep -Fxq "WORKSTATION_DOMAIN=$domain" .env.public ||
     ! grep -Fxq "WORKSTATION_STATE=$state" .env.public; then
    echo 'The saved domain or state directory does not match. Preserve the existing secrets.' >&2
    exit 1
  fi
  # The Runtime certificate SAN is issued for the configured address. Changing
  # a subnet under an existing state directory would leave a certificate that
  # no longer matches the address Compose assigns, so the mismatch is refused
  # rather than silently reissued. `--reissue` is the deliberate path.
  saved_subnet="$(sed -n 's/^WORKSTATION_SUBNET=//p' .env.public)"
  saved_browser="$(sed -n 's/^BROWSER_SUBNET=//p' .env.public)"
  # A state directory created before derivation has no recorded subnets. It
  # keeps its certificate and simply gains the derived keys, because the
  # default subnets are what it was created with.
  if [[ -n $saved_subnet && -n $saved_browser &&
        ( $saved_subnet != "$WORKSTATION_SUBNET" || $saved_browser != "$BROWSER_SUBNET" ) ]]; then
    if ! $reissue; then
      cat >&2 <<EOF
The saved subnets differ from the requested ones:

  saved:    workstation $saved_subnet, browser $saved_browser
  requested: workstation $WORKSTATION_SUBNET, browser $BROWSER_SUBNET

The Runtime certificate was issued for $WORKSTATION_RUNTIME_IP. Reissuing it
replaces the internal CA, which every service trusts, so this is deliberate:

  bash deploy/public/init.sh <domain> <proxy> <traefik> --reissue

Existing containers keep their old addresses until they are recreated.
EOF
      exit 1
    fi
    # A deliberate subnet change reissues the internal CA and the Runtime
    # certificate. Both are derived from the new address; the other secrets are
    # left untouched so sessions and credentials survive.
    reissue_runtime_pki=true
  fi
else
  fresh=true
  mkdir -m 0700 -- "$state"
  mkdir -- "$state/secrets"
fi
mkdir -p -- "$state/edge"
staging="$(mktemp -d "$state/.init.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
# Issue the internal CA and the Runtime certificate for WORKSTATION_RUNTIME_IP.
# Reissuing replaces the CA that every service trusts, so it only happens on a
# fresh state directory or after an explicit --reissue.
issue_runtime_pki() {
  # Compose mounts these read-only (0444), so a reissue has to reopen them for
  # writing first. Without this, openssl fails and `set -e` aborts after the CA
  # has already been replaced, leaving a half-issued PKI.
  chmod u+w -- "$state/secrets/runtime-ca.pem" "$state/secrets/runtime.pem" \
    "$state/secrets/runtime-key.pem" 2>/dev/null || true
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1825 -subj '/CN=Workstation Runtime CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$staging/ca-key" -out "$state/secrets/runtime-ca.pem" 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=runtime' \
    -keyout "$state/secrets/runtime-key.pem" -out "$staging/request" 2>/dev/null
  cat > "$staging/san" <<SAN
subjectAltName=DNS:runtime,IP:${WORKSTATION_RUNTIME_IP}
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
SAN
  openssl x509 -req -in "$staging/request" -CA "$state/secrets/runtime-ca.pem" -CAkey "$staging/ca-key" \
    -CAserial "$staging/serial" -CAcreateserial -extfile "$staging/san" -days 1825 -out "$state/secrets/runtime.pem" 2>/dev/null
  # Compose mounts file secrets read-only, while the host directory stays private.
  chmod 0444 "$state"/secrets/*
}

if $fresh; then
  for name in auth-key provider-admin selkies-master selkies-controller selkies-sentinel browser-enroll gate-control maintenance; do
    openssl rand -hex 32 | tr -d '\n' > "$state/secrets/$name"
  done
  issue_runtime_pki
elif [[ ${reissue_runtime_pki:-false} == true ]]; then
  issue_runtime_pki
fi

# Resolve the four self-built images once, before anything is written. In
# release mode a missing digest is fatal: silently falling back to a local tag
# is exactly the mutable reference #10 exists to remove.
# Capture, then split: a failing process substitution inside `while` does not
# fail the loop, so the resolver's status has to be checked directly.
if $release; then
  images_text="$(bash deploy/public/images.sh)" || exit 1
else
  images_text="$(bash deploy/public/images.sh --local)" || exit 1
fi
images=()
while IFS= read -r line; do images+=("$line"); done <<< "$images_text"
(( ${#images[@]} == 4 )) || {
  echo "Expected four images from the resolver, got ${#images[@]}." >&2
  exit 1
}
image_keys=()
for line in "${images[@]}"; do
  case ${line%%=*} in
    runtime) image_keys+=("WORKSTATION_RUNTIME_IMAGE=${line#*=}") ;;
    auth) image_keys+=("WORKSTATION_AUTH_IMAGE=${line#*=}") ;;
    provider) image_keys+=("WORKSTATION_PROVIDER_IMAGE=${line#*=}") ;;
    browser-gate) image_keys+=("WORKSTATION_GATE_IMAGE=${line#*=}") ;;
    *) echo "Unexpected image in the resolver: ${line%%=*}" >&2; exit 1 ;;
  esac
done

if $fresh; then
  {
    printf 'WORKSTATION_STATE=%s\nWORKSTATION_DOMAIN=%s\nBROWSER_TOOL_ORIGINS=\n' "$state" "$domain"
    printf '%s\n' "$derived"
  } > "$staging/env"
else
  # Rewrite the derived keys from the current configuration instead of carrying
  # the old ones forward: a stale subnet in .env.public would disagree with the
  # certificate the initializer just issued.
  sed -E '/^(WORKSTATION_(EDGE_UID|EDGE_GID|PROXY_NETWORK|TRAEFIK_IP|SUBNET|IP_RANGE|RUNTIME_IP|PROVIDER_IP|ENTRY_SUBNET|ENTRY_IP_RANGE|ENTRY_EDGE_IP|RUNTIME_IMAGE|AUTH_IMAGE|PROVIDER_IMAGE|GATE_IMAGE)|BROWSER_(SUBNET|IP_RANGE|PROVIDER_IP)|ACME_EMAIL)=/d' \
    .env.public > "$staging/env"
  printf '%s\n' "$derived" >> "$staging/env"
fi
# Written last so a mode switch cannot leave a stale reference in place.
printf '%s\n' "${image_keys[@]}" >> "$staging/env"
printf 'WORKSTATION_PROXY_NETWORK=%s\nWORKSTATION_TRAEFIK_IP=%s\n' "$proxy" "$traefik_ip" >> "$staging/env"

tls='{}'
if [[ -n $resolver ]]; then tls="{certResolver: '$resolver'}"; fi
tick="$(printf '\140')"
sed 's/^/          /' "$state/secrets/runtime-ca.pem" > "$staging/runtime-ca"
sed -e "s|@ENTRYPOINT@|${entrypoint}|g" \
  -e "s|@TLS@|${tls}|g" \
  -e "s|@DOMAIN_RULE@|${tick}${domain}${tick}|g" \
  -e "s|@AUTH_RULE@|${tick}/_auth/${tick}|g" \
  -e "s|@AUTH_BASE@|${tick}/_auth${tick}|g" \
  -e "s|@BROWSER_RULE@|${tick}/browser/${tick}|g" \
  -e "s|@BROWSER_BASE@|${tick}/browser${tick}|g" \
  -e "s|@TOKENS_RULE@|${tick}/browser/api/tokens${tick}|g" \
  -e "s|@UPGRADE_HEADER@|${tick}Upgrade${tick}|g" \
  -e "s|@UPGRADE_PATTERN@|${tick}(?i)^websocket\$${tick}|g" \
  -e "/^@RUNTIME_CA@$/r $staging/runtime-ca" -e '/^@RUNTIME_CA@$/d' \
  deploy/public/edge.yml.in > "$staging/routes.yml"
mv -- "$staging/routes.yml" "$state/edge/routes.yml"
mv -- "$staging/env" .env.public
printf 'Prepared .env.public and %s/edge/routes.yml\n' "$state"
if $release; then printf 'Images (published digests):\n'; else printf 'Images (local build):\n'; fi
printf '  %s\n' "${image_keys[@]}"
