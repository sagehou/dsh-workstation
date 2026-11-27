#!/usr/bin/env bash
# Initializer tests: repeatability, certificate/address consistency, and the
# refusal to silently reissue the internal CA.
#
# The initializer talks to Docker only to read the Traefik container's address,
# so a stub `docker` on PATH is enough. Nothing here needs a daemon.
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

pass() { printf 'init: %s\n' "$1"; }
fail() { printf 'init FAILED: %s\n' "$1" >&2; exit 1; }
run() { set +e; out="$("$@" 2>&1)"; status=$?; set -e; }

# A stub docker that reports one Traefik container on the proxy network and no
# existing networks, so the preflight has a clean host.
mkdir -p "$work/bin"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"inspect --type container"*) printf '%s\n' 172.20.0.9 ;;
  "network ls"*) exit 0 ;;
  *"network inspect"*) exit 0 ;;
esac
exit 0
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"

state="$work/state"
domain=workstation.example.net
repo="$PWD"

# The initializer writes .env.public into its working directory, and it must
# run from the repository root. Each scenario therefore gets a copy of deploy/
# and its own working directory, so one case cannot read another's environment.
scenario() {
  local dir="$work/run-$1"
  mkdir -p "$dir"
  cp -a "$repo/deploy" "$dir/deploy"
  printf '%s\n' "$dir"
}

# --- 1. first run creates secrets, a SAN-bearing certificate and the env ---
workdir="$(scenario first)"
cd "$workdir"
run env WORKSTATION_STATE="$state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status == 0 )) || fail "the first init failed: $out"
[[ -f .env.public ]] || fail 'init did not write .env.public'
for name in auth-key provider-admin selkies-master selkies-controller selkies-sentinel browser-enroll \
            maintenance runtime-ca.pem runtime.pem runtime-key.pem; do
  [[ -s $state/secrets/$name ]] || fail "init did not create secrets/$name"
done
grep -Fxq 'WORKSTATION_SUBNET=172.30.241.0/24' .env.public || fail '.env.public lacks the derived workstation subnet'
grep -Fxq 'WORKSTATION_RUNTIME_IP=172.30.241.2' .env.public || fail '.env.public lacks the derived runtime address'
pass 'first run creates the secrets, the derived environment and the certificate'

# The certificate must name the address Compose actually assigns.
openssl x509 -in "$state/secrets/runtime.pem" -noout -ext subjectAltName > "$work/san"
grep -q 'IP Address:172\.30\.241\.2' "$work/san" ||
  fail "the certificate SAN does not name the derived runtime address: $(cat "$work/san")"
pass 'the Runtime certificate SAN is derived from the configured address'

# --- 2. repeating init preserves every secret and the CA ------------------
cd "$workdir"
ca_before="$(openssl x509 -in "$state/secrets/runtime-ca.pem" -noout -fingerprint -sha256)"
key_before="$(sha256sum "$state/secrets/auth-key" | cut -d' ' -f1)"
cert_before="$(openssl x509 -in "$state/secrets/runtime.pem" -noout -fingerprint -sha256)"
cd "$workdir"
run env WORKSTATION_STATE="$state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status == 0 )) || fail "the repeated init failed: $out"
[[ "$(openssl x509 -in "$state/secrets/runtime-ca.pem" -noout -fingerprint -sha256)" == "$ca_before" ]] ||
  fail 'the repeated init replaced the internal CA'
[[ "$(openssl x509 -in "$state/secrets/runtime.pem" -noout -fingerprint -sha256)" == "$cert_before" ]] ||
  fail 'the repeated init replaced the Runtime certificate'
[[ "$(sha256sum "$state/secrets/auth-key" | cut -d' ' -f1)" == "$key_before" ]] ||
  fail 'the repeated init replaced a shared secret'
pass 'repeated initialization preserves the CA, the certificate and every secret'

rm -- "$state/secrets/maintenance"
printf 'WORKSTATION_AUTH_IMAGE=dsh-workstation-auth:0.1.1\nAUTH_IDLE=42m\n' >> .env.public
printf 'WORKSTATION_PROVIDER_IMAGE=old-provider\nWORKSTATION_GATE_IMAGE=old-gate\nBROWSER_PROVIDER_IP=172.30.233.2\nBROWSER_GATE_IP=172.30.233.4\n' >> .env.public
sed -i '/^WORKSTATION_GATEWAY_IMAGE=/d' .env.public
sed -i 's/dsh-workstation-gateway/dsh-workstation-auth/g' "$state/edge/routes.yml"
run env WORKSTATION_STATE="$state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status == 0 )) || fail "the gateway migration failed: $out"
grep -q '^WORKSTATION_GATEWAY_IMAGE=dsh-workstation-gateway:' .env.public || fail 'the gateway image was not recorded'
if grep -Eq '^(WORKSTATION_(AUTH|PROVIDER|GATE)_IMAGE|BROWSER_(PROVIDER|GATE)_IP)=' .env.public; then
  fail 'an obsolete service setting survived migration'
