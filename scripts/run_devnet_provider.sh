#!/usr/bin/env bash
set -euo pipefail

# Provider launcher for a multi-machine devnet.
#
# Usage:
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
#   PROVIDER_KEY=provider1 PROVIDER_ENDPOINT="/ip4/<ip>/tcp/8091/http" ./scripts/run_devnet_provider.sh register
#   PROVIDER_KEY=provider1 PROVIDER_LISTEN=":8091" ./scripts/run_devnet_provider.sh start
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh stop

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ACTION="${1:-start}"

PROVIDER_KEY="${PROVIDER_KEY:-}"
if [ -z "$PROVIDER_KEY" ]; then
  echo "ERROR: PROVIDER_KEY is required (e.g. PROVIDER_KEY=provider1)" >&2
  exit 1
fi

CHAIN_ID="${CHAIN_ID:-${NIL_CHAIN_ID:-31337}}"
LCD_BASE="${HUB_LCD:-${NIL_LCD_BASE:-http://localhost:1317}}"
NODE_ADDR="${HUB_NODE:-${NIL_NODE:-tcp://127.0.0.1:26657}}"
GAS_PRICES="${NIL_GAS_PRICES:-0.001aatom}"

NILCHAIND_BIN="${NILCHAIND_BIN:-$ROOT_DIR/nilchain/nilchaind}"
NIL_CLI_BIN="${NIL_CLI_BIN:-$ROOT_DIR/nil_cli/target/release/nil_cli}"
TRUSTED_SETUP="${NIL_TRUSTED_SETUP:-$ROOT_DIR/nilchain/trusted_setup.txt}"

PROVIDER_LISTEN="${PROVIDER_LISTEN:-${NIL_LISTEN_ADDR:-:8091}}"
PROVIDER_CAPABILITIES="${PROVIDER_CAPABILITIES:-General}"
PROVIDER_TOTAL_STORAGE="${PROVIDER_TOTAL_STORAGE:-1099511627776}" # 1 TiB default
PROVIDER_ENDPOINTS_RAW="${PROVIDER_ENDPOINTS:-${PROVIDER_ENDPOINT:-}}"

HOME_DIR="${NIL_HOME:-$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY/nilchain_home}"
UPLOAD_DIR="${NIL_UPLOAD_DIR:-$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY/uploads}"
LOG_DIR="$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY"
PID_DIR="$LOG_DIR/pids"

GO_BIN="${GO_BIN:-$(command -v go)}"

mkdir -p "$LOG_DIR" "$PID_DIR"

ensure_nilchaind() {
  if [ -x "$NILCHAIND_BIN" ]; then
    return 0
  fi
  echo "==> Building nilchaind..."
  (cd "$ROOT_DIR/nilchain" && "$GO_BIN" build -o "$NILCHAIND_BIN" ./cmd/nilchaind)
}

ensure_nil_cli() {
  if [ -x "$NIL_CLI_BIN" ]; then
    return 0
  fi
  echo "==> Building nil_cli..."
  (cd "$ROOT_DIR/nil_cli" && cargo build --release)
}

provider_addr() {
  "$NILCHAIND_BIN" keys show "$PROVIDER_KEY" -a --home "$HOME_DIR" --keyring-backend test 2>/dev/null || true
}

init_provider() {
  ensure_nilchaind
  mkdir -p "$HOME_DIR"
  if [ -z "$(provider_addr)" ]; then
    echo "==> Creating provider key: $PROVIDER_KEY"
    "$NILCHAIND_BIN" keys add "$PROVIDER_KEY" --home "$HOME_DIR" --keyring-backend test >/dev/null
  fi

  local addr
  addr="$(provider_addr)"
  echo "Provider key ready:"
  echo "  key:     $PROVIDER_KEY"
  echo "  address: $addr"
  echo
  echo "Next:"
  echo "  - Ask the hub operator to fund this address with aatom (gas)."
  echo "  - Then register your endpoint: ./scripts/run_devnet_provider.sh register"
}

