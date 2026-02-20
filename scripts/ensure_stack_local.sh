#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHAIN_ID=20260211 \
EVM_CHAIN_ID=20260211 \
E2E_STACK_PROFILE=fast \
START_WEB=1 \
NIL_REQUIRE_ONCHAIN_SESSION="${NIL_REQUIRE_ONCHAIN_SESSION:-0}" \
./scripts/ensure_stack.sh