fi
grep -Fxq 'AUTH_IDLE=42m' .env.public || fail 'the saved session limit was lost'
grep -Fq 'dsh-workstation-gateway-edge:8081/verify' "$state/edge/routes.yml" || fail 'ForwardAuth still uses the old alias'
[[ $(stat -c '%s:%a' "$state/secrets/maintenance") == 64:444 ]] || fail 'missing or unreadable maintenance secret'
[[ "$(sha256sum "$state/secrets/auth-key" | cut -d' ' -f1)" == "$key_before" ]] || fail 'migration replaced the authentication key'
[[ "$(openssl x509 -in "$state/secrets/runtime-ca.pem" -noout -fingerprint -sha256)" == "$ca_before" ]] || fail 'migration replaced the CA'
pass 'legacy initialization moves the image and routes to gateway while keeping saved settings and keys'

# --- 3. a changed subnet is refused without --reissue --------------------
cd "$workdir"
run env WORKSTATION_STATE="$state" WORKSTATION_TRAEFIK_RESOLVER='' \
  WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status != 0 )) || fail 'a subnet change was accepted without --reissue'
grep -q 'saved subnets differ' <<<"$out" || fail "the refusal did not explain the mismatch: $out"
[[ "$(openssl x509 -in "$state/secrets/runtime-ca.pem" -noout -fingerprint -sha256)" == "$ca_before" ]] ||
  fail 'a refused subnet change still replaced the CA'
grep -Fxq 'WORKSTATION_SUBNET=172.30.241.0/24' .env.public ||
  fail 'a refused subnet change still rewrote .env.public'
pass 'a subnet change is refused, and nothing on disk changes'

# --- 4. --reissue rebuilds the PKI for the new address -------------------
cd "$workdir"
run env WORKSTATION_STATE="$state" WORKSTATION_TRAEFIK_RESOLVER='' \
  WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 \
  bash deploy/public/init.sh "$domain" proxy traefik --reissue
(( status == 0 )) || fail "the reissue failed: $out"
openssl x509 -in "$state/secrets/runtime.pem" -noout -ext subjectAltName > "$work/san-new"
grep -q 'IP Address:10\.71\.241\.2' "$work/san-new" ||
  fail "the reissued certificate does not name the new address: $(cat "$work/san-new")"
[[ "$(openssl x509 -in "$state/secrets/runtime-ca.pem" -noout -fingerprint -sha256)" != "$ca_before" ]] ||
  fail '--reissue reused the old CA'
[[ "$(sha256sum "$state/secrets/auth-key" | cut -d' ' -f1)" == "$key_before" ]] ||
  fail '--reissue replaced a shared secret it should have kept'
grep -Fxq 'WORKSTATION_SUBNET=10.71.241.0/24' .env.public || fail 'the reissue did not record the new subnet'
grep -Fxq 'WORKSTATION_RUNTIME_IP=10.71.241.2' .env.public || fail 'the reissue did not record the new address'
# Exactly one of each key: the old values are replaced, not appended to.
for key in WORKSTATION_SUBNET WORKSTATION_IP_RANGE WORKSTATION_RUNTIME_IP BROWSER_SUBNET; do
  count="$(grep -c "^$key=" .env.public || true)"
  [[ $count == 1 ]] || fail ".env.public has $count $key lines, expected 1"
done
pass '--reissue rebuilds the PKI for the new address and keeps the other secrets'

# --- 5. the preflight runs before any state is created ------------------
workdir="$(scenario preflight)"
cd "$workdir"
fresh="$work/fresh"
# The conflict must overlap the subnets being requested, otherwise the
# preflight correctly passes and the test proves nothing.
printf '10.71.0.0/16\n' > "$work/docker-conflict"
cat > "$work/bin/docker" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *"inspect --type container"*) printf '%s\n' 172.20.0.9 ;;
  "network ls --format"*) printf '%s\n' fake-id ;;
  *"network inspect"*) printf '%s\n' "$(cat "$work/docker-conflict")" ;;
