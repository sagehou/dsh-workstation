#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."
umask 077
domain=${1:-}
proxy=${2:-}
traefik=${3:-}
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

fresh=false
if [[ -e $state || -e .env.public ]]; then
  if [[ ! -d $state || ! -f .env.public || ! -s $state/secrets/runtime-ca.pem ]] ||
     ! grep -Fxq "WORKSTATION_DOMAIN=$domain" .env.public ||
     ! grep -Fxq "WORKSTATION_STATE=$state" .env.public; then
    echo 'The saved domain or state directory does not match. Preserve the existing secrets.' >&2
    exit 1
  fi
else
  fresh=true
  mkdir -m 0700 -- "$state"
  mkdir -- "$state/secrets"
fi
mkdir -p -- "$state/edge"
staging="$(mktemp -d "$state/.init.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
if $fresh; then
  for name in auth-key provider-admin selkies-master selkies-controller selkies-sentinel browser-enroll; do
    openssl rand -hex 32 | tr -d '\n' > "$state/secrets/$name"
  done
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1825 -subj '/CN=Workstation Runtime CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$staging/ca-key" -out "$state/secrets/runtime-ca.pem" 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=runtime' \
    -keyout "$state/secrets/runtime-key.pem" -out "$staging/request" 2>/dev/null
  cat > "$staging/san" <<'SAN'
subjectAltName=DNS:runtime,IP:172.30.241.2
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
SAN
  openssl x509 -req -in "$staging/request" -CA "$state/secrets/runtime-ca.pem" -CAkey "$staging/ca-key" \
    -CAserial "$staging/serial" -CAcreateserial -extfile "$staging/san" -days 1825 -out "$state/secrets/runtime.pem" 2>/dev/null
  # Compose mounts file secrets read-only, while the host directory stays private.
  chmod 0444 "$state"/secrets/*
  printf 'WORKSTATION_STATE=%s\nWORKSTATION_DOMAIN=%s\nBROWSER_TOOL_ORIGINS=\n' "$state" "$domain" > "$staging/env"
else
  sed -E '/^(WORKSTATION_(EDGE_UID|EDGE_GID|PROXY_NETWORK|TRAEFIK_IP)|ACME_EMAIL)=/d' .env.public > "$staging/env"
fi
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
