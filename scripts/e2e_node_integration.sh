#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"

LCD_PORT="${LCD_PORT:-3317}"
LCD_BASE="${LCD_BASE:-http://127.0.0.1:${LCD_PORT}}"
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
FAUCET_BASE="${FAUCET_BASE:-http://127.0.0.1:18081}"
CHAIN_HOME="${NIL_HOME:-$ROOT_DIR/_artifacts/nilchain_data}"
CHAIN_ID="${CHAIN_ID:-31337}"
FAUCET_PID=""

export NIL_ENABLE_TX_RELAY="${NIL_ENABLE_TX_RELAY:-1}"
export NIL_START_FAUCET="${NIL_START_FAUCET:-0}"
export NIL_START_WEB="${NIL_START_WEB:-0}"
export NIL_GATEWAY_BASE="$GATEWAY_BASE"
export NIL_LCD_BASE="$LCD_BASE"
export NIL_FAUCET_BASE="$FAUCET_BASE"
export NIL_E2E_PRIVKEY="${NIL_E2E_PRIVKEY:-${NIL_EVM_DEV_PRIVKEY:-0xa6694e2fb21957d26c442f80f14954fd84f491a79a7e5f1133495403c0244c1d}}"
export NIL_AUTO_FAUCET_EVM="${NIL_AUTO_FAUCET_EVM:-1}"
export RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:36657}"
export P2P_ADDR="${P2P_ADDR:-tcp://127.0.0.1:36656}"
export EVM_RPC_PORT="${EVM_RPC_PORT:-38545}"
export EVM_WS_PORT="${EVM_WS_PORT:-38546}"
export LCD_PORT

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-40}"
  local delay_secs="${4:-2}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done
  echo "ERROR: $name at $url not reachable" >&2
  return 1
}

wait_for_port_free() {
  local port="$1"
  local max_attempts="${2:-40}"
  local delay_secs="${3:-0.5}"

  for _ in $(seq 1 "$max_attempts"); do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_secs"
  done
  echo "ERROR: port $port is still in use after waiting" >&2
  return 1
}

kill_listener_on_port() {
  local port="$1"
  local pids
  pids=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

cleanup() {
  if [ -n "${FAUCET_PID:-}" ] && kill -0 "$FAUCET_PID" 2>/dev/null; then
    kill "$FAUCET_PID" 2>/dev/null || true
    wait "$FAUCET_PID" 2>/dev/null || true
  fi
  kill_listener_on_port 18081
  echo "==> Stopping local stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

start_custom_faucet() {
  echo "==> Starting dedicated faucet at $FAUCET_BASE ..."
  (
    cd "$ROOT_DIR/nil_faucet"
    nohup env \
      NIL_CHAIN_ID="$CHAIN_ID" \
      NIL_NODE="$RPC_ADDR" \
      NIL_HOME="$CHAIN_HOME" \
      NIL_DENOM="${NIL_DENOM:-stake}" \
      NIL_AMOUNT="${NIL_AMOUNT:-1000000000000000000aatom,100000000stake}" \
      NIL_GAS_PRICES="${NIL_GAS_PRICES:-0.001aatom}" \
      NIL_LISTEN_ADDR="${FAUCET_BASE#http://}" \
      go run . \
      >"$ROOT_DIR/_artifacts/localnet/faucet_node_integration.log" 2>&1 &
    echo $!
  )
}

echo "==> Starting local stack for Node integration tests..."
 "$STACK_SCRIPT" stop || true
wait_for_port_free 36657
wait_for_port_free 36656
wait_for_port_free "$LCD_PORT"
wait_for_port_free 38545
wait_for_port_free 38546
wait_for_port_free 8080
wait_for_port_free 18081
kill_listener_on_port 18081
"$STACK_SCRIPT" start

wait_for_http "LCD" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info"
wait_for_http "Gateway" "$GATEWAY_BASE/gateway/create-deal-evm"
FAUCET_PID="$(start_custom_faucet)"
wait_for_http "Faucet" "$FAUCET_BASE/faucet"
echo "==> Running polystore-website Node integration suite..."
(
  cd "$ROOT_DIR/polystore-website"
  npm run test:integration
)
