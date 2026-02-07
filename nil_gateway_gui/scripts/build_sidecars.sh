#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT_DIR/nil_gateway_gui/src-tauri/bin"
RESOURCE_DIR="$ROOT_DIR/nil_gateway_gui/src-tauri"
NIL_CORE_RELEASE_DIR="$ROOT_DIR/nil_core/target/release"
NIL_CORE_TARGET=""

mkdir -p "$BIN_DIR"

ext=""
nil_core_lib=""
nil_core_lib_alt=""
case "$(uname -s)" in
  Darwin)
    nil_core_lib="libnil_core.dylib"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    ext=".exe"
    NIL_CORE_TARGET="x86_64-pc-windows-gnu"
    NIL_CORE_RELEASE_DIR="$ROOT_DIR/nil_core/target/$NIL_CORE_TARGET/release"
    nil_core_lib="nil_core.dll"
    nil_core_lib_alt="libnil_core.dll"
    ;;
  *)
    nil_core_lib="libnil_core.so"
    ;;
esac

echo "==> Building nil_core shared library"
(
  cd "$ROOT_DIR/nil_core"
  if [[ -n "$NIL_CORE_TARGET" ]]; then
    cargo build --release --target "$NIL_CORE_TARGET"
  else
    cargo build --release
  fi
)

if [[ ! -f "$NIL_CORE_RELEASE_DIR/$nil_core_lib" ]]; then
  if [[ -n "$nil_core_lib_alt" && -f "$NIL_CORE_RELEASE_DIR/$nil_core_lib_alt" ]]; then
    nil_core_lib="$nil_core_lib_alt"
  else
    echo "missing nil_core shared library: $NIL_CORE_RELEASE_DIR/$nil_core_lib"
    exit 1
  fi
fi
cp "$NIL_CORE_RELEASE_DIR/$nil_core_lib" "$BIN_DIR/$nil_core_lib"

echo "==> Building nil_gateway sidecar"
(
  cd "$ROOT_DIR/nil_gateway"
  go build -o "$BIN_DIR/nil_gateway$ext" .
)

echo "==> Building nil_cli sidecar"
(
  cd "$ROOT_DIR/nil_cli"
  cargo build --release
  cp "target/release/nil_cli$ext" "$BIN_DIR/nil_cli$ext"
)

echo "==> Copying trusted setup"
cp "$ROOT_DIR/nilchain/trusted_setup.txt" "$RESOURCE_DIR/trusted_setup.txt"

echo "Sidecars staged in $BIN_DIR"
