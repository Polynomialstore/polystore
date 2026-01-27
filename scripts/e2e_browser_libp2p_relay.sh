#!/usr/bin/env bash
# Browser libp2p fetch test (forced relay path):
# - Starts a local circuit-relay v2 node
# - Starts local stack with SP gateway configured to reserve on the relay
# - Registers provider endpoint with a relay /p2p-circuit multiaddr
# - Runs the Playwright relay spec
# - Always stops the stack on exit

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"

WORK_DIR="${WORK_DIR:-$ROOT_DIR/.cache/e2e-libp2p-relay}"
mkdir -p "$WORK_DIR"

RELAY_IDENTITY="$WORK_DIR/relay.key"
SP_IDENTITY_DIR="$WORK_DIR/sp-identities"
RELAY_LOG="$WORK_DIR/relay.log"
RELAY_PID_FILE="$WORK_DIR/relay.pid"

cleanup() {
  echo "==> Stopping local stack..."
  "$STACK_SCRIPT" stop || true

  if [ -f "$RELAY_PID_FILE" ]; then
    pid="$(cat "$RELAY_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$RELAY_PID_FILE"
  fi
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

wait_for_relay_peer_id() {
  local log_path="$1"
  local max_attempts="${2:-60}"
  local delay_secs="${3:-0.5}"

  for attempt in $(seq 1 "$max_attempts"); do
    if [ -f "$log_path" ]; then
      local line
      line=$(head -n 1 "$log_path" 2>/dev/null || true)
      if echo "$line" | grep -q '"peer_id"'; then
        python3 - "$line" <<'PY'
import json, sys
line = sys.argv[1]
try:
  obj = json.loads(line)
  print(obj.get('peer_id',''))
except Exception:
  print('')
PY
        return 0
      fi
    fi
    sleep "$delay_secs"
  done

  echo "ERROR: relay did not produce peer id" >&2
  tail -n 50 "$log_path" || true
  return 1
}

banner() { echo "==> $*"; }

banner "Generating deterministic p2p identities"
mkdir -p "$SP_IDENTITY_DIR"
PROVIDER_KEYS=("faucet" "provider1" "provider2")
EXTRA_MAP=""
for key in "${PROVIDER_KEYS[@]}"; do
  identity_path="$SP_IDENTITY_DIR/${key}.key"
  peer_id=$(cd "$ROOT_DIR/nil_gateway" && go run ./cmd/p2p-relay --gen-identity "$identity_path" --print-peer-id)
  if [ -z "$peer_id" ]; then
    echo "ERROR: failed to generate peer id for $key" >&2
    exit 1
  fi
  if [ -n "$EXTRA_MAP" ]; then
    EXTRA_MAP+=","
  fi
  EXTRA_MAP+="${key}="
  EXTRA_MAP+="$peer_id"
done

banner "Starting local relay"
: >"$RELAY_LOG"
(cd "$ROOT_DIR/nil_gateway" && nohup go run ./cmd/p2p-relay --listen "/ip4/127.0.0.1/tcp/9101/ws" --gen-identity "$RELAY_IDENTITY" >"$RELAY_LOG" 2>&1 & echo $! >"$RELAY_PID_FILE")

RELAY_PEER_ID="$(wait_for_relay_peer_id "$RELAY_LOG")"
if [ -z "$RELAY_PEER_ID" ]; then
  echo "ERROR: empty relay peer id" >&2
  exit 1
fi

RELAY_BASE="/ip4/127.0.0.1/tcp/9101/ws/p2p/$RELAY_PEER_ID"
NIL_PROVIDER_ENDPOINTS_EXTRA_MAP=""
IFS=',' read -r -a map_entries <<<"$EXTRA_MAP"
for entry in "${map_entries[@]}"; do
  key="${entry%%=*}"
  peer="${entry#*=}"
  dial="$RELAY_BASE/p2p-circuit/p2p/$peer"
  if [ -n "$NIL_PROVIDER_ENDPOINTS_EXTRA_MAP" ]; then
    NIL_PROVIDER_ENDPOINTS_EXTRA_MAP+=","
  fi
  NIL_PROVIDER_ENDPOINTS_EXTRA_MAP+="${key}=${dial}"
done

export VITE_E2E=1
export VITE_E2E_PK="${VITE_E2E_PK:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
export CHAIN_ID="${CHAIN_ID:-31337}"
export EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
export E2E_LOCAL_STACK=1
export NIL_LOCAL_PROVIDER_COUNT=3

# Ensure the browser libp2p client is enabled and uses the same protocol id.
export VITE_P2P_ENABLED=1
export VITE_P2P_PROTOCOL="/nilstore/fetch/1.0.0"

# Force provider relay path: provider reserves on relay, and chain endpoints include only the relay dial addr.
export NIL_P2P_ENABLED_SP=1
export NIL_P2P_LISTEN_PORT_BASE_SP="${NIL_P2P_LISTEN_PORT_BASE_SP:-9102}"
export NIL_P2P_IDENTITY_DIR_SP="$SP_IDENTITY_DIR"
export NIL_P2P_RELAY_ADDRS_SP="$RELAY_BASE"
export NIL_PROVIDER_ENDPOINTS_EXTRA_MAP
unset NIL_PROVIDER_ENDPOINTS_EXTRA

# Avoid starting p2p on the user gateway to ensure the test hits provider endpoints.
export NIL_P2P_ENABLED=0

banner "Starting local stack (relay forced)..."
"$STACK_SCRIPT" start

wait_for_http "web" "http://localhost:5173/"
wait_for_http "gateway" "http://localhost:8080/status"
wait_for_http "gateway health" "http://localhost:8080/health"

banner "Running Playwright (libp2p relay)..."
(cd "$ROOT_DIR/nil-website" && npm run test:e2e -- tests/libp2p-relay-fetch.spec.ts)
