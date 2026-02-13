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
#
# Networking:
#   By default, LCD + EVM JSON-RPC bind to localhost. Set NIL_BIND_ALL=1 to bind to 0.0.0.0 (LAN debugging).
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
NIL_BIND_ALL="${NIL_BIND_ALL:-0}" # set to 1 to bind LCD/EVM JSON-RPC to 0.0.0.0
NIL_REINIT_HOME="${NIL_REINIT_HOME:-0}" # set to 1 to allow wiping an existing CHAIN_HOME outside _artifacts/

NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"
NIL_CLI_BIN="$ROOT_DIR/nil_cli/target/release/nil_cli"
NIL_GATEWAY_BIN="$ROOT_DIR/nil_gateway/nil_gateway"
TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt"
GO_BIN="${GO_BIN:-$(command -v go)}"

PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
PROVIDER_PORT_BASE="${PROVIDER_PORT_BASE:-8091}"
# Each nil_gateway instance runs an optional libp2p server. When enabled by
# default, we must ensure unique listen ports for multi-provider stacks.
P2P_PORT_BASE="${P2P_PORT_BASE:-9200}"

START_WEB="${START_WEB:-1}"

# Shared secret between the gateway router and all providers.
NIL_GATEWAY_SP_AUTH="${NIL_GATEWAY_SP_AUTH:-}"

FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"

mkdir -p "$LOG_DIR" "$PID_DIR"

banner() { printf '\n=== %s ===\n' "$*"; }

chain_home_is_under_artifacts() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required for this script (missing python3 in PATH)" >&2
    exit 1
  fi

  python3 - "$CHAIN_HOME" "$ROOT_DIR/_artifacts" <<'PY'
import os
import sys

home = os.path.realpath(sys.argv[1])
artifacts = os.path.realpath(sys.argv[2])
try:
    common = os.path.commonpath([home, artifacts])
except ValueError:
    common = ""
sys.exit(0 if common == artifacts else 1)
PY
}

