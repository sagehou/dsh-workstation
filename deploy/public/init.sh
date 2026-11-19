#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."
umask 077
domain=${1:-}
email=${2:-}
state=${WORKSTATION_STATE:-.workstation}
[[ $domain =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ &&
   $email =~ ^[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$ &&
   $(id -u) != 0 ]] || {
  echo 'Run as a non-root operator: bash deploy/public/init.sh workstation.example.net admin@example.net' >&2
  exit 1
}
[[ $state =~ ^[a-zA-Z0-9_./-]+$ && $state != / && ! -e $state && ! -e .env.public ]] ||
  { echo 'Deployment files already exist or the state path is invalid; preserve the existing secrets.' >&2; exit 1; }
mkdir -m 0700 -- "$state"
mkdir -- "$state/edge" "$state/acme" "$state/secrets"
staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
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
# Docker Compose implements file secrets as read-only bind mounts. The containing
# host directory stays private while each selected in-container UID can read its mount.
chmod 0444 "$state"/secrets/*
tick="$(printf '\140')"
sed -e "s|@DOMAIN_RULE@|${tick}${domain}${tick}|g" \
  -e "s|@AUTH_RULE@|${tick}/_auth/${tick}|g" \
  -e "s|@AUTH_BASE@|${tick}/_auth${tick}|g" \
  -e "s|@BROWSER_RULE@|${tick}/browser/${tick}|g" \
  -e "s|@BROWSER_BASE@|${tick}/browser${tick}|g" \
  -e "s|@TOKENS_RULE@|${tick}/browser/api/tokens${tick}|g" \
  -e "s|@UPGRADE_HEADER@|${tick}Upgrade${tick}|g" \
  -e "s|@UPGRADE_PATTERN@|${tick}(?i)^websocket\$${tick}|g" \
  deploy/public/edge.yml.in > "$state/edge/routes.yml"
touch "$state/acme/acme.json"
cat > .env.public <<CONFIG
WORKSTATION_STATE=$state
WORKSTATION_DOMAIN=$domain
WORKSTATION_EDGE_UID=$(id -u)
WORKSTATION_EDGE_GID=$(id -g)
ACME_EMAIL=$email
BROWSER_TOOL_ORIGINS=
CONFIG
printf 'Prepared .env.public and %s\n' "$state"
