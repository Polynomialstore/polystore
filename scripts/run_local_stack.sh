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
CHAIN_ID="${CHAIN_ID:-31337}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
GAS_PRICE="${NIL_GAS_PRICES:-0.001aatom}"
DENOM="${NIL_DENOM:-stake}"
export NIL_AMOUNT="1000000000000000000aatom,100000000stake" # 1 aatom, 100 stake
FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"
NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"
GO_BIN="${GO_BIN:-/Users/michaelseiler/.gvm/gos/go1.25.5/bin/go}"
BRIDGE_ADDR_FILE="$ROOT_DIR/_artifacts/bridge_address.txt"
BRIDGE_ADDRESS=""
BRIDGE_STATUS="not deployed"
# Default: attempt to deploy the bridge when the stack starts (set to 0 to skip).
NIL_DEPLOY_BRIDGE="${NIL_DEPLOY_BRIDGE:-1}"
NIL_EVM_DEV_PRIVKEY="${NIL_EVM_DEV_PRIVKEY:-0xa6694e2fb21957d26c442f80f14954fd84f491a79a7e5f1133495403c0244c1d}"
export NIL_EVM_DEV_PRIVKEY
# Enable the EVM mempool by default so JSON-RPC / MetaMask works out of the box.
NIL_DISABLE_EVM_MEMPOOL="${NIL_DISABLE_EVM_MEMPOOL:-0}"
export NIL_DISABLE_EVM_MEMPOOL
# Auto-fund the default demo EVM account by calling the faucet once on startup.
NIL_AUTO_FAUCET_EVM="${NIL_AUTO_FAUCET_EVM:-1}"
NIL_AUTO_FAUCET_EVM_ADDR="${NIL_AUTO_FAUCET_EVM_ADDR:-0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2}"
if [ ! -x "$GO_BIN" ]; then
  GO_BIN="$(command -v go)"
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

banner() { printf '\n=== %s ===\n' "$*"; }

ensure_nil_core() {
  local lib_dir="$ROOT_DIR/nil_core/target/release"
  if [ -f "$lib_dir/libnil_core.a" ] || [ -f "$lib_dir/libnil_core.so" ] || [ -f "$lib_dir/libnil_core.dylib" ]; then
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
}

eth_to_nil_bech32() {
  local eth_addr="$1"
  python3 - "$eth_addr" <<'PY'
import sys

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
CHARSET_REV = {c: i for i, c in enumerate(CHARSET)}

def bech32_polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk

def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]

def bech32_create_checksum(hrp, data):
    values = bech32_hrp_expand(hrp) + data
    polymod = bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]

def bech32_encode(hrp, data):
    combined = data + bech32_create_checksum(hrp, data)
    return hrp + "1" + "".join([CHARSET[d] for d in combined])

def convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret

addr = sys.argv[1].strip()
if addr.startswith("0x") or addr.startswith("0X"):
    addr = addr[2:]
addr = addr.strip()
if len(addr) != 40:
    raise SystemExit("invalid eth address length")

raw = bytes.fromhex(addr)
data5 = convertbits(raw, 8, 5, True)
print(bech32_encode("nil", data5))
PY
}

auto_faucet_request() {
  if [ "${NIL_AUTO_FAUCET_EVM}" != "1" ]; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "Skipping auto faucet request: curl not found"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Skipping auto faucet request: python3 not found"
    return 0
  fi

  local target_nil
  if [[ "$NIL_AUTO_FAUCET_EVM_ADDR" == 0x* || "$NIL_AUTO_FAUCET_EVM_ADDR" == 0X* ]]; then
    target_nil="$(eth_to_nil_bech32 "$NIL_AUTO_FAUCET_EVM_ADDR" 2>/dev/null || true)"
  else
    target_nil="$NIL_AUTO_FAUCET_EVM_ADDR"
  fi

  if [ -z "$target_nil" ]; then
    echo "Skipping auto faucet request: failed to convert $NIL_AUTO_FAUCET_EVM_ADDR"
    return 0
  fi

  # Best-effort: the account may already be funded in genesis. This is just
  # a convenience top-up for local dev UX.
  local attempts=20
  local i
  for i in $(seq 1 "$attempts"); do
    if timeout 10s curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/health 2>/dev/null | grep -q "^200$"; then
      break
    fi
    sleep 0.5
  done

  echo "Auto faucet: requesting funds for $NIL_AUTO_FAUCET_EVM_ADDR -> $target_nil"
  timeout 20s curl -sS -X POST http://127.0.0.1:8081/faucet \
    -H "Content-Type: application/json" \
    --data "$(printf '{"address":"%s"}' "$target_nil")" \
    >/dev/null 2>&1 || true
}

