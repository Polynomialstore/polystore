#!/usr/bin/env bash
# Mode 2 (StripeReplica) E2E harness.
# Defaults to a fast profile (3 SPs); override PROVIDER_COUNT=12 for heavy/nightly runs.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_UP_SCRIPT="$ROOT_DIR/scripts/e2e_stack_up.sh"
STACK_DOWN_SCRIPT="$ROOT_DIR/scripts/e2e_stack_down.sh"

cleanup() {
  echo "==> Stopping devnet alpha multi-SP stack..."
  "$STACK_DOWN_SCRIPT" || true
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
export PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
export PROVIDER_PORT_BASE="${PROVIDER_PORT_BASE:-8091}"
export RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
export P2P_ADDR="${P2P_ADDR:-tcp://0.0.0.0:26656}"
export LCD_PORT="${LCD_PORT:-1317}"
export EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
export EVM_WS_PORT="${EVM_WS_PORT:-8546}"
export FAUCET_PORT="${FAUCET_PORT:-8081}"
export WEB_PORT="${WEB_PORT:-5173}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:${WEB_PORT}}"
export VITE_E2E_PK="${VITE_E2E_PK:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
export CHAIN_ID="${CHAIN_ID:-31337}"
export EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
export POLYSTORE_ENABLE_TX_RELAY=0
# Isolated browser test profile; the general devnet and production default stays disabled.
export POLYSTORE_RETRIEVAL_V2_ACTIVATION_HEIGHT=1
export E2E_MODE2_SPEC="${E2E_MODE2_SPEC:-tests/mode2-stripe.spec.ts}"
export E2E_MODE2_GREP="${E2E_MODE2_GREP:-}"

# Keep CI deterministic: the system liveness prover can contend with Mode 2
# upload/append and trigger timeouts on shared runners.
export POLYSTORE_DISABLE_SYSTEM_LIVENESS="${POLYSTORE_DISABLE_SYSTEM_LIVENESS:-1}"

# Gateway Mode 2 uploads replicate ~16 MiB of metadata per provider; cap parallelism
# so providers don't starve under heavy concurrent disk/network IO.
export POLYSTORE_MODE2_UPLOAD_PARALLELISM="${POLYSTORE_MODE2_UPLOAD_PARALLELISM:-16}"

# Opt-in real payload gate. The default is two raw MDUs for local comparison;
# CI can select exactly 1 GiB. The test checks free disk before any funding.
if [ "${E2E_MODE2_STREAMED:-0}" = "1" ]; then
  export E2E_MODE2_STREAMED_BYTES="${E2E_MODE2_STREAMED_BYTES:-16252928}"
  case "$E2E_MODE2_STREAMED_BYTES" in
    16252928|1073741824) ;;
    *) echo "ERROR: streamed retrieval supports 16252928 or 1073741824 bytes" >&2; exit 1 ;;
  esac
  export E2E_MODE2_FAST=0 PROVIDER_COUNT=12 VITE_DEFAULT_RS_K=8 VITE_DEFAULT_RS_M=4
  export CGO_ENABLED=1 POLYSTORE_CORE_LIB_DIR="$ROOT_DIR/polystore_core/target/release"
  export POLYSTORE_POLYCE=0 POLYSTORE_FAKE_INGEST=0 POLYSTORE_FAST_INGEST=0
  export POLYSTORE_MODE2_ENCODE_PARALLELISM=1 POLYSTORE_MODE2_UPLOAD_PARALLELISM=2
  export E2E_MODE2_GREP='mode2 streamed authenticated retrieval'
fi

echo "==> Starting devnet alpha multi-SP stack (providers=$PROVIDER_COUNT)..."
if [ -z "${E2E_STACK_PROFILE:-}" ]; then
  if [ "$PROVIDER_COUNT" -ge 12 ]; then
    export E2E_STACK_PROFILE=heavy
  else
    export E2E_STACK_PROFILE=fast
  fi
fi
if [ "$E2E_STACK_PROFILE" = "fast" ]; then
  # One-blob sessions must pay after ceil(5% burn); 1stake would all burn.
  export POLYSTORE_RETRIEVAL_PRICE_PER_BLOB=17stake
fi
"$STACK_UP_SCRIPT"

wait_for_http "lcd" "http://localhost:${LCD_PORT}/cosmos/base/tendermint/v1beta1/node_info" "200" 60 1
wait_for_http "polystorechain lcd" "http://localhost:${LCD_PORT}/polystorechain/polystorechain/v1/params" "200" 60 1
wait_for_http "faucet" "http://localhost:${FAUCET_PORT}/faucet" "200,405" 60 1
wait_for_http "gateway router" "http://localhost:8080/health" "200" 60 1
wait_for_http "provider #1" "http://localhost:${PROVIDER_PORT_BASE}/health" "200" 60 1
wait_for_http "web" "http://localhost:${WEB_PORT}/" "200" 90 1

echo "==> Asserting tx relay is disabled..."
tx_relay_code="$(timeout 10s curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/gateway/create-deal-evm 2>/dev/null || true)"
if [ "$tx_relay_code" != "403" ]; then
  echo "ERROR: expected /gateway/create-deal-evm to be forbidden (403) with POLYSTORE_ENABLE_TX_RELAY=0; got HTTP $tx_relay_code" >&2
  exit 1
fi

echo "==> Running Playwright (Mode 2 StripeReplica)..."
if [ "${PLAYWRIGHT_SKIP_INSTALL:-0}" != "1" ]; then
  (cd "$ROOT_DIR/polystore-website" && npx playwright install --with-deps chromium)
fi
playwright_args=("$E2E_MODE2_SPEC")
if [ "${E2E_MODE2_STREAMED:-0}" = "1" ]; then
  playwright_args+=(--retries=0 --workers=1)
fi
if [ -n "$E2E_MODE2_GREP" ]; then
  playwright_args+=(--grep "$E2E_MODE2_GREP")
fi
(cd "$ROOT_DIR/polystore-website" && npm run test:e2e -- "${playwright_args[@]}")
