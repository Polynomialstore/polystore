#!/usr/bin/env bash
# Chain builds require the tracked Cosmos SDK/EVM corrections in vendor.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/polystorechain"
GO_BIN="${GO_BIN:-go}"

case "${1:-}" in
  build|install|test|vet|list|vendor) ;;
  *) echo "usage: $0 {build|install|test|vet|list|vendor} [go arguments]" >&2; exit 2 ;;
esac
for arg in "$@"; do
  case "$arg" in
    -mod|-mod=*) echo "chain_go.sh selects required vendor mode" >&2; exit 2 ;;
  esac
done

# A changed dependency set (or a fresh checkout) needs reconstruction. Preserve
# working-tree patches, including local edits; never git-checkout over them.
source_id="$(git hash-object go.mod go.sum)"
if [[ "$1" == vendor || ! -f vendor/.polystore-source || "$(cat vendor/.polystore-source)" != "$source_id" ]]; then
  (
    backup="$(mktemp -d "${TMPDIR:-/tmp}/polystore-vendor.XXXXXX")"
    # modules.txt describes the freshly generated dependency graph, not a patch.
    git ls-files -z -- vendor ':(exclude)vendor/modules.txt' > "$backup/paths"
    tar -cf "$backup/patches.tar" --null -T "$backup/paths"
    restore_patches() {
      status=$?
      tar -xf "$backup/patches.tar" || status=1
      rm -r "$backup"
      exit "$status"
    }
    trap restore_patches EXIT
    GOFLAGS= "$GO_BIN" mod vendor
  )
  printf '%s\n' "$source_id" > vendor/.polystore-source
fi
if [[ "$1" == vendor ]]; then exit 0; fi

# Last GOFLAGS value wins, including inherited CI/deployment -mod=mod values.
export GOFLAGS="${GOFLAGS:-} -mod=vendor"
exec "$GO_BIN" "$@"
