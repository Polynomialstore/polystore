#!/usr/bin/env bash
# Browser smoke test for Devnet Alpha multi-provider stack.
# - Starts the multi-SP stack
# - Runs Playwright smoke tests
# - Always stops the stack on exit

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh"

cleanup() {
  echo "==> Stopping devnet alpha multi-SP stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

wait_for_http() {
  local name="$1"
  local url="$2"
  local expect_codes="${3:-200}"
  local max_attempts="${4:-60}"
  local delay_secs="${5:-1}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if echo ",$expect_codes," | grep -q ",$code,"; then
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

echo "==> Starting devnet alpha multi-SP stack..."
"$STACK_SCRIPT" start

wait_for_http "lcd" "http://localhost:1317/cosmos/base/tendermint/v1beta1/node_info" "200" 60 1
wait_for_http "nilchain lcd" "http://localhost:1317/nilchain/nilchain/v1/params" "200" 60 1
wait_for_http "faucet" "http://localhost:8081/faucet" "200,405" 60 1
wait_for_http "gateway" "http://localhost:8080/health" "200" 60 1
wait_for_http "web" "http://localhost:5173/" "200" 90 1

echo "==> Running Playwright..."
(cd "$ROOT_DIR/nil-website" && npm run test:e2e)
