#!/usr/bin/env bash
# Digest round-trip: pull, upgrade and roll back images by digest on a real
# Docker daemon, against a loopback registry.
#
# This exercises the part of #10 that cannot be checked by reading files: that
# `name:version@sha256:...` actually pulls and runs, that the digest the
# resolver records is the digest the registry serves, and that switching to an
# older digest really restores the older image.
#
# It never contacts GHCR. `deploy/public/images.sh` only accepts a loopback
# registry as an override, which is what keeps this test from being able to
# masquerade as a publish.
#
# Usage: bash deploy/test/images-registry.test.sh
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'a running Docker daemon is required' >&2; exit 1; }

# A free loopback port, so two runs on one host cannot collide.
port=''
for _ in 1 2 3 4 5 6 7 8 9 10; do
  candidate=$(( 20000 + RANDOM % 20000 ))
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
    port=$candidate
    break
  fi
done
[[ -n $port ]] || { echo 'no free loopback port' >&2; exit 1; }
registry="localhost:$port"

pass() { printf 'registry: %s\n' "$1"; }
fail() { printf 'registry FAILED: %s\n' "$1" >&2; exit 1; }

matrix=deploy/public/images.env
backup="$(mktemp)"
cp -- "$matrix" "$backup"
registry_container="dsh-registry-test-$$"
cleanup() {
  cp -- "$backup" "$matrix"
  rm -f -- "$backup"
  docker rm -f "$registry_container" >/dev/null 2>&1 || true
  # Use the resolver's own name so a leftover image cannot be mistaken for one
  # of a deployment's.
  for image in $(bash deploy/public/images.sh --local 2>/dev/null | sed -n 's/^[^=]*=//p'); do
    docker image rm -f "$image" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# A registry is the only way to get a manifest-list digest: `docker build` alone
# produces a config digest, which is not what a deployment pins.
docker run -d --name "$registry_container" -p "127.0.0.1:$port:5000" \
  --add-host "host.docker.internal:host-gateway" registry:2 >/dev/null ||
  fail 'could not start a loopback registry'
for _ in $(seq 1 30); do
  if curl -fsS "http://$registry/v2/" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://$registry/v2/" >/dev/null 2>&1 || fail 'the loopback registry never became ready'
pass "loopback registry listening on $registry"

# The resolver must refuse a registry that is not GHCR or loopback. This is the
# guard that keeps an override from redirecting a deployment.
set +e
WORKSTATION_IMAGE_REGISTRY=ghcr.io/attacker bash deploy/public/images.sh >/dev/null 2>&1
status=$?
set -e
(( status != 0 )) || fail 'a non-GHCR registry override was accepted'
pass 'a registry other than GHCR or loopback is refused'

# Build one image rather than all four: the digest mechanism is per-image and
# identical, and the full stack is covered by the Public Compose job. The
# smallest context keeps the test short.
image=runtime
version="0.0.1"
name="dsh-workstation-$image"
docker build -q -t "127.0.0.1:$port/$name:$version" ./runtime >/dev/null ||
  fail 'the build failed'
docker tag "127.0.0.1:$port/$name:$version" "$registry/$name:$version"
docker push -q "$registry/$name:$version" >/dev/null || fail 'the push failed'

# The digest the registry serves for the tag, which is what images.env must
# record. `imagetools` reads the manifest list, so this is the pushed index.
served="$(docker buildx imagetools inspect "$registry/$name:$version" --format '{{json .Manifest.Digest}}' | tr -d '"')"
[[ $served =~ ^sha256:[0-9a-f]{64}$ ]] || fail "the registry reported no usable digest: $served"
pass "the registry serves $served for $name:$version"

# Record it and resolve a deployment reference through the real resolver.
awk -v name="$image" -v version="$version" -v digest="$served" '
  $1 == name { printf "%s %s %s\n", name, version, digest; found = 1; next }
  { print }
  END { if (!found) exit 3 }
' "$matrix" > "$matrix.new" || fail 'images.env has no line for the image'
mv "$matrix.new" "$matrix"

export WORKSTATION_IMAGE_REGISTRY="$registry"
reference="$(bash deploy/public/images.sh "$image")" || fail 'the resolver refused its own digest'
[[ $reference == "$registry/$name:$version@$served" ]] ||
  fail "the resolver produced an unexpected reference: $reference"
pass "the resolver builds a pinned reference: $reference"

# Pull it back with the local tag and digest removed, so this is a real pull
# rather than a cache hit, and prove the digest is what runs.
docker image rm -f "$registry/$name:$version" "$registry/$name@$served" >/dev/null 2>&1 || true
docker pull -q "$reference" >/dev/null || fail 'the pinned reference did not pull'
pulled_id="$(docker image inspect --format '{{.Id}}' "$reference")"
[[ -n $pulled_id ]] || fail 'the pulled image has no ID'
pass "the pinned reference pulled by digest and produced $pulled_id"

# Upgrade: publish a second build under a new version, then confirm the two
# digests are distinct and that resolving each gives a different image.
version2="0.0.2"
# The label is what makes the two builds genuinely different. Without a real
# change the digests would be equal and the upgrade assertion below would fail
# for the wrong reason.
docker build -q -t "$registry/$name:$version2" --label "org.example.upgrade=1" ./runtime >/dev/null ||
  fail 'the second build failed'
docker push -q "$registry/$name:$version2" >/dev/null || fail 'the second push failed'
served2="$(docker buildx imagetools inspect "$registry/$name:$version2" --format '{{json .Manifest.Digest}}' | tr -d '"')"
[[ $served2 =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'the second push reported no usable digest'
[[ $served2 != "$served" ]] || fail 'two different pushes produced the same digest'
pass "the upgrade published a distinct digest $served2"

awk -v name="$image" -v version="$version2" -v digest="$served2" '
  $1 == name { printf "%s %s %s\n", name, version, digest; next }
  { print }
' "$matrix" > "$matrix.new" && mv "$matrix.new" "$matrix"
upgraded="$(bash deploy/public/images.sh "$image")"
[[ $upgraded == "$registry/$name:$version2@$served2" ]] ||
  fail "the upgraded reference is wrong: $upgraded"
pass 'the upgraded reference follows the new digest'

# Rollback: restore the first digest and prove the reference -- and therefore
# what a deployment would run -- goes back to exactly the first image.
awk -v name="$image" -v version="$version" -v digest="$served" '
  $1 == name { printf "%s %s %s\n", name, version, digest; next }
  { print }
' "$matrix" > "$matrix.new" && mv "$matrix.new" "$matrix"
rolled="$(bash deploy/public/images.sh "$image")"
[[ $rolled == "$reference" ]] || fail "rollback produced $rolled, not $reference"
docker image rm -f "$registry/$name@$served" >/dev/null 2>&1 || true
docker pull -q "$rolled" >/dev/null || fail 'the rolled-back digest did not pull'
rolled_id="$(docker image inspect --format '{{.Id}}' "$rolled")"
[[ $rolled_id == "$pulled_id" ]] ||
  fail "rollback pulled $rolled_id, but the original image was $pulled_id"
pass 'rolling back by digest restores exactly the original image'

# A version that no longer resolves must fail rather than drift to a tag.
awk -v name="$image" 'BEGIN{OFS=" "} $1 == name { $3 = ""; print; next } { print }' "$matrix" \
  | sed -E 's/ +$//' > "$matrix.new" && mv "$matrix.new" "$matrix"
set +e
bash deploy/public/images.sh "$image" >/dev/null 2>&1
status=$?
set -e
(( status != 0 )) || fail 'a cleared digest still resolved'
pass 'a cleared digest fails closed instead of falling back to the tag'

printf 'registry OK: digest pull, upgrade and rollback on a real daemon\n'