wipe_chain_home_if_safe() {
  if [ -z "$CHAIN_HOME" ]; then
    echo "Refusing to wipe: CHAIN_HOME is empty" >&2
    exit 1
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required for this script (missing python3 in PATH)" >&2
    exit 1
  fi

  if [ ! -e "$CHAIN_HOME" ]; then
    return 0
  fi

  if [ ! -d "$CHAIN_HOME" ]; then
    echo "Refusing to wipe: CHAIN_HOME exists but is not a directory: $CHAIN_HOME" >&2
    exit 1
  fi

  local chain_home_real artifacts_real root_real
  chain_home_real="$(python3 - "$CHAIN_HOME" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  artifacts_real="$(python3 - "$ROOT_DIR/_artifacts" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  root_real="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"

  if [ "$chain_home_real" = "/" ] || [ -z "$chain_home_real" ]; then
    echo "Refusing to wipe: CHAIN_HOME resolved to an unsafe path: '$chain_home_real'" >&2
    exit 1
  fi
  if [ "$chain_home_real" = "$root_real" ] || [ "$chain_home_real" = "$artifacts_real" ]; then
    echo "Refusing to wipe: CHAIN_HOME resolved to a protected path: $chain_home_real" >&2
    exit 1
  fi

  if chain_home_is_under_artifacts; then
    banner "Wiping chain home under _artifacts: $CHAIN_HOME"
    rm -rf "$CHAIN_HOME"
    return 0
  fi

  if [ "$NIL_REINIT_HOME" != "1" ]; then
    cat >&2 <<EOF
Refusing to delete existing CHAIN_HOME outside the repo _artifacts/ tree:
  CHAIN_HOME=$CHAIN_HOME
  (resolved: $chain_home_real)

If you really intend to re-initialize this home, re-run with:
  NIL_REINIT_HOME=1
EOF
    exit 1
  fi

  banner "Wiping non-_artifacts chain home (NIL_REINIT_HOME=1): $CHAIN_HOME"
  rm -rf "$CHAIN_HOME"
}

ensure_nil_core() {
  local lib_dir="$ROOT_DIR/nil_core/target/release"

  nil_core_has_symbols() {
    local sym
    local file=""

    # Prefer dynamic libraries because `nm` on archive `.a` can return non-zero
    # (causing false negatives under `set -o pipefail`).
    if [ -f "$lib_dir/libnil_core.so" ]; then
      file="$lib_dir/libnil_core.so"
    elif [ -f "$lib_dir/libnil_core.dylib" ]; then
      file="$lib_dir/libnil_core.dylib"
    elif [ -f "$lib_dir/libnil_core.a" ]; then
      file="$lib_dir/libnil_core.a"
    else
      return 1
    fi

    if ! command -v nm >/dev/null 2>&1; then
      return 1
    fi

    # Dynamic libs: use nm -D where available. Static libs: nm defaults are fine.
    # Avoid bash array edge-cases under `set -u` on older shells.
    local nm_supports_dash_d="0"
    if [[ "$file" == *.so ]] && nm -D "$file" >/dev/null 2>&1; then
      nm_supports_dash_d="1"
    fi

	    for sym in \
	      nil_compute_mdu_root_from_witness_flat \
	      nil_expand_mdu_rs \
	      nil_reconstruct_mdu_rs \
	      nil_mdu0_builder_new_with_commitments \
	      nil_mdu0_builder_load_with_commitments \
	      nil_encode_payload_to_mdu \
	      nil_decode_payload_from_mdu; do
	      if [ "$nm_supports_dash_d" = "1" ]; then
	        if ! nm -D "$file" 2>/dev/null | grep -Eq "(^|[[:space:]]|_)${sym}([[:space:]]|$)"; then
	          return 1
	        fi
      else
        if ! nm "$file" 2>/dev/null | grep -Eq "(^|[[:space:]]|_)${sym}([[:space:]]|$)"; then
          return 1
        fi
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
import os
import re
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

# Optional devnet overrides for nilchain params (useful for fast CI/E2E loops).
nilchain = data.get("app_state", {}).get("nilchain", {})
params = nilchain.get("params", {}) if isinstance(nilchain, dict) else {}
default_denom = (os.getenv("NIL_DENOM") or "stake").strip() or "stake"

def set_uint_param(key, env_key):
    raw = os.getenv(env_key)
    if raw is None:
        return
    raw = raw.strip()
    if raw == "":
        return
    try:
        val = int(raw, 10)
    except Exception:
        return
    if val < 0:
        return
    params[key] = str(val)

def set_dec_param(key, env_key):
    raw = os.getenv(env_key)
    if raw is None:
        return False
    raw = raw.strip()
    if raw == "":
        return False
    if not re.match(r"^[0-9]+(\.[0-9]+)?$", raw):
        return False
    params[key] = raw
    return True

def parse_coin(raw, fallback_denom):
    if raw is None:
        return None
    raw = raw.strip()
    if raw == "":
        return None

    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
        except Exception:
            return None
        denom = (obj.get("denom") or "").strip() or fallback_denom
        amount = (obj.get("amount") or "").strip()
        if not re.match(r"^[0-9]+$", amount):
            return None
        return {"denom": denom, "amount": amount}

    m = re.match(r"^([0-9]+)([a-zA-Z][a-zA-Z0-9/:._-]*)?$", raw)
    if not m:
        return None
    amount = m.group(1)
    denom = m.group(2) or fallback_denom
    return {"denom": denom, "amount": amount}

def set_coin_param(key, env_key):
    coin = parse_coin(os.getenv(env_key), default_denom)
    if coin is None:
        return False
    params[key] = coin
    return True

def set_bool_param(key, env_key):
    raw = os.getenv(env_key)
    if raw is None:
        return None
    raw = raw.strip().lower()
    if raw in ("1", "true", "t", "yes", "y", "on"):
        params[key] = True
        return True
    if raw in ("0", "false", "f", "no", "n", "off"):
        params[key] = False
        return False
    return None

# Existing uint64 overrides.
set_uint_param("month_len_blocks", "NIL_MONTH_LEN_BLOCKS")
set_uint_param("epoch_len_blocks", "NIL_EPOCH_LEN_BLOCKS")
set_uint_param("quota_bps_per_epoch_hot", "NIL_QUOTA_BPS_PER_EPOCH_HOT")
set_uint_param("quota_bps_per_epoch_cold", "NIL_QUOTA_BPS_PER_EPOCH_COLD")
set_uint_param("quota_min_blobs", "NIL_QUOTA_MIN_BLOBS")
set_uint_param("quota_max_blobs", "NIL_QUOTA_MAX_BLOBS")
set_uint_param("credit_cap_bps", "NIL_CREDIT_CAP_BPS")
set_uint_param("evict_after_missed_epochs", "NIL_EVICT_AFTER_MISSED_EPOCHS")

# Pricing knobs (optional, but useful for trusted devnet economics).
storage_price_set = set_dec_param("storage_price", "NIL_STORAGE_PRICE")
storage_price_min_set = set_dec_param("storage_price_min", "NIL_STORAGE_PRICE_MIN")
storage_price_max_set = set_dec_param("storage_price_max", "NIL_STORAGE_PRICE_MAX")
set_uint_param("storage_target_utilization_bps", "NIL_STORAGE_TARGET_UTILIZATION_BPS")

base_retrieval_fee_set = set_coin_param("base_retrieval_fee", "NIL_BASE_RETRIEVAL_FEE")
retrieval_price_set = set_coin_param("retrieval_price_per_blob", "NIL_RETRIEVAL_PRICE_PER_BLOB")
retrieval_price_min_set = set_coin_param("retrieval_price_per_blob_min", "NIL_RETRIEVAL_PRICE_PER_BLOB_MIN")
retrieval_price_max_set = set_coin_param("retrieval_price_per_blob_max", "NIL_RETRIEVAL_PRICE_PER_BLOB_MAX")
set_uint_param("retrieval_target_blobs_per_epoch", "NIL_RETRIEVAL_TARGET_BLOBS_PER_EPOCH")

deal_creation_fee_set = set_coin_param("deal_creation_fee", "NIL_DEAL_CREATION_FEE")

dynamic_enabled = set_bool_param("dynamic_pricing_enabled", "NIL_DYNAMIC_PRICING_ENABLED")
set_uint_param("dynamic_pricing_max_step_bps", "NIL_DYNAMIC_PRICING_MAX_STEP_BPS")

# If dynamic pricing is enabled and a min is provided, default the current price
# to the min so genesis doesn't start at 0 (storage) or out of range (retrieval).
if dynamic_enabled is True:
    if storage_price_min_set and not storage_price_set:
        params["storage_price"] = params.get("storage_price_min")
    if retrieval_price_min_set and not retrieval_price_set:
        params["retrieval_price_per_blob"] = params.get("retrieval_price_per_blob_min")
if isinstance(nilchain, dict):
    nilchain["params"] = params
    data["app_state"]["nilchain"] = nilchain

json.dump(data, open(path, "w"), indent=1)
PY
}

gen_provider_key() {
  local name="$1"
  "$NILCHAIND_BIN" keys add "$name" --home "$CHAIN_HOME" --keyring-backend test --output json >/dev/null 2>&1 || true
  "$NILCHAIND_BIN" keys show "$name" -a --home "$CHAIN_HOME" --keyring-backend test
}

init_chain() {
  wipe_chain_home_if_safe
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
  if [ "$NIL_BIND_ALL" = "1" ]; then
    perl -pi -e 's|^address *= *"127\\.0\\.0\\.1:8545"|address = "0.0.0.0:8545"|' "$APP_TOML"
    perl -pi -e 's|^ws-address *= *"127\\.0\\.0\\.1:8546"|ws-address = "0.0.0.0:8546"|' "$APP_TOML"
    perl -pi -e 's|^address *= *"tcp://localhost:1317"|address = "tcp://0.0.0.0:1317"|' "$APP_TOML"
  else
    # Safe-by-default (hub profile): keep LCD + JSON-RPC local-only and expose only via reverse proxy.
    perl -pi -e 's|^address *= *"0\\.0\\.0\\.0:8545"|address = "127.0.0.1:8545"|' "$APP_TOML"
    perl -pi -e 's|^ws-address *= *"0\\.0\\.0\\.0:8546"|ws-address = "127.0.0.1:8546"|' "$APP_TOML"
    perl -pi -e 's|^address *= *"tcp://0\\.0\\.0\\.0:1317"|address = "tcp://127.0.0.1:1317"|' "$APP_TOML"
    perl -pi -e 's|^address *= *"tcp://localhost:1317"|address = "tcp://127.0.0.1:1317"|' "$APP_TOML"
  fi
  perl -pi -e 's/^enabled-unsafe-cors *= *false/enabled-unsafe-cors = true/' "$APP_TOML"
  perl -pi -e "s/^evm-chain-id *= *[0-9]+/evm-chain-id = $EVM_CHAIN_ID/" "$APP_TOML"
}

start_chain() {
  banner "Starting nilchaind"
  local grpc_flags=()
  if [ "${NIL_GRPC_ENABLE:-0}" = "1" ]; then
    grpc_flags+=(--grpc.enable=true)
    if [ "${NIL_GRPC_WEB_ENABLE:-1}" = "1" ]; then
      grpc_flags+=(--grpc-web.enable=true)
    else
      grpc_flags+=(--grpc-web.enable=false)
    fi
  else
    # Keep local stacks resilient when port 9090 is already occupied by another
    # service on a developer machine. gRPC is not required for browser/gateway e2e.
    grpc_flags+=(--grpc.enable=false --grpc-web.enable=false)
  fi
  nohup "$NILCHAIND_BIN" start \
    --home "$CHAIN_HOME" \
    --rpc.laddr "$RPC_ADDR" \
    --minimum-gas-prices "$GAS_PRICE" \
    --api.enable \
    "${grpc_flags[@]}" \
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
  local p2p_port="$((P2P_PORT_BASE + i))"
  local dir="$LOG_DIR/providers/$key"
  mkdir -p "$dir"
  (
    cd "$ROOT_DIR/nil_gateway"
    nohup env \
      NIL_LISTEN_ADDR=":$port" \
      NIL_P2P_ENABLED="${NIL_P2P_ENABLED:-1}" \
      NIL_P2P_LISTEN_ADDRS="/ip4/127.0.0.1/tcp/$p2p_port/ws" \
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
  local p2p_port="$P2P_PORT_BASE"
  (
    cd "$ROOT_DIR/nil_gateway"
    nohup env \
      NIL_GATEWAY_ROUTER="1" \
      NIL_P2P_ENABLED="${NIL_P2P_ENABLED:-1}" \
      NIL_P2P_LISTEN_ADDRS="/ip4/127.0.0.1/tcp/$p2p_port/ws" \
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
  local ports=(26657 26656 1317 "$EVM_RPC_PORT" 8080 8081 5173 "$P2P_PORT_BASE")
  if [ "$PROVIDER_COUNT" -gt 0 ]; then
    for i in $(seq 1 "$PROVIDER_COUNT"); do
      ports+=("$((PROVIDER_PORT_BASE + i - 1))")
      ports+=("$((P2P_PORT_BASE + i))")
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
      # Use /health to avoid relying on MethodNotAllowed/NotFound semantics for /gateway/upload.
      wait_for_http "provider$i" "http://localhost:$port/health" "200" 60 1
    done
  fi

  start_router
  wait_for_http "router" "http://localhost:8080/health" "200" 60 1

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
