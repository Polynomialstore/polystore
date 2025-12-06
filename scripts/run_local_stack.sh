#!/usr/bin/env bash
# Spin up a local NilChain stack: chain (CometBFT+EVM), faucet, and web UI.
# Usage:
#   ./scripts/run_local_stack.sh start   # default
#   ./scripts/run_local_stack.sh stop    # kill background processes started by this script
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/_artifacts/localnet"
PID_DIR="$LOG_DIR/pids"
CHAIN_HOME="${NIL_HOME:-$ROOT_DIR/_artifacts/nilchain_data}"
CHAIN_ID="${CHAIN_ID:-test-1}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
GAS_PRICE="${NIL_GAS_PRICES:-0.001stake}"
DENOM="${NIL_DENOM:-stake}"
FAUCET_AMOUNT="${NIL_AMOUNT:-1000000stake}"
FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-oyster caution display another hidden practice squeeze obvious guitar hurdle plug original census useless hockey lens clinic aunt insect goose media annual provide raccoon}"
NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"

mkdir -p "$LOG_DIR" "$PID_DIR"

banner() { printf '\n=== %s ===\n' "$*"; }

ensure_nilchaind() {
  if [ ! -x "$NILCHAIND_BIN" ]; then
    banner "Building nilchaind (go1.25.5)"
    (cd "$ROOT_DIR/nilchain" && GOTOOLCHAIN=go1.25.5 go build ./cmd/nilchaind)
  fi
}

init_chain() {
  if [ -f "$CHAIN_HOME/config/genesis.json" ]; then
    banner "Reusing existing chain home at $CHAIN_HOME"
    return
  fi

  banner "Initializing chain at $CHAIN_HOME"
  rm -rf "$CHAIN_HOME"
  "$NILCHAIND_BIN" init local --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

  # Import faucet key (deterministic for local use)
  printf '%s\n' "$FAUCET_MNEMONIC" | "$NILCHAIND_BIN" keys add faucet --home "$CHAIN_HOME" --keyring-backend test --recover --output json >/dev/null

  # Fund faucet + create validator
  "$NILCHAIND_BIN" genesis add-genesis-account faucet "100000000000$DENOM,1000000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  "$NILCHAIND_BIN" genesis gentx faucet "50000000000$DENOM" --chain-id "$CHAIN_ID" --home "$CHAIN_HOME" --keyring-backend test
  "$NILCHAIND_BIN" genesis collect-gentxs --home "$CHAIN_HOME"

  APP_TOML="$CHAIN_HOME/config/app.toml"
  perl -pi -e 's/^enable *= *false/enable = true/' "$APP_TOML"            # JSON-RPC enable
  perl -pi -e 's|^address *= *"127\\.0\\.0\\.1:8545"|address = "0.0.0.0:8545"|' "$APP_TOML"
  perl -pi -e 's|^address *= *"tcp://localhost:1317"|address = "tcp://0.0.0.0:1317"|' "$APP_TOML"
}

start_chain() {
  banner "Starting nilchaind"
  nohup "$NILCHAIND_BIN" start \
    --home "$CHAIN_HOME" \
    --rpc.laddr "$RPC_ADDR" \
    --minimum-gas-prices "$GAS_PRICE" \
    --api.enable true \
    >"$LOG_DIR/nilchaind.log" 2>&1 &
  echo $! > "$PID_DIR/nilchaind.pid"
  echo "nilchaind pid $(cat "$PID_DIR/nilchaind.pid"), logs: $LOG_DIR/nilchaind.log"
}

start_faucet() {
  banner "Starting faucet service"
  nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_DENOM="$DENOM" NIL_AMOUNT="$FAUCET_AMOUNT" NIL_GAS_PRICES="$GAS_PRICE" \
    go run "$ROOT_DIR/nil_faucet/main.go" \
    >"$LOG_DIR/faucet.log" 2>&1 &
  echo $! > "$PID_DIR/faucet.pid"
  echo "faucet pid $(cat "$PID_DIR/faucet.pid"), logs: $LOG_DIR/faucet.log"
}

start_web() {
  banner "Starting web (Vite dev server)"
  (
    cd "$ROOT_DIR/nil-website"
    if [ ! -d node_modules ]; then npm install >/dev/null; fi
    nohup npm run dev -- --host 0.0.0.0 --port 5173 >"$LOG_DIR/website.log" 2>&1 &
    echo $! > "$PID_DIR/website.pid"
  )
  echo "web pid $(cat "$PID_DIR/website.pid"), logs: $LOG_DIR/website.log"
}

start_all() {
  ensure_nilchaind
  init_chain
  start_chain
  start_faucet
  start_web
  banner "Stack ready"
  cat <<EOF
RPC:         http://localhost:26657
REST/LCD:    http://localhost:1317
EVM RPC:     http://localhost:$EVM_RPC_PORT  (Chain ID $CHAIN_ID / 262144 default)
Faucet:      http://localhost:8081/faucet
Web UI:      http://localhost:5173/#/dashboard
Home:        $CHAIN_HOME
To stop:     ./scripts/run_local_stack.sh stop
EOF
}

stop_all() {
  banner "Stopping processes"
  for svc in nilchaind faucet website; do
    pid_file="$PID_DIR/$svc.pid"
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" || true
        echo "Stopped $svc (pid $pid)"
      fi
      rm -f "$pid_file"
    fi
  done
}

cmd="${1:-start}"
case "$cmd" in
  start) start_all ;;
  stop) stop_all ;;
  *)
    echo "Usage: $0 [start|stop]"
    exit 1
    ;;
esac