esac
exit 0
STUB
chmod +x "$work/bin/docker"
run env WORKSTATION_STATE="$fresh" WORKSTATION_TRAEFIK_RESOLVER='' \
  WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status != 0 )) || fail 'init continued past a Docker network conflict'
[[ ! -e $fresh ]] || fail 'init created the state directory before the preflight passed'
pass 'a conflict fails before the state directory exists'

# --- 6. image references: local by default, digest-pinned with --release ---
#
# The two modes write the same keys, so a deployment cannot end up with a
# mixture, and re-running with the other mode must replace them rather than
# append a second copy that Compose would resolve inconsistently.
workdir="$(scenario images)"
cd "$workdir"
images_state="$work/images-state"
digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

run env WORKSTATION_STATE="$images_state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status == 0 )) || fail "the local-build init failed: $out"
# Derive the expected tags from the matrix: hardcoding them made this check fail
# on every version bump instead of on a real regression.
local_tag() { awk -v name="$1" '$1 == name { printf "dsh-workstation-%s:%s", name, $2 }' deploy/public/images.env; }
grep -Fxq "WORKSTATION_RUNTIME_IMAGE=$(local_tag runtime)" .env.public ||
  fail 'the default mode did not record the local runtime tag'
grep -Fxq "WORKSTATION_GATEWAY_IMAGE=$(local_tag gateway)" .env.public ||
  fail 'the default mode did not record the local gateway tag'
grep -q '@sha256:' .env.public && fail 'the default mode wrote a digest reference'
pass 'without --release the two images are recorded as local build tags'

# An unpublished image must stop the initializer instead of falling back to a
# tag: that fallback is the mutable reference this whole mechanism removes.
#
# The tracked matrix records real digests once a release has happened, so the
# unpublished state is constructed here. Reading the checked-in file would make
# this case depend on whether a release had run.
cp -- deploy/public/images.env "$work/images-matrix-backup"
for name in runtime gateway; do
  awk -v name="$name" '$1 == name { printf "%s %s\n", name, $2; next } { print }' \
    deploy/public/images.env > deploy/public/images.env.tmp
  mv deploy/public/images.env.tmp deploy/public/images.env
done
run env WORKSTATION_STATE="$images_state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik --release
(( status != 0 )) || fail '--release accepted an unpublished image'
grep -q 'is not published yet' <<<"$out" || fail "--release did not explain the missing digest: $out"
grep -Fxq "WORKSTATION_RUNTIME_IMAGE=$(local_tag runtime)" .env.public ||
  fail 'a failed --release run damaged the existing image keys'
pass '--release refuses an unpublished image and leaves the recorded keys intact'

# With digests recorded, every reference is registry-qualified and pinned.
for name in runtime gateway; do
  awk -v name="$name" -v digest="$digest" '
    $1 == name { printf "%s %s %s\n", name, $2, digest; next } { print }
  ' deploy/public/images.env > deploy/public/images.env.tmp
  mv deploy/public/images.env.tmp deploy/public/images.env
done
run env WORKSTATION_STATE="$images_state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik --release
(( status == 0 )) || fail "the release init failed: $out"
for key in WORKSTATION_RUNTIME_IMAGE WORKSTATION_GATEWAY_IMAGE; do
  line="$(grep "^$key=" .env.public)"
  [[ $line == *'ghcr.io/sagehou/'*'@'$digest ]] || fail "$key is not a pinned GHCR reference: $line"
  count="$(grep -c "^$key=" .env.public || true)"
  [[ $count == 1 ]] || fail ".env.public has $count $key lines after switching modes"
done
pass '--release writes two digest-pinned references and replaces the local tags'

# Switching back must replace them again, not append.
run env WORKSTATION_STATE="$images_state" WORKSTATION_TRAEFIK_RESOLVER='' \
  bash deploy/public/init.sh "$domain" proxy traefik
(( status == 0 )) || fail "the mode switch back failed: $out"
count="$(grep -c '^WORKSTATION_RUNTIME_IMAGE=' .env.public || true)"
[[ $count == 1 ]] || fail ".env.public has $count runtime image lines after switching back"
grep -q '@sha256:' .env.public && fail 'switching back to a local build left a digest reference'
pass 'switching back to a local build replaces the pinned references'

printf 'init OK: repeatability, SAN derivation, subnet-change refusal, reissue, preflight ordering and image references\n'
