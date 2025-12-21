#!/usr/bin/env bash
# Devnet Alpha multi-provider stack runner.
# Starts:
# - nilchaind (CometBFT + LCD + JSON-RPC)
# - nil_faucet
# - N provider daemons (nil_gateway, provider mode) on ports 8091+
# - 1 gateway router (nil_gateway, router mode) on :8080
# - nil-website (optional, default on)
#
# Usage:
#   ./scripts/run_devnet_alpha_multi_sp.sh start
#   ./scripts/run_devnet_alpha_multi_sp.sh stop
#
# Hub-only mode (no local providers):
#   PROVIDER_COUNT=0 ./scripts/run_devnet_alpha_multi_sp.sh start
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/_artifacts/devnet_alpha_multi_sp"
PID_DIR="$LOG_DIR/pids"

CHAIN_HOME="${NIL_HOME:-$ROOT_DIR/_artifacts/nilchain_data_devnet_alpha}"
CHAIN_ID="${CHAIN_ID:-31337}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
GAS_PRICE="${NIL_GAS_PRICES:-0.001aatom}"
DENOM="${NIL_DENOM:-stake}"

NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"
NIL_CLI_BIN="$ROOT_DIR/nil_cli/target/release/nil_cli"
NIL_GATEWAY_BIN="$ROOT_DIR/nil_gateway/nil_gateway"
TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt"
GO_BIN="${GO_BIN:-$(command -v go)}"

PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
PROVIDER_PORT_BASE="${PROVIDER_PORT_BASE:-8091}"

START_WEB="${START_WEB:-1}"

# Shared secret between the gateway router and all providers.
NIL_GATEWAY_SP_AUTH="${NIL_GATEWAY_SP_AUTH:-}"

FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"

mkdir -p "$LOG_DIR" "$PID_DIR"

banner() { printf '\n=== %s ===\n' "$*"; }

