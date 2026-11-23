#!/usr/bin/env bash
# Tests for deploy/public/images.sh.
#
# The resolver is the thing that decides what a deployment runs, so its failure
# modes matter more than its happy path: an image that has never been published
# must never resolve to a floating tag, and a malformed digest must be refused
# rather than skipped.
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

resolver=deploy/public/images.sh
matrix=deploy/public/images.env
work_matrix_backup="$(mktemp)"
# Restore from a copy, not from a variable: command substitution strips the
# trailing newline, which silently changed the tracked file.
cp -- "$matrix" "$work_matrix_backup"
scratch="$(mktemp -d)"
trap 'cp -- "$work_matrix_backup" "$matrix"; rm -rf -- "$scratch" "$work_matrix_backup"' EXIT
# The matrix is tracked, so restoring it on any exit keeps a failed assertion
# from leaving a modified file behind.

digest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$(( failures + 1 )); }
check() {
  local label=$1 expected=$2 actual=$3
  if [[ $actual == "$expected" ]]; then pass "$label"; else fail "$label: expected [$expected], got [$actual]"; fi
}
check_status() {
  local label=$1 expected=$2 actual=$3
  if [[ $actual == "$expected" ]]; then pass "$label"; else fail "$label: expected exit $expected, got $actual"; fi
}

# Every image is listed exactly once, and the four names match compose.yml.
check 'lists four images' 'runtime auth provider browser-gate' "$(bash "$resolver" --names | tr '\n' ' ' | sed 's/ $//')"

# `--local` produces the development tags that compose.yml builds.
check 'local runtime tag' 'runtime=dsh-workstation-runtime:0.2.0' "$(bash "$resolver" --local runtime)"

# An unpublished version is refused, and nothing is printed on stdout.
set +e
out="$(bash "$resolver" runtime 2>/dev/null)"; status=$?
set -e
check_status 'unpublished image exits non-zero' 1 "$status"
check 'unpublished image prints no reference' '' "$out"

# The same holds for JSON, which would otherwise be valid but empty.
set +e
bash "$resolver" --json >/dev/null 2>&1; status=$?
set -e
check_status 'json refuses an unpublished image' 1 "$status"

# With a digest recorded, the reference is registry-qualified, tagged and pinned.
printf 'runtime 0.2.0 %s\n' "$digest" > "$matrix"
check 'pinned reference' \
  "runtime=ghcr.io/sagehou/dsh-workstation-runtime:0.2.0@$digest" \
  "$(bash "$resolver" runtime)"
check 'digest field' "$digest" "$(bash "$resolver" --field digest runtime)"
check 'version field' '0.2.0' "$(bash "$resolver" --field version runtime)"

# Tag without digest would still be resolvable as a bare tag if the code were
# careless, so pin the exact shape: the reference must contain "@sha256:".
case "$(bash "$resolver" runtime)" in
  *@sha256:*) pass 'reference carries a digest' ;;
  *) fail 'reference carries a digest' ;;
esac

# A malformed digest must be refused, not ignored.
printf 'runtime 0.2.0 sha256:tooshort\n' > "$matrix"
set +e
bash "$resolver" runtime >/dev/null 2>&1; status=$?
set -e
check_status 'malformed digest is refused' 1 "$status"

# A non-semver version must be refused: a floating "latest" is exactly what this
# file exists to prevent.
printf 'runtime latest %s\n' "$digest" > "$matrix"
set +e
bash "$resolver" runtime >/dev/null 2>&1; status=$?
set -e
check_status 'non-semver version is refused' 1 "$status"

# Duplicates would make the resolved reference depend on line order.
printf 'runtime 0.2.0 %s\nruntime 0.2.1 %s\n' "$digest" "$digest" > "$matrix"
set +e
bash "$resolver" runtime >/dev/null 2>&1; status=$?
set -e
check_status 'duplicate image is refused' 1 "$status"

# An unknown name must not be silently treated as a known one.
printf 'runtime 0.2.0 %s\n' "$digest" > "$matrix"
set +e
bash "$resolver" not-an-image >/dev/null 2>&1; status=$?
set -e
check_status 'unknown image name is refused' 1 "$status"

# Restore the tracked matrix first: the cases above deliberately rewrite it, and
# the check below is about compose.yml against the real four images.
cp -- "$work_matrix_backup" "$matrix"

# --- compose.yml must consume exactly these four keys ---
#
# The resolver and the Compose file are the two halves of one contract. If a key
# is renamed on one side only, the deployment silently falls back to the local
# build tag -- which is the mutable reference this work removes. So assert both
# directions: every image has a key in compose.yml, and no override key exists
# there for an image the resolver does not publish.
declare -A expected_keys=(
  [runtime]=WORKSTATION_RUNTIME_IMAGE
  [auth]=WORKSTATION_AUTH_IMAGE
  [provider]=WORKSTATION_PROVIDER_IMAGE
  [browser-gate]=WORKSTATION_GATE_IMAGE
)
compose=compose.yml
[[ -f $compose ]] || fail 'compose.yml is missing'
for name in $(bash "$resolver" --names); do
  key=${expected_keys[$name]:-}
  [[ -n $key ]] || fail "no Compose image key is defined for $name"
  # Every reference must interpolate the key with a local-build default, so the
  # file works both for a --release deployment and for a local build.
  if ! grep -q "image: \${$key:-dsh-workstation-$name:" "$compose"; then
    fail "compose.yml does not use \${$key:-...} as the image reference for $name"
  fi
  pass "compose.yml pins $name through the ${key} override"
done
# An override key with no image behind it would make a deployment record a
# reference nothing consumes.
for key in $(grep -o 'WORKSTATION_[A-Z_]*_IMAGE' "$compose" | sort -u); do
  matched=false
  for name in "${!expected_keys[@]}"; do
    [[ ${expected_keys[$name]} == "$key" ]] && matched=true
  done
  $matched || fail "compose.yml uses $key, which no published image provides"
done
pass 'compose.yml has no image override without a published image'

# --- every workflow use of the resolver strips the name= prefix ---
#
# The resolver prints `name=reference`. Consuming that line directly produced
# `runtime=dsh-workstation-runtime:0.2.0` as a Docker tag, which failed the first
# real publish with "invalid reference format". Assert that each workflow call
# site strips the prefix rather than trusting review to catch it.
for workflow in .github/workflows/publish-images.yml; do
  [[ -f $workflow ]] || continue
  # A resolver call assigned to a variable must be followed by the strip, or the
  # variable is a `name=reference` pair rather than a reference.
  while IFS= read -r line_no; do
    # Look at the next few lines for the strip.
    # Six lines: the call can be a multi-line `|| { ... }` guard before the
    # strip, as it is in the record job.
    window="$(sed -n "${line_no},$(( line_no + 6 ))p" "$workflow")"
    if ! grep -q 'reference="\${reference#\*=}"' <<<"$window"; then
      fail "$workflow:$line_no assigns a resolver line without stripping the name= prefix"
    fi
  done < <(grep -n 'reference="\$(bash deploy/public/images.sh' "$workflow" | cut -d: -f1)
  pass 'every resolver call in the publish workflow strips the name= prefix'
done

if (( failures )); then
  printf '\n%d check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nall images.sh checks passed\n'