register_provider() {
  ensure_nilchaind

  if [ -z "$PROVIDER_ENDPOINTS_RAW" ]; then
    echo "ERROR: set PROVIDER_ENDPOINT (or PROVIDER_ENDPOINTS) to a reachable multiaddr, e.g. /ip4/1.2.3.4/tcp/8091/http" >&2
    exit 1
  fi

  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ]; then
    echo "ERROR: provider key not found; run: ./scripts/run_devnet_provider.sh init" >&2
    exit 1
  fi

  IFS=',' read -r -a endpoints <<<"$PROVIDER_ENDPOINTS_RAW"
  local endpoint_args=()
  for ep in "${endpoints[@]}"; do
    ep="$(echo "$ep" | xargs)"
    if [ -n "$ep" ]; then
      endpoint_args+=("--endpoint" "$ep")
    fi
  done
  if [ "${#endpoint_args[@]}" -eq 0 ]; then
    echo "ERROR: no endpoints parsed from PROVIDER_ENDPOINTS" >&2
    exit 1
  fi

  echo "==> Registering provider on-chain..."
  "$NILCHAIND_BIN" tx nilchain register-provider "$PROVIDER_CAPABILITIES" "$PROVIDER_TOTAL_STORAGE" \
    "${endpoint_args[@]}" \
    --from "$PROVIDER_KEY" \
    --chain-id "$CHAIN_ID" \
    --node "$NODE_ADDR" \
    --home "$HOME_DIR" \
    --keyring-backend test \
    --gas auto \
    --gas-adjustment 1.6 \
    --gas-prices "$GAS_PRICES" \
    --yes >/dev/null

  echo "Registered:"
  echo "  address:   $addr"
  echo "  endpoints: $PROVIDER_ENDPOINTS_RAW"
  echo "  lcd:       $LCD_BASE"
}

start_provider() {
  ensure_nilchaind
  ensure_nil_cli

  if [ ! -f "$TRUSTED_SETUP" ]; then
    echo "ERROR: trusted setup not found at $TRUSTED_SETUP (set NIL_TRUSTED_SETUP)" >&2
    exit 1
  fi
  if [ -z "$(provider_addr)" ]; then
    echo "ERROR: provider key not found; run: ./scripts/run_devnet_provider.sh init" >&2
    exit 1
  fi
  if [ -z "${NIL_GATEWAY_SP_AUTH:-}" ]; then
    echo "ERROR: NIL_GATEWAY_SP_AUTH must be set to the hub's shared auth token" >&2
    exit 1
  fi

  mkdir -p "$UPLOAD_DIR"

  local pid_file="$PID_DIR/provider.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "Provider already running (pid $(cat "$pid_file"))"
    return 0
  fi

  echo "==> Starting provider gateway..."
  (
    cd "$ROOT_DIR/nil_gateway"
    nohup env \
      NIL_LISTEN_ADDR="$PROVIDER_LISTEN" \
      NIL_CHAIN_ID="$CHAIN_ID" \
      NIL_NODE="$NODE_ADDR" \
      NIL_LCD_BASE="$LCD_BASE" \
      NIL_HOME="$HOME_DIR" \
      NIL_UPLOAD_DIR="$UPLOAD_DIR" \
      NIL_CLI_BIN="$NIL_CLI_BIN" \
      NIL_TRUSTED_SETUP="$TRUSTED_SETUP" \
      NILCHAIND_BIN="$NILCHAIND_BIN" \
      NIL_PROVIDER_KEY="$PROVIDER_KEY" \
      NIL_GATEWAY_SP_AUTH="$NIL_GATEWAY_SP_AUTH" \
      "$GO_BIN" run . \
      >"$LOG_DIR/provider.log" 2>&1 &
    echo $! >"$pid_file"
  )

  echo "Provider started:"
  echo "  pid:   $(cat "$pid_file")"
  echo "  http:  http://0.0.0.0${PROVIDER_LISTEN}"
  echo "  logs:  $LOG_DIR/provider.log"
}

stop_provider() {
  local pid_file="$PID_DIR/provider.pid"
  if [ ! -f "$pid_file" ]; then
    echo "No provider pid file found."
    return 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
  echo "Stopped provider (pid $pid)"
}

case "$ACTION" in
  init) init_provider ;;
  register) register_provider ;;
  start) start_provider ;;
  stop) stop_provider ;;
  *)
    echo "Usage: $0 [init|register|start|stop]" >&2
    exit 1
    ;;
esac

