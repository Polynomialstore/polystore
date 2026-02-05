#!/usr/bin/env bash
# Mode 2 (StripeReplica) E2E: 12+ SPs, browser sharding, shard uploads, commit, retrieval.

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
export E2E_LOCAL_STACK=1
export VITE_ENABLE_FAUCET=1
export PROVIDER_COUNT="${PROVIDER_COUNT:-12}"
export VITE_E2E_PK="${VITE_E2E_PK:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
export CHAIN_ID="${CHAIN_ID:-31337}"
export EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
export NIL_ENABLE_TX_RELAY=0

# Keep CI deterministic: the system liveness prover can contend with Mode 2
# upload/append and trigger timeouts on shared runners.
export NIL_DISABLE_SYSTEM_LIVENESS="${NIL_DISABLE_SYSTEM_LIVENESS:-1}"

# Gateway Mode 2 uploads replicate ~16 MiB of metadata per provider; cap parallelism
# so providers don't starve under heavy concurrent disk/network IO.
export NIL_MODE2_UPLOAD_PARALLELISM="${NIL_MODE2_UPLOAD_PARALLELISM:-16}"

echo "==> Starting devnet alpha multi-SP stack (providers=$PROVIDER_COUNT)..."
"$STACK_SCRIPT" start

wait_for_http "lcd" "http://localhost:1317/cosmos/base/tendermint/v1beta1/node_info" "200" 60 1
wait_for_http "nilchain lcd" "http://localhost:1317/nilchain/nilchain/v1/params" "200" 60 1
wait_for_http "faucet" "http://localhost:8081/faucet" "200,405" 60 1
wait_for_http "gateway router" "http://localhost:8080/health" "200" 60 1
wait_for_http "provider #1" "http://localhost:8091/health" "200" 60 1
wait_for_http "web" "http://localhost:5173/" "200" 90 1

echo "==> Asserting tx relay is disabled..."
tx_relay_code="$(timeout 10s curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/gateway/create-deal-evm 2>/dev/null || true)"
if [ "$tx_relay_code" != "403" ]; then
  echo "ERROR: expected /gateway/create-deal-evm to be forbidden (403) with NIL_ENABLE_TX_RELAY=0; got HTTP $tx_relay_code" >&2
  exit 1
fi

echo "==> Running Playwright (Mode 2 StripeReplica)..."
if [ "${PLAYWRIGHT_SKIP_INSTALL:-0}" != "1" ]; then
  (cd "$ROOT_DIR/nil-website" && npx playwright install --with-deps chromium)
fi
(cd "$ROOT_DIR/nil-website" && npm run test:e2e -- tests/mode2-stripe.spec.ts)
