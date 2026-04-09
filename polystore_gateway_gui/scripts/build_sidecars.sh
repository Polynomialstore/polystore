#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT_DIR/polystore_gateway_gui/src-tauri/bin"
RESOURCE_DIR="$ROOT_DIR/polystore_gateway_gui/src-tauri"
POLYSTORE_CORE_RELEASE_DIR="$ROOT_DIR/polystore_core/target/release"
POLYSTORE_CORE_TARGET=""

mkdir -p "$BIN_DIR"

ext=""
polystore_core_lib=""
polystore_core_lib_alt=""
case "$(uname -s)" in
  Darwin)
    polystore_core_lib="libpolystore_core.dylib"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    ext=".exe"
    POLYSTORE_CORE_TARGET="x86_64-pc-windows-gnu"
    POLYSTORE_CORE_RELEASE_DIR="$ROOT_DIR/polystore_core/target/$POLYSTORE_CORE_TARGET/release"
    polystore_core_lib="polystore_core.dll"
    polystore_core_lib_alt="libpolystore_core.dll"
    ;;
  *)
    polystore_core_lib="libpolystore_core.so"
    ;;
esac

echo "==> Building polystore_core shared library"
(
  cd "$ROOT_DIR/polystore_core"
  if [[ -n "$POLYSTORE_CORE_TARGET" ]]; then
    cargo build --release --target "$POLYSTORE_CORE_TARGET"
  else
    cargo build --release
  fi
)

if [[ ! -f "$POLYSTORE_CORE_RELEASE_DIR/$polystore_core_lib" ]]; then
  if [[ -n "$polystore_core_lib_alt" && -f "$POLYSTORE_CORE_RELEASE_DIR/$polystore_core_lib_alt" ]]; then
    polystore_core_lib="$polystore_core_lib_alt"
  else
    echo "missing polystore_core shared library: $POLYSTORE_CORE_RELEASE_DIR/$polystore_core_lib"
    exit 1
  fi
fi
cp "$POLYSTORE_CORE_RELEASE_DIR/$polystore_core_lib" "$BIN_DIR/$polystore_core_lib"

echo "==> Building polystore_gateway sidecar"
if [[ -f "$BIN_DIR/polystore_gateway$ext" ]]; then
  rm -f "$BIN_DIR/polystore_gateway$ext"
fi
(
  cd "$ROOT_DIR/polystore_gateway"
  if [[ "$(uname -s)" == "Linux" ]]; then
    go build -ldflags '-extldflags=-Wl,-rpath,$ORIGIN' -o "$BIN_DIR/polystore_gateway$ext" .
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    go build -ldflags '-extldflags=-Wl,-rpath,@loader_path' -o "$BIN_DIR/polystore_gateway$ext" .
  else
    go build -o "$BIN_DIR/polystore_gateway$ext" .
  fi
)

echo "==> Building polystore_cli sidecar"
(
  cd "$ROOT_DIR/polystore_cli"
  cargo build --release
  cp "target/release/polystore_cli$ext" "$BIN_DIR/polystore_cli$ext"
)

echo "==> Copying trusted setup"
cp "$ROOT_DIR/polystorechain/trusted_setup.txt" "$RESOURCE_DIR/trusted_setup.txt"

echo "Sidecars staged in $BIN_DIR"
