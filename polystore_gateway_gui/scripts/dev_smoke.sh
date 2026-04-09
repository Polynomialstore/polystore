#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building PolyStore Gateway GUI web assets..."
cd "$ROOT_DIR"
npm install
npm run build

echo "Running Tauri Rust tests..."
cd "$ROOT_DIR/src-tauri"
cargo test

echo "Smoke build complete."
