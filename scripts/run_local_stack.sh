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
GAS_PRICE="${NIL_GAS_PRICES:-0.001aatom}"
DENOM="${NIL_DENOM:-stake}"
FAUCET_AMOUNT="${NIL_AMOUNT:-1000000000000000000aatom,100000000stake}"
FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"
NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"
GO_BIN="${GO_BIN:-/Users/michaelseiler/.gvm/gos/go1.25.5/bin/go}"
if [ ! -x "$GO_BIN" ]; then
  GO_BIN="$(command -v go)"
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

banner() { printf '\n=== %s ===\n' "$*"; }

ensure_nilchaind() {
  banner "Building and installing nilchaind (via $GO_BIN)"
  (cd "$ROOT_DIR/nilchain" && "$GO_BIN" build -o "$ROOT_DIR/nilchain/nilchaind" ./cmd/nilchaind)
  # Also install to GOPATH/bin to ensure it's in PATH for arbitrary shell calls
  (cd "$ROOT_DIR/nilchain" && "$GO_BIN" install ./cmd/nilchaind)
}

ensure_nil_cli() {
  if [ ! -x "$ROOT_DIR/nil_cli/target/debug/nil_cli" ]; then
    banner "Building nil_cli (debug)"
    (cd "$ROOT_DIR/nil_cli" && cargo build)
  fi
}

register_demo_provider() {
  banner "Registering demo storage provider (faucet)"
  # Use the faucet key as a General-capability provider with a large capacity.
  # We retry a few times to avoid races with node startup.
  local attempts=10
  local i
  for i in $(seq 1 "$attempts"); do
    "$NILCHAIND_BIN" tx nilchain register-provider General 1099511627776 \
      --from faucet \
      --chain-id "$CHAIN_ID" \
      --yes \
      --home "$CHAIN_HOME" \
      --keyring-backend test \
      --gas-prices "$GAS_PRICE" >/dev/null 2>&1 || true

    # Check if a provider now exists.
    if "$NILCHAIND_BIN" query nilchain list-providers --home "$CHAIN_HOME" 2>/dev/null | grep -q "address:"; then
      echo "Demo provider registered successfully."
      return 0
    fi

    echo "Demo provider not yet registered (attempt $i/$attempts); retrying in 4s..."
    sleep 4
  done

  echo "Warning: demo provider registration failed after $attempts attempts (see nilchaind logs)"
}

init_chain() {
  rm -rf "$CHAIN_HOME"
  banner "Initializing chain at $CHAIN_HOME"
  "$NILCHAIND_BIN" init local --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

  # Import faucet key (deterministic for local use)
  printf '%s\n' "$FAUCET_MNEMONIC" | "$NILCHAIND_BIN" keys add faucet --home "$CHAIN_HOME" --keyring-backend test --recover --output json >/dev/null

  # Fund faucet + create validator
  "$NILCHAIND_BIN" genesis add-genesis-account faucet "100000000000$DENOM,1000000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  # Pre-fund a well-known dev EVM-mapped account used in E2E tests so that
  # MsgCreateDealFromEvm can deduct stake from its owner without relying on the
  # faucet service timing.
  "$NILCHAIND_BIN" genesis add-genesis-account nil198ywt0pv8k5qua3fvcw9lge6stk0usgag8ehcl "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  "$NILCHAIND_BIN" genesis gentx faucet "50000000000$DENOM" --chain-id "$CHAIN_ID" --home "$CHAIN_HOME" --keyring-backend test
  "$NILCHAIND_BIN" genesis collect-gentxs --home "$CHAIN_HOME"

  ensure_metadata

  APP_TOML="$CHAIN_HOME/config/app.toml"
  perl -pi -e 's/^max-txs *= *-1/max-txs = 0/' "$APP_TOML"
  perl -pi -e 's/^enable *= *false/enable = true/' "$APP_TOML"            # JSON-RPC enable
  perl -pi -e 's|^address *= *"127\\.0\\.0\\.1:8545"|address = "0.0.0.0:8545"|' "$APP_TOML"
  perl -pi -e 's|^ws-address *= *"127\\.0\\.0\\.1:8546"|ws-address = "0.0.0.0:8546"|' "$APP_TOML"
  perl -pi -e 's|^address *= *"tcp://localhost:1317"|address = "tcp://0.0.0.0:1317"|' "$APP_TOML"
  perl -pi -e 's/^enabled-unsafe-cors *= *false/enabled-unsafe-cors = true/' "$APP_TOML"
  # Fallback patcher in case formats change (pure string replace to avoid extra deps)
  python3 - "$APP_TOML" <<'PY' || true
import sys, pathlib
path = pathlib.Path(sys.argv[1])
txt = path.read_text()
for src, dst in [
    ('address = "127.0.0.1:8545"', 'address = "0.0.0.0:8545"'),
    ('ws-address = "127.0.0.1:8546"', 'ws-address = "0.0.0.0:8546"'),
    ('address = "tcp://localhost:1317"', 'address = "tcp://0.0.0.0:1317"'),
    ('enabled-unsafe-cors = false', 'enabled-unsafe-cors = true'),
]:
    txt = txt.replace(src, dst)
path.write_text(txt)
PY
}

