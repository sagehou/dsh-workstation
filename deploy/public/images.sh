#!/usr/bin/env bash
# Resolve a published workstation image to an immutable reference.
#
# Usage:
#   bash deploy/public/images.sh                     # every image, name=reference
#   bash deploy/public/images.sh runtime             # one image reference
#   bash deploy/public/images.sh --names             # every image name
#   bash deploy/public/images.sh --json              # name -> reference as JSON
#   bash deploy/public/images.sh --field digest auth
#   bash deploy/public/images.sh --field version auth
#   bash deploy/public/images.sh --local runtime      # local tag, for building
#
# Like traefik-image.sh, this fails closed: an image without a recorded digest is
# never resolved to a floating tag, so a deployment cannot silently run whatever
# a tag points at today.
#
# The repository prefix is fixed here rather than taken from the environment. A
# deployment that resolved `ghcr.io/someone-else/...` because an environment
# variable said so would be a supply-chain hole, and the images are public, so
# there is nothing to gain from making it configurable.
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."

# The registry is not freely configurable. A deployment that resolved
# `ghcr.io/someone-else/...` because an environment variable said so would be a
# supply-chain hole. A loopback registry is unambiguous: it can only ever be a
# test, so it is the one override accepted, and it is named as such.
registry=${WORKSTATION_IMAGE_REGISTRY:-ghcr.io/sagehou}
case $registry in
  ghcr.io/sagehou) ;;
  # Tests run a local registry to prove the digest references pull and run on a
  # real daemon without publishing to GHCR.
  127.0.0.1:[0-9]*|localhost:[0-9]*) ;;
  *)
    echo "Refusing WORKSTATION_IMAGE_REGISTRY=$registry" >&2
    echo 'Only ghcr.io/sagehou, or a loopback registry for tests, is accepted.' >&2
    exit 1
    ;;
esac
matrix=deploy/public/images.env
[[ -f $matrix ]] || { echo "Missing the published image list: $matrix" >&2; exit 1; }

names=()
declare -A versions=() digests=()
# `|| [[ -n $name ]]` keeps a final line that has no trailing newline, which a
# hand-edited matrix easily has. Dropping it would silently reduce the set of
# images a deployment pins.
while read -r name version digest extra || [[ -n ${name:-} ]]; do
  [[ -z ${name:-} ]] && continue
  [[ -z ${extra:-} ]] || { echo "Unexpected extra field beside $name in $matrix" >&2; exit 1; }
  [[ $name =~ ^[a-z][a-z0-9-]*$ ]] || { echo "Unsupported image name in $matrix: $name" >&2; exit 1; }
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Unsupported version for $name in $matrix: $version" >&2; exit 1; }
  # An empty digest is legal in the file -- it marks a version the release
  # workflow knows about but has not published -- but it is never usable as a
  # deployment reference, which the resolver below enforces.
  if [[ -n ${digest:-} && ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Malformed digest for $name in $matrix: $digest" >&2
    exit 1
  fi
  [[ -z ${versions[$name]:-} ]] || { echo "Duplicate image in $matrix: $name" >&2; exit 1; }
  names+=("$name")
  versions[$name]=$version
  digests[$name]=${digest:-}
done < <(sed -e 's/#.*//' "$matrix")
(( ${#names[@]} )) || { echo "No images listed in $matrix" >&2; exit 1; }

mode=pairs
field=
local_tag=false
case ${1:-} in
  --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
  --names) mode=names; shift ;;
  --json) mode=json; shift ;;
  --local) local_tag=true; shift ;;
  --field) mode=field; field=${2:-}; shift; shift || true ;;
  -*) echo "Unknown option: $1" >&2; exit 1 ;;
esac

# `--local` is for building, never for deploying: it names the tag the
# development Compose file produces so a local build and a release share one
# naming scheme.
reference() {
  local name=$1
  if $local_tag; then printf 'dsh-workstation-%s:%s\n' "$name" "${versions[$name]}"; return; fi
  local digest=${digests[$name]}
  if [[ -z $digest ]]; then
    printf 'Image %s version %s is not published yet. Run the release workflow and record the digest in %s.\n' \
      "$name" "${versions[$name]}" "$matrix" >&2
    return 1
  fi
  printf '%s/dsh-workstation-%s:%s@%s\n' "$registry" "$name" "${versions[$name]}" "$digest"
}

case $mode in
  names) printf '%s\n' "${names[@]}"; exit 0 ;;
  json)
    printf '{'
    separator=
    for name in "${names[@]}"; do
      # Resolve before printing so an unpublished image fails here instead of
      # producing an empty reference inside otherwise valid JSON.
      reference_value="$(reference "$name")"
      printf '%s"%s": "%s"' "$separator" "$name" "$reference_value"
      separator=', '
    done
    printf '}\n'
    exit 0
    ;;
esac

selected=("${names[@]}")
if (( $# )); then
  selected=()
  for name in "$@"; do
    [[ -n ${versions[$name]:-} ]] || { echo "Unknown image: $name" >&2; exit 1; }
    selected+=("$name")
  done
fi

if [[ $mode == field ]]; then
  for name in "${selected[@]}"; do
    case $field in
      version) printf '%s\n' "${versions[$name]}" ;;
      digest)
        [[ -n ${digests[$name]} ]] || {
          printf 'Image %s version %s has no recorded digest in %s.\n' "$name" "${versions[$name]}" "$matrix" >&2
          exit 1
        }
        printf '%s\n' "${digests[$name]}"
        ;;
      *) printf 'Unknown field: %s\n' "${field:-<empty>}" >&2; exit 1 ;;
    esac
  done
  exit 0
fi

for name in "${selected[@]}"; do
  # `set -e` does not propagate a failure out of a command substitution inside
  # printf, so resolve first and let the failure end the script.
  reference_value="$(reference "$name")"
  printf '%s=%s\n' "$name" "$reference_value"
done
