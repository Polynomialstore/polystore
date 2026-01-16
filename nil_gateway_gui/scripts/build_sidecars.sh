#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT_DIR/nil_gateway_gui/src-tauri/bin"
RESOURCE_DIR="$ROOT_DIR/nil_gateway_gui/src-tauri"

mkdir -p "$BIN_DIR"

ext=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    ext=".exe"
    ;;
esac

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