ensure_metadata() {
  GENESIS="$CHAIN_HOME/config/genesis.json"
  if [ ! -f "$GENESIS" ]; then return; fi
  python3 - "$GENESIS" <<'PY' || true
import json, sys
path = sys.argv[1]
data = json.load(open(path))
bank = data.get("app_state", {}).get("bank", {})
md = bank.get("denom_metadata", [])
if not any(m.get("base") == "aatom" for m in md):
    md.append({
        "description": "EVM fee token metadata",
        "denom_units": [
            {"denom": "aatom", "exponent": 0, "aliases": ["uatom"]},
            {"denom": "atom", "exponent": 18, "aliases": []},
        ],
        "base": "aatom",
        "display": "atom",
        "name": "",
        "symbol": "",
        "uri": "",
        "uri_hash": ""
    })
    print("Injected aatom metadata into genesis")

supply = bank.get("supply", [])
present = {c.get("denom"): c for c in supply}
for denom, amt in {"stake": 100000000000, "aatom": 1000000000000000000000}.items():
    if denom not in present:
        supply.append({"denom": denom, "amount": str(amt)})

bank["denom_metadata"] = md
bank["supply"] = supply
data["app_state"]["bank"] = bank
json.dump(data, open(path, "w"), indent=1)
PY
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
  sleep 1
  if ! kill -0 "$(cat "$PID_DIR/nilchaind.pid")" 2>/dev/null; then
    echo "nilchaind failed to start; check $LOG_DIR/nilchaind.log"
    tail -n 40 "$LOG_DIR/nilchaind.log" || true
    exit 1
  fi
  echo "nilchaind pid $(cat "$PID_DIR/nilchaind.pid"), logs: $LOG_DIR/nilchaind.log"
}

start_faucet() {
  banner "Starting faucet service"
  (
    cd "$ROOT_DIR/nil_faucet"
    nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_DENOM="$DENOM" NIL_AMOUNT="$FAUCET_AMOUNT" NIL_GAS_PRICES="$GAS_PRICE" \
      "$GO_BIN" run . \
      >"$LOG_DIR/faucet.log" 2>&1 &
    echo $! > "$PID_DIR/faucet.pid"
  )
  sleep 0.5
  if ! kill -0 "$(cat "$PID_DIR/faucet.pid")" 2>/dev/null; then
    echo "faucet failed to start; check $LOG_DIR/faucet.log"
    tail -n 20 "$LOG_DIR/faucet.log" || true
    exit 1
  fi
  echo "faucet pid $(cat "$PID_DIR/faucet.pid"), logs: $LOG_DIR/faucet.log"
}

start_gateway() {
  banner "Starting gateway service"
  ensure_nil_cli
  (
    cd "$ROOT_DIR/nil_s3"
    nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_CLI_BIN="$ROOT_DIR/nil_cli/target/debug/nil_cli" NIL_TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt" NILCHAIND_BIN="$NILCHAIND_BIN" \
      "$GO_BIN" run . \
      >"$LOG_DIR/gateway.log" 2>&1 &
    echo $! > "$PID_DIR/gateway.pid"
  )
  sleep 0.5
  if ! kill -0 "$(cat "$PID_DIR/gateway.pid")" 2>/dev/null; then
    echo "gateway failed to start; check $LOG_DIR/gateway.log"
    tail -n 20 "$LOG_DIR/gateway.log" || true
    exit 1
  fi
  echo "gateway pid $(cat "$PID_DIR/gateway.pid"), logs: $LOG_DIR/gateway.log"
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
  stop_all
  ensure_nilchaind
  init_chain
  start_chain
  register_demo_provider
  start_faucet
  start_gateway
  start_web
  banner "Stack ready"
  cat <<EOF
RPC:         http://localhost:26657
REST/LCD:    http://localhost:1317
EVM RPC:     http://localhost:$EVM_RPC_PORT  (nilchaind, Chain ID $CHAIN_ID / 262144 default)
Faucet:      http://localhost:8081/faucet
Gateway:     http://localhost:8080/gateway/upload
Web UI:      http://localhost:5173/#/dashboard
Home:        $CHAIN_HOME
To stop:     ./scripts/run_local_stack.sh stop
EOF
}

stop_all() {
  banner "Stopping processes"
  for svc in nilchaind faucet gateway website; do
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
  for port in 26657 26656 1317 8545 8080 8081 5173; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      echo "Cleared processes on port $port ($pids)"
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
