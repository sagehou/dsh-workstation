#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$DSH_HOME/runtime"
profile="$DSH_HOME/profiles/web"
store="$DSH_HOME/pnpm/store"
badge='@deepseek-ai/dsh-experimental-badge-skill-bundle'
fixture='dsh-m0-persistence-probe'
base='0.2.2-rc.1'
alternate='0.2.2-rc.5'
mkdir -p "$root/versions"
exec 9>"$root/.m0.lock"
flock -x 9

bin() { echo "$root/$1/node_modules/.bin/dsh"; }
pointer() {
  ln -s "$1" "$root/.next-$$" && mv -Tf "$root/.next-$$" "$root/current"
}
check() {
  local target="$1" mode="$2"
  test "$("$target" --version)" = "$(basename "$(realpath "$(dirname "$target")/../..")")" &&
    node /m0/health.mjs "$target" "$mode"
}
backup() {
  tar -C "$DSH_HOME" -czf "/backup/$1.tgz" .
  echo "backup: /backup/$1.tgz"
}
pnpm_config() {
  printf 'storeDir: %s\nignoreScripts: true\n' "$store" > "$1/pnpm-workspace.yaml"
}

case "$1" in
  install)
    version="$2"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$ ]]
    dest="$root/versions/$version"
    test ! -e "$dest"
    stage="$(mktemp -d "$root/versions/.install.XXXXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    pnpm_config "$stage"
    printf '{"private":true,"name":"dsh-m0-runtime"}\n' > "$stage/package.json"
    pnpm --dir "$stage" add --save-exact --ignore-scripts --ignore-workspace-root-check "@deepseek-ai/dsh@$version"
    test "$("$stage/node_modules/.bin/dsh" --version)" = "$version"
    mv -T "$stage" "$dest"
    echo "installed DSH $version in $dest"
    ;;
  select)
    version="$2"
    mode="${3:-none}"
    candidate="$(bin "versions/$version")"
    test -x "$candidate"
    if [[ -L "$root/current" ]]; then previous="$(readlink "$root/current")"; else previous=; fi
    if [[ -n "$previous" && "$previous" != "versions/$version" ]]; then backup "before-$version"; fi
    pointer "versions/$version"
    if check "$candidate" "$mode"; then
      echo "active DSH $version"
    else
      if [[ -n "$previous" ]]; then pointer "$previous"; else rm "$root/current"; fi
      echo "readiness rejected DSH $version; pointer restored to ${previous:-none}"
      exit 1
    fi
    ;;
  plugins)
    test "$(readlink "$root/current")" = "versions/$base"
    backup before-plugin-install
    pnpm_config "$profile"
    dsh="$(bin current)"
    "$dsh" plugin --profile web add --save-exact --ignore-scripts --ignore-workspace-root-check "$badge@$base"
    git_fixture='git+https://github.com/sagehou/dsh-workstation.git#8a1d8c03ff3e2f94abc82792ed0771bc82b6fb63&path:/prototypes/m0/runtime/fixture'
    echo "Git fixture: $git_fixture"
    "$dsh" plugin --profile web add --save-exact --ignore-scripts --ignore-workspace-root-check "$git_fixture"
    ;;
  fingerprint)
    cd "$profile"
    node -e '
      const assert = require("node:assert/strict")
      const p = require("./package.json")
      for (const name of process.argv.slice(1)) {
        assert(p.dependencies[name])
        assert(p.dsh.profile.bundles.includes(name))
      }
    ' "$badge" "$fixture"
    sha256sum package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.patch.yml
    for path in "$badge" "$fixture"; do
      test -L "node_modules/$path"
      realpath "node_modules/$path"
      sha256sum "node_modules/$path/package.json" "node_modules/$path/cordis.patch.yml"
    done
    store_path="$(pnpm store path)"
    [[ "$store_path" = "$store/"* ]]
    test -n "$(find "$store_path" -type f -print -quit)"
    echo "store: $store_path"
    printf 'store file list: '
    find "$store_path" -type f -printf '%P\n' | LC_ALL=C sort | sha256sum
    ;;
  health)
    target="$(readlink "$root/current")"
    check "$(bin "$target")" "${2:-plugin}"
    ;;
  info)
    test "$(id -u)" -ne 0
    id
    node --version
    pnpm --version
    git --version
    ;;
  *) exit 2 ;;
esac
