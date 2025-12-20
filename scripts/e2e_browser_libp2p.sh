#!/usr/bin/env bash
# Browser libp2p fetch test:
# - Starts local stack with libp2p enabled on the user gateway
# - Runs the libp2p Playwright spec
# - Always stops the stack on exit

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"

cleanup() {
  echo "==> Stopping local stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-60}"
  local delay_secs="${4:-1}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done

  echo "ERROR: $name at $url not reachable" >&2
  return 1
}

export VITE_E2E=1
export VITE_E2E_PK="${VITE_E2E_PK:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
export CHAIN_ID="${CHAIN_ID:-31337}"
export EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
export E2E_LOCAL_STACK=1
export VITE_P2P_ENABLED=1
export VITE_P2P_PROTOCOL="/nilstore/fetch/1.0.0"
export NIL_P2P_ENABLED=1
export NIL_P2P_LISTEN_ADDRS="${NIL_P2P_LISTEN_ADDRS:-/ip4/127.0.0.1/tcp/9100/ws}"

# Avoid starting p2p on the SP gateway to prevent port conflicts.
export NIL_P2P_ENABLED_SP=0

echo "==> Starting local stack (libp2p enabled)..."
"$STACK_SCRIPT" start

wait_for_http "web" "http://localhost:5173/"
wait_for_http "gateway" "http://localhost:8080/status"
wait_for_http "gateway upload" "http://localhost:8080/gateway/upload"

echo "==> Running Playwright (libp2p)..."
(cd "$ROOT_DIR/nil-website" && npm run test:e2e -- tests/libp2p-fetch.spec.ts)
