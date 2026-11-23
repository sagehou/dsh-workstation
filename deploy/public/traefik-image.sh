#!/usr/bin/env bash
# Resolve a pinned Traefik edge image from deploy/public/traefik-matrix.env.
#
# Usage:
#   bash deploy/public/traefik-image.sh                  # default version, image reference
#   bash deploy/public/traefik-image.sh v3.7.14          # named version, image reference
#   bash deploy/public/traefik-image.sh --default        # default version tag
#   bash deploy/public/traefik-image.sh --versions       # every pinned version tag
#   bash deploy/public/traefik-image.sh --json           # every pinned version tag as JSON
#   bash deploy/public/traefik-image.sh --field digest v3.7.14
#   bash deploy/public/traefik-image.sh --field tag v3.7.14
#
# The script fails closed. A version that is not pinned in the matrix is never
# resolved to a floating tag, so CI cannot silently test a different image.
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

matrix=deploy/public/traefik-matrix.env
[[ -f $matrix ]] || { echo "Missing the pinned Traefik matrix: $matrix" >&2; exit 1; }

versions=()
declare -A digests=()
while read -r tag digest extra; do
  [[ -z ${tag:-} ]] && continue
  [[ -z ${extra:-} ]] || { echo "Unexpected extra field beside $tag in $matrix" >&2; exit 1; }
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Unsupported Traefik tag in $matrix: $tag" >&2; exit 1; }
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Unpinned or malformed digest for $tag in $matrix" >&2; exit 1; }
  [[ -z ${digests[$tag]:-} ]] || { echo "Duplicate Traefik tag in $matrix: $tag" >&2; exit 1; }
  versions+=("$tag")
  digests[$tag]=$digest
done < <(sed -e 's/#.*//' "$matrix")
(( ${#versions[@]} )) || { echo "No pinned Traefik versions in $matrix" >&2; exit 1; }

mode=image
field=
case ${1:-} in
  --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
  --default) mode=default; shift ;;
  --versions) mode=versions; shift ;;
  --json) mode=json; shift ;;
  --field) mode=field; field=${2:-}; shift; shift || true ;;
  -*) echo "Unknown option: $1" >&2; exit 1 ;;
esac

case $mode in
  default) printf '%s\n' "${versions[0]}"; exit 0 ;;
  versions) printf '%s\n' "${versions[@]}"; exit 0 ;;
  json)
    printf '['
    separator=
    for version in "${versions[@]}"; do printf '%s"%s"' "$separator" "$version"; separator=', '; done
    printf ']\n'
    exit 0
    ;;
esac

version=${1:-${versions[0]}}
[[ -n ${digests[$version]:-} ]] || {
  printf 'Traefik %s is not pinned in %s. Record its manifest digest before using it.\n' "$version" "$matrix" >&2
  exit 1
}

if [[ $mode == field ]]; then
  case $field in
    tag) printf '%s\n' "$version" ;;
    digest) printf '%s\n' "${digests[$version]}" ;;
    *) printf 'Unknown field: %s\n' "${field:-<empty>}" >&2; exit 1 ;;
  esac
  exit 0
fi

printf 'traefik:%s@%s\n' "$version" "${digests[$version]}"