wait_for_ports_clear() {
  local ports=(26657 26656 1317 8545 8080 8081 8082 5173)
  local attempts=20
  local delay=0.5
  local port
  for port in "${ports[@]}"; do
    local i
    for i in $(seq 1 "$attempts"); do
      if [ -z "$(lsof -ti :"$port" 2>/dev/null || true)" ]; then
        break
      fi
      sleep "$delay"
    done
  done
}

ensure_nilchaind() {
  banner "Building and installing nilchaind (via $GO_BIN)"
  
  # Reconstruct vendor directory to handle partial vendoring strategy
  (
    cd "$ROOT_DIR/nilchain"
    echo "Reconstructing vendor for nilchain..."
    "$GO_BIN" mod vendor
    # Restore tracked vendor files (if any) to preserve patches/partial vendoring
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git checkout vendor 2>/dev/null || true
    fi
  )

  (cd "$ROOT_DIR/nilchain" && "$GO_BIN" build -o "$ROOT_DIR/nilchain/nilchaind" ./cmd/nilchaind)
  # Also install to GOPATH/bin to ensure it's in PATH for arbitrary shell calls
  (cd "$ROOT_DIR/nilchain" && "$GO_BIN" install ./cmd/nilchaind)
}

ensure_nil_cli() {
  banner "Building nil_cli (release)"
  (cd "$ROOT_DIR/nil_cli" && cargo build --release)
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
      --endpoint "/ip4/127.0.0.1/tcp/8082/http" \
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
  # Pre-fund the EVM dev account (derived from the local Foundry mnemonic) so
  # that MsgCreateDealFromEvm / NilBridge deployments have gas without relying
  # on the faucet timing. This address is the bech32 mapping of the default
  # Foundry EVM deployer (0x4dd2C8c449581466Df3F62b007A24398DD858f5d).
  "$NILCHAIND_BIN" genesis add-genesis-account nil1fhfv33zftq2xdhelv2cq0gjrnrwctr6ag75ey4 "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  # Pre-fund additional EVM demo account (0xf7931ff7fc55d19ef4a8139fa7e4b3f06e03f2e2).
  "$NILCHAIND_BIN" genesis add-genesis-account nil177f3lalu2hgeaa9gzw060e9n7phq8uhzpfks5m "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test

  # Also pre-fund the EVM signer account used by gateway/e2e (derived from EVM_PRIVKEY if set).
  # This avoids relying on the faucet, which uses nilchaind CLI txs that can hang on some setups.
  if command -v python3 >/dev/null 2>&1; then
    local signer_nil_addr
    signer_nil_addr=$(python3 - <<'PY' 2>/dev/null || true
from eth_account import Account
import bech32, os
priv = os.environ.get("EVM_PRIVKEY", "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1")
acct = Account.from_key(priv)
data = bytes.fromhex(acct.address[2:])
five = bech32.convertbits(data, 8, 5)
print(bech32.bech32_encode("nil", five))
PY
    )
    if [ -n "$signer_nil_addr" ]; then
      "$NILCHAIND_BIN" genesis add-genesis-account "$signer_nil_addr" "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
      echo "Pre-funded EVM signer account $signer_nil_addr"
    fi
  fi
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
    ('evm-chain-id = 262144', 'evm-chain-id = 31337'),
]:
    txt = txt.replace(src, dst)
path.write_text(txt)
PY
  if [ "$NIL_DISABLE_EVM_MEMPOOL" = "1" ]; then
    # JSON-RPC requires the ExperimentalEVMMempool. If we disable that for local
    # dev/e2e stability, also disable the JSON-RPC server to avoid a panic.
    python3 - "$APP_TOML" <<'PY' || true
import pathlib, sys
path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
out = []
in_jsonrpc = False
for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        in_jsonrpc = stripped == "[json-rpc]"
        out.append(line)
        continue
    if in_jsonrpc and stripped.startswith("enable ="):
        out.append("enable = false")
    else:
        out.append(line)
path.write_text("\n".join(out) + "\n")
PY
  fi
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