ensure_nil_core() {
  local lib_dir="$ROOT_DIR/nil_core/target/release"

  nil_core_has_symbols() {
    local sym
    local file=""

    if [ -f "$lib_dir/libnil_core.a" ]; then
      file="$lib_dir/libnil_core.a"
    elif [ -f "$lib_dir/libnil_core.so" ]; then
      file="$lib_dir/libnil_core.so"
    elif [ -f "$lib_dir/libnil_core.dylib" ]; then
      file="$lib_dir/libnil_core.dylib"
    else
      return 1
    fi

    if ! command -v nm >/dev/null 2>&1; then
      return 1
    fi

    # Dynamic libs: use nm -D where available. Static libs: nm defaults are fine.
    local nm_args=()
    if [[ "$file" == *.so ]] && nm -D "$file" >/dev/null 2>&1; then
      nm_args=(-D)
    fi

    for sym in \
      nil_compute_mdu_root_from_witness_flat \
      nil_expand_mdu_rs \
      nil_reconstruct_mdu_rs \
      nil_mdu0_builder_new_with_commitments \
      nil_mdu0_builder_load_with_commitments; do
      if ! nm "${nm_args[@]}" "$file" 2>/dev/null | grep -Eq "(^|[[:space:]]|_)${sym}([[:space:]]|$)"; then
        return 1
      fi
    done

    return 0
  }

  if nil_core_has_symbols; then
    return 0
  fi

  banner "Building nil_core (native)"
  (cd "$ROOT_DIR/nil_core" && cargo build --release)
  if [ ! -f "$lib_dir/libnil_core.a" ] && [ ! -f "$lib_dir/libnil_core.so" ] && [ ! -f "$lib_dir/libnil_core.dylib" ]; then
    local alt=""
    for ext in a so dylib; do
      alt=$(ls "$ROOT_DIR"/nil_core/target/*/release/libnil_core."$ext" 2>/dev/null | head -n1 || true)
      if [ -n "$alt" ]; then
        mkdir -p "$lib_dir"
        cp "$alt" "$lib_dir/libnil_core.$ext"
        break
      fi
    done
  fi
  if [ ! -f "$lib_dir/libnil_core.a" ] && [ ! -f "$lib_dir/libnil_core.so" ] && [ ! -f "$lib_dir/libnil_core.dylib" ]; then
    echo "nil_core native library not found after build" >&2
    exit 1
  fi
  if ! nil_core_has_symbols; then
    echo "nil_core native library is missing required symbols (stale build?)" >&2
    exit 1
  fi
}

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

wait_for_provider_count() {
  local want="$1"
  local attempts="${2:-60}"
  local i
  for i in $(seq 1 "$attempts"); do
    local tmp code body
    tmp="$(mktemp)"
    code=$(timeout 10s curl -sS -o "$tmp" -w '%{http_code}' "http://localhost:1317/nilchain/nilchain/v1/providers" 2>/dev/null || true)
    body="$(cat "$tmp" 2>/dev/null || true)"
    rm -f "$tmp"
    if [ "$code" = "200" ] && python3 - "$body" "$want" >/dev/null 2>&1 <<'PY'
import json, sys
data = json.loads(sys.argv[1])
want = int(sys.argv[2])
providers = data.get("providers") or []
sys.exit(0 if len(providers) >= want else 1)
PY
    then
      echo "Providers registered on LCD (>= $want)"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: expected >= $want providers on LCD" >&2
  return 1
}

wait_for_provider_visible() {
  local addr="$1"
  local endpoint="$2"
  local attempts="${3:-60}"
  local i
  for i in $(seq 1 "$attempts"); do
    local tmp code body
    tmp="$(mktemp)"
    code=$(timeout 10s curl -sS -o "$tmp" -w '%{http_code}' "http://localhost:1317/nilchain/nilchain/v1/providers/$addr" 2>/dev/null || true)
    body="$(cat "$tmp" 2>/dev/null || true)"
    rm -f "$tmp"
    if [ "$code" = "200" ] && python3 - "$body" "$endpoint" >/dev/null 2>&1 <<'PY'
import json, sys
data = json.loads(sys.argv[1])
want = sys.argv[2]
provider = data.get("provider") or {}
eps = provider.get("endpoints") or []
sys.exit(0 if want in eps else 1)
PY
    then
      echo "Provider $addr visible on LCD"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: provider $addr not visible on LCD" >&2
  return 1
}

ensure_nilchaind() {
  banner "Building nilchaind (via $GO_BIN)"
  (cd "$ROOT_DIR/nilchain" && GOFLAGS="${GOFLAGS:-} -mod=mod" "$GO_BIN" build -o "$NILCHAIND_BIN" ./cmd/nilchaind)
  (cd "$ROOT_DIR/nilchain" && GOFLAGS="${GOFLAGS:-} -mod=mod" "$GO_BIN" install ./cmd/nilchaind)
}

ensure_nil_cli() {
  banner "Building nil_cli (release)"
  (cd "$ROOT_DIR/nil_cli" && cargo build --release)
}

ensure_nil_gateway() {
  banner "Building nil_gateway (via $GO_BIN)"
  (cd "$ROOT_DIR/nil_gateway" && GOFLAGS="${GOFLAGS:-} -mod=mod" "$GO_BIN" build -o "$NIL_GATEWAY_BIN" .)
}

ensure_metadata() {
  local genesis="$CHAIN_HOME/config/genesis.json"
  if [ ! -f "$genesis" ]; then
    return 0
  fi
  python3 - "$genesis" <<'PY' || true
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
    print("Injected aatom metadata into devnet alpha genesis")

supply = bank.get("supply", [])
present = {c.get("denom"): c for c in supply}
for denom, amt in {"stake": 100000000000, "aatom": 1000000000000000000000}.items():
    if denom not in present:
        supply.append({"denom": denom, "amount": str(amt)})

bank["denom_metadata"] = md
bank["supply"] = supply
data["app_state"]["bank"] = bank

# Enable NilStore EVM precompile for MetaMask tx UX.
evm = data.get("app_state", {}).get("evm", {})
params = evm.get("params", {})
pre = params.get("active_static_precompiles", []) or []
addr = "0x0000000000000000000000000000000000000900"
if addr not in pre:
    pre.append(addr)
pre = sorted(set(pre))
params["active_static_precompiles"] = pre
evm["params"] = params
data["app_state"]["evm"] = evm

json.dump(data, open(path, "w"), indent=1)
PY
}

gen_provider_key() {
  local name="$1"
  "$NILCHAIND_BIN" keys add "$name" --home "$CHAIN_HOME" --keyring-backend test --output json >/dev/null 2>&1 || true
  "$NILCHAIND_BIN" keys show "$name" -a --home "$CHAIN_HOME" --keyring-backend test
}

init_chain() {
  rm -rf "$CHAIN_HOME"
  banner "Initializing chain at $CHAIN_HOME"
  "$NILCHAIND_BIN" init devnet-alpha --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

  printf '%s\n' "$FAUCET_MNEMONIC" | "$NILCHAIND_BIN" keys add faucet --home "$CHAIN_HOME" --keyring-backend test --recover --output json >/dev/null

  # Create provider keys and pre-fund them in genesis so they can register.
  for i in $(seq 1 "$PROVIDER_COUNT"); do
    addr="$(gen_provider_key "provider$i")"
    "$NILCHAIND_BIN" genesis add-genesis-account "$addr" "1000000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  done

  # Fund faucet + create validator
  "$NILCHAIND_BIN" genesis add-genesis-account faucet "100000000000$DENOM,1000000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
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
  perl -pi -e "s/^evm-chain-id *= *[0-9]+/evm-chain-id = $EVM_CHAIN_ID/" "$APP_TOML"
}

start_chain() {
  banner "Starting nilchaind"
  nohup "$NILCHAIND_BIN" start \
    --home "$CHAIN_HOME" \
    --rpc.laddr "$RPC_ADDR" \
    --minimum-gas-prices "$GAS_PRICE" \
    --api.enable \
    >"$LOG_DIR/nilchaind.log" 2>&1 &
  echo $! >"$PID_DIR/nilchaind.pid"
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
    nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_DENOM="$DENOM" NIL_AMOUNT="1000000000000000000aatom,100000000stake" NIL_GAS_PRICES="$GAS_PRICE" \
      "$GO_BIN" run . \
      >"$LOG_DIR/faucet.log" 2>&1 &
    echo $! >"$PID_DIR/faucet.pid"
  )
  sleep 0.5
  if ! kill -0 "$(cat "$PID_DIR/faucet.pid")" 2>/dev/null; then
    echo "faucet failed to start; check $LOG_DIR/faucet.log"
    tail -n 40 "$LOG_DIR/faucet.log" || true
    exit 1
  fi
  echo "faucet pid $(cat "$PID_DIR/faucet.pid"), logs: $LOG_DIR/faucet.log"
}

register_provider() {
  local key="$1"
  local endpoint="$2"
  "$NILCHAIND_BIN" tx nilchain register-provider General 1099511627776 \
    --endpoint "$endpoint" \
    --from "$key" \
    --chain-id "$CHAIN_ID" \
    --node "tcp://127.0.0.1:26657" \
    --yes \
    --home "$CHAIN_HOME" \
    --keyring-backend test \
    --gas auto \
    --gas-adjustment 1.6 \
    --gas-prices "$GAS_PRICE" >/dev/null 2>&1
}

register_provider_retry() {
  local key="$1"
  local endpoint="$2"
  local attempts=20
  local addr
  addr="$("$NILCHAIND_BIN" keys show "$key" -a --home "$CHAIN_HOME" --keyring-backend test 2>/dev/null || true)"
  if [ -z "$addr" ]; then
    echo "ERROR: failed to resolve $key address" >&2
    return 1
  fi
  for i in $(seq 1 "$attempts"); do
    register_provider "$key" "$endpoint" || true
    if wait_for_provider_visible "$addr" "$endpoint" 10 >/dev/null 2>&1; then
      echo "Registered $key ($endpoint)"
      return 0
    fi
    echo "register-provider failed for $key (attempt $i/$attempts); retrying in 2s..."
    sleep 2
  done
  echo "ERROR: register-provider failed for $key after $attempts attempts" >&2
  return 1
}

start_provider() {
  local i="$1"
  local key="provider$i"
  local port="$((PROVIDER_PORT_BASE + i - 1))"
  local dir="$LOG_DIR/providers/$key"
  mkdir -p "$dir"
  (
    cd "$ROOT_DIR/nil_gateway"
    nohup env \
      NIL_LISTEN_ADDR=":$port" \
      NIL_CHAIN_ID="$CHAIN_ID" \
      NIL_HOME="$CHAIN_HOME" \
      NIL_UPLOAD_DIR="$dir" \
      NIL_CLI_BIN="$NIL_CLI_BIN" \
      NIL_TRUSTED_SETUP="$TRUSTED_SETUP" \
      NILCHAIND_BIN="$NILCHAIND_BIN" \
      NIL_PROVIDER_KEY="$key" \
      NIL_GATEWAY_SP_AUTH="$NIL_GATEWAY_SP_AUTH" \
      "$NIL_GATEWAY_BIN" \
      >"$LOG_DIR/$key.log" 2>&1 &
    echo $! >"$PID_DIR/$key.pid"
  )
  echo "$key pid $(cat "$PID_DIR/$key.pid"), logs: $LOG_DIR/$key.log"
}

start_router() {
  banner "Starting gateway router (nil_gateway)"
  (
    cd "$ROOT_DIR/nil_gateway"
    nohup env \
      NIL_GATEWAY_ROUTER="1" \
      NIL_CHAIN_ID="$CHAIN_ID" \
      NIL_HOME="$CHAIN_HOME" \
      NIL_UPLOAD_DIR="$LOG_DIR/router_tmp" \
      NILCHAIND_BIN="$NILCHAIND_BIN" \
      NIL_GATEWAY_SP_AUTH="$NIL_GATEWAY_SP_AUTH" \
      "$NIL_GATEWAY_BIN" \
      >"$LOG_DIR/router.log" 2>&1 &
    echo $! >"$PID_DIR/router.pid"
  )
  echo "router pid $(cat "$PID_DIR/router.pid"), logs: $LOG_DIR/router.log"
}

start_web() {
  banner "Starting web (Vite dev server)"
  (
    cd "$ROOT_DIR/nil-website"
    if [ ! -d node_modules ]; then npm install >/dev/null; fi
    VITE_COSMOS_CHAIN_ID="$CHAIN_ID" \
    VITE_CHAIN_ID="$EVM_CHAIN_ID" \
    VITE_NILSTORE_PRECOMPILE="${VITE_NILSTORE_PRECOMPILE:-0x0000000000000000000000000000000000000900}" \
    nohup npm run dev -- --host 0.0.0.0 --port 5173 >"$LOG_DIR/website.log" 2>&1 &
    echo $! >"$PID_DIR/website.pid"
  )
  echo "website pid $(cat "$PID_DIR/website.pid"), logs: $LOG_DIR/website.log"
}

stop_all() {
  banner "Stopping processes"
  for svc in nilchaind faucet router website; do
    pid_file="$PID_DIR/$svc.pid"
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file")
      kill "$pid" 2>/dev/null || true
      rm -f "$pid_file"
    fi
  done
  for i in $(seq 1 "$PROVIDER_COUNT"); do
    pid_file="$PID_DIR/provider$i.pid"
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file")
      kill "$pid" 2>/dev/null || true
      rm -f "$pid_file"
    fi
  done

  # Best-effort kill by port in case go run spawned children.
  local ports=(26657 26656 1317 "$EVM_RPC_PORT" 8080 8081 5173)
  if [ "$PROVIDER_COUNT" -gt 0 ]; then
    for i in $(seq 1 "$PROVIDER_COUNT"); do
      ports+=("$((PROVIDER_PORT_BASE + i - 1))")
    done
  fi
  for port in "${ports[@]}"; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
    fi
  done
}

start_all() {
  stop_all
  rm -rf "$LOG_DIR/providers" "$LOG_DIR/router_tmp"

  if [ -z "$NIL_GATEWAY_SP_AUTH" ]; then
    if command -v openssl >/dev/null 2>&1; then
      NIL_GATEWAY_SP_AUTH="$(openssl rand -hex 32)"
    else
      NIL_GATEWAY_SP_AUTH="$(date +%s%N)"
    fi
  fi

  ensure_nil_core
  ensure_nilchaind
  ensure_nil_cli
  ensure_nil_gateway
  init_chain
  start_chain
  start_faucet

  wait_for_http "lcd" "http://localhost:1317/cosmos/base/tendermint/v1beta1/node_info" "200" 60 1
  wait_for_http "nilchain lcd" "http://localhost:1317/nilchain/nilchain/v1/params" "200" 60 1
  wait_for_http "faucet" "http://localhost:8081/faucet" "200,405" 60 1

  if [ "$PROVIDER_COUNT" -gt 0 ]; then
    banner "Registering providers"
    for i in $(seq 1 "$PROVIDER_COUNT"); do
      port="$((PROVIDER_PORT_BASE + i - 1))"
      register_provider_retry "provider$i" "/ip4/127.0.0.1/tcp/$port/http"
    done

    banner "Starting providers"
    for i in $(seq 1 "$PROVIDER_COUNT"); do
      start_provider "$i"
    done
    for i in $(seq 1 "$PROVIDER_COUNT"); do
      port="$((PROVIDER_PORT_BASE + i - 1))"
      wait_for_http "provider$i" "http://localhost:$port/gateway/upload" "200,405" 60 1
    done
  fi

  start_router
  wait_for_http "router" "http://localhost:8080/gateway/upload" "200,405" 60 1

  if [ "$START_WEB" = "1" ]; then
    start_web
  fi

  banner "Devnet Alpha multi-SP stack ready"
  echo "$NIL_GATEWAY_SP_AUTH" >"$LOG_DIR/sp_auth.txt"
  cat <<EOF
RPC:         http://localhost:26657
REST/LCD:    http://localhost:1317
EVM RPC:     http://localhost:$EVM_RPC_PORT  (Chain ID $CHAIN_ID / 31337)
Faucet:      http://localhost:8081/faucet
Gateway:     http://localhost:8080/gateway/upload
Web UI:      http://localhost:5173/#/dashboard
Providers:   $PROVIDER_COUNT (ports starting at $PROVIDER_PORT_BASE)
Home:        $CHAIN_HOME
SP Auth:     $NIL_GATEWAY_SP_AUTH  (also saved in $LOG_DIR/sp_auth.txt)
EOF
}

case "${1:-start}" in
  start) start_all ;;
  stop) stop_all ;;
  *)
    echo "Usage: $0 [start|stop]" >&2
    exit 1
    ;;
esac