start_chain() {
  banner "Starting nilchaind"
  nohup env NIL_DISABLE_EVM_MEMPOOL="$NIL_DISABLE_EVM_MEMPOOL" \
    "$NILCHAIND_BIN" start \
    --home "$CHAIN_HOME" \
    --rpc.laddr "$RPC_ADDR" \
    --minimum-gas-prices "$GAS_PRICE" \
    --api.enable \
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
    nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_DENOM="$DENOM" NIL_AMOUNT="$NIL_AMOUNT" NIL_GAS_PRICES="$GAS_PRICE" \
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

start_sp_gateway() {
  banner "Starting SP gateway service (Port 8082)"
  ensure_nil_cli
  (
    cd "$ROOT_DIR/nil_gateway"
    # SP Mode (default), Listen on 8082, Uploads to uploads_sp
    nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_UPLOAD_DIR="$LOG_DIR/uploads_sp" \
      NIL_LISTEN_ADDR=":8082" NIL_GATEWAY_ROUTER_MODE="0" \
      NIL_CLI_BIN="$ROOT_DIR/nil_cli/target/release/nil_cli" NIL_TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt" \
      NILCHAIND_BIN="$NILCHAIND_BIN" NIL_CMD_TIMEOUT_SECONDS="240" \
      "$GO_BIN" run . \
      >"$LOG_DIR/gateway_sp.log" 2>&1 &
    echo $! > "$PID_DIR/gateway_sp.pid"
  )
  sleep 0.5
  if ! kill -0 "$(cat "$PID_DIR/gateway_sp.pid")" 2>/dev/null; then
    echo "SP gateway failed to start; check $LOG_DIR/gateway_sp.log"
    tail -n 20 "$LOG_DIR/gateway_sp.log" || true
    exit 1
  fi
  echo "SP gateway pid $(cat "$PID_DIR/gateway_sp.pid"), logs: $LOG_DIR/gateway_sp.log"
}

start_user_gateway() {
  if [ "${NIL_DISABLE_GATEWAY:-0}" = "1" ]; then
    echo "Skipping User Gateway (NIL_DISABLE_GATEWAY=1)"
    return
  fi
  if [ "${NIL_START_USER_GATEWAY:-1}" != "1" ]; then
    echo "Skipping User Gateway (NIL_START_USER_GATEWAY=0)"
    return
  fi

  banner "Starting User gateway service (Port 8080)"
  ensure_nil_cli
  (
    cd "$ROOT_DIR/nil_gateway"
    # Router Mode (1), Listen on 8080, Uploads to uploads_user (staging)
    nohup env NIL_CHAIN_ID="$CHAIN_ID" NIL_HOME="$CHAIN_HOME" NIL_UPLOAD_DIR="$LOG_DIR/uploads_user" \
      NIL_LISTEN_ADDR=":8080" NIL_GATEWAY_ROUTER_MODE="1" \
      NIL_CLI_BIN="$ROOT_DIR/nil_cli/target/release/nil_cli" NIL_TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt" \
      NILCHAIND_BIN="$NILCHAIND_BIN" NIL_CMD_TIMEOUT_SECONDS="240" \
      "$GO_BIN" run . \
      >"$LOG_DIR/gateway_user.log" 2>&1 &
    echo $! > "$PID_DIR/gateway_user.pid"
  )
  sleep 0.5
  if ! kill -0 "$(cat "$PID_DIR/gateway_user.pid")" 2>/dev/null; then
    echo "User gateway failed to start; check $LOG_DIR/gateway_user.log"
    tail -n 20 "$LOG_DIR/gateway_user.log" || true
    exit 1
  fi
  echo "User gateway pid $(cat "$PID_DIR/gateway_user.pid"), logs: $LOG_DIR/gateway_user.log"
}

start_bridge() {
  local mode="${NIL_DEPLOY_BRIDGE:-1}"
  if [ "$mode" = "0" ]; then
    echo "Skipping bridge deployment (NIL_DEPLOY_BRIDGE=0)"
    BRIDGE_STATUS="skipped (NIL_DEPLOY_BRIDGE=0)"
    return
  fi
  if ! command -v forge >/dev/null 2>&1 || ! command -v cast >/dev/null 2>&1; then
    echo "Foundry tools not found; skipping NilBridge deployment. Install forge/cast or set NIL_DEPLOY_BRIDGE=0."
    BRIDGE_STATUS="skipped (forge/cast not found)"
    return
  fi

  # Avoid accidentally reusing a stale address from a previous chain reset.
  rm -f "$BRIDGE_ADDR_FILE"

  banner "Waiting for EVM RPC (8545)..."
  local attempts=30
  local i
  local ready=0
  for i in $(seq 1 "$attempts"); do
    if timeout 10s curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8545 --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' -H "Content-Type: application/json" >/dev/null; then
      echo "EVM RPC is ready."
      ready=1
      break
    fi
    echo "EVM RPC not ready (attempt $i/$attempts); sleeping 1s..."
    sleep 1
  done
  if [ "$ready" != "1" ]; then
    echo "EVM RPC never became ready; skipping NilBridge deployment."
    BRIDGE_STATUS="failed (EVM RPC not ready)"
    return
  fi

  banner "Deploying NilBridge to local EVM"
  if "$ROOT_DIR/scripts/deploy_bridge_local.sh" >/tmp/bridge_deploy.log 2>&1; then
    if [ -f "$BRIDGE_ADDR_FILE" ]; then
      BRIDGE_ADDRESS="$(cat "$BRIDGE_ADDR_FILE" | tr -d '\n' | tr -d '\r')"
      echo "NilBridge deployed at $BRIDGE_ADDRESS (exported to VITE_BRIDGE_ADDRESS for the web UI)"
      BRIDGE_STATUS="$BRIDGE_ADDRESS"
    else
      echo "Bridge deploy script completed but address file missing; check /tmp/bridge_deploy.log"
      BRIDGE_STATUS="failed (missing address file; see /tmp/bridge_deploy.log)"
    fi
  else
    echo "Bridge deploy script failed; see /tmp/bridge_deploy.log. Continuing without bridge."
    BRIDGE_STATUS="failed (see /tmp/bridge_deploy.log)"
  fi
}

start_web() {
  banner "Starting web (Vite dev server)"
  (
    cd "$ROOT_DIR/nil-website"
    if [ ! -d node_modules ]; then npm install >/dev/null; fi
    VITE_BRIDGE_ADDRESS="${BRIDGE_ADDRESS:-${VITE_BRIDGE_ADDRESS:-}}" \
    VITE_COSMOS_CHAIN_ID="$CHAIN_ID" \
    VITE_CHAIN_ID="$EVM_CHAIN_ID" \
    VITE_NILSTORE_PRECOMPILE="${VITE_NILSTORE_PRECOMPILE:-0x0000000000000000000000000000000000000900}" \
    nohup npm run dev -- --host 0.0.0.0 --port 5173 >"$LOG_DIR/website.log" 2>&1 &
    echo $! > "$PID_DIR/website.pid"
  )
  echo "web pid $(cat "$PID_DIR/website.pid"), logs: $LOG_DIR/website.log"
}

restart_gateway() {
  banner "Restarting gateway services"
  for svc in gateway_sp gateway_user; do
    pid_file="$PID_DIR/$svc.pid"
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file")
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 0.5
        if kill -0 "$pid" 2>/dev/null; then
          kill -9 "$pid" 2>/dev/null || true
        fi
        echo "Stopped $svc (pid $pid)"
      fi
      rm -f "$pid_file"
    fi
  done
  
  # Ensure ports are free
  for port in 8080 8082; do
    gw_pids=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$gw_pids" ]; then
      kill $gw_pids 2>/dev/null || true
      sleep 0.5
      gw_pids2=$(lsof -ti :$port 2>/dev/null || true)
      if [ -n "$gw_pids2" ]; then
        kill -9 $gw_pids2 2>/dev/null || true
      fi
    fi
  done

  start_sp_gateway
  start_user_gateway
}

start_all() {
  stop_all
  rm -rf "$LOG_DIR/uploads_sp" "$LOG_DIR/uploads_user"
  ensure_nil_core
  ensure_nilchaind
  init_chain
  start_chain
  register_demo_provider
  start_faucet
  auto_faucet_request
  start_sp_gateway
  start_user_gateway
  start_bridge
  start_web
  banner "Stack ready"
  cat <<EOF
RPC:         http://localhost:26657
REST/LCD:    http://localhost:1317
EVM RPC:     http://localhost:$EVM_RPC_PORT  (nilchaind, Chain ID $CHAIN_ID / 31337)
Faucet:      http://localhost:8081/faucet
SP Gateway:  http://localhost:8082 (Uploads to $LOG_DIR/uploads_sp)
User Gateway: http://localhost:8080 (Uploads to $LOG_DIR/uploads_user)
Web UI:      http://localhost:5173/#/dashboard
Bridge:      ${BRIDGE_ADDRESS:-$BRIDGE_STATUS}
Home:        $CHAIN_HOME
To stop:     ./scripts/run_local_stack.sh stop
EOF
}

stop_all() {
  banner "Stopping processes"
  for svc in nilchaind faucet gateway_sp gateway_user website; do
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
  for port in 26657 26656 1317 8545 8080 8081 8082 5173; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      sleep 0.5
      # If still alive, force kill.
      pids2=$(lsof -ti :"$port" 2>/dev/null || true)
      if [ -n "$pids2" ]; then
        kill -9 $pids2 2>/dev/null || true
        echo "Force killed processes on port $port ($pids2)"
      else
        echo "Cleared processes on port $port ($pids)"
      fi
    fi
  done
  wait_for_ports_clear
}

cmd="${1:-start}"
case "$cmd" in
  start) start_all ;;
  stop) stop_all ;;
  restart-gateway) restart_gateway ;;
  *)
    echo "Usage: $0 [start|stop|restart-gateway]"
    exit 1
    ;;
esac
