#!/usr/bin/env bash
# Devnet Alpha multi-provider stack runner.
# Starts:
# - polystorechaind (CometBFT + LCD + JSON-RPC)
# - polystore_faucet
# - N provider daemons (polystore_gateway, provider mode) on ports 8091+
# - 1 gateway router (polystore_gateway, router mode) on :8080
# - polystore-website (optional, default on)
#
# Usage:
#   ./scripts/run_devnet_alpha_multi_sp.sh start
#   ./scripts/run_devnet_alpha_multi_sp.sh stop
#
# Hub-only mode (no local providers):
#   PROVIDER_COUNT=0 ./scripts/run_devnet_alpha_multi_sp.sh start
#
# Networking:
#   By default, LCD + EVM JSON-RPC bind to localhost. Set POLYSTORE_BIND_ALL=1 to bind to 0.0.0.0 (LAN debugging).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/_artifacts/devnet_alpha_multi_sp"
PID_DIR="$LOG_DIR/pids"

CHAIN_HOME="${POLYSTORE_HOME:-$ROOT_DIR/_artifacts/polystorechain_data_devnet_alpha}"
CHAIN_ID="${CHAIN_ID:-31337}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
P2P_ADDR="${P2P_ADDR:-tcp://0.0.0.0:26656}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
EVM_WS_PORT="${EVM_WS_PORT:-8546}"
LCD_PORT="${LCD_PORT:-1317}"
FAUCET_PORT="${FAUCET_PORT:-8081}"
WEB_PORT="${WEB_PORT:-5173}"
GAS_PRICE="${POLYSTORE_GAS_PRICES:-0.001aatom}"
DENOM="${POLYSTORE_DENOM:-stake}"
POLYSTORE_BIND_ALL="${POLYSTORE_BIND_ALL:-0}" # set to 1 to bind LCD/EVM JSON-RPC to 0.0.0.0
POLYSTORE_REINIT_HOME="${POLYSTORE_REINIT_HOME:-0}" # set to 1 to allow wiping an existing CHAIN_HOME outside _artifacts/

POLYSTORECHAIND_BIN="$ROOT_DIR/polystorechain/polystorechaind"
POLYSTORE_CLI_BIN="$ROOT_DIR/polystore_cli/target/release/polystore_cli"
POLYSTORE_GATEWAY_BIN="$ROOT_DIR/polystore_gateway/polystore_gateway"
TRUSTED_SETUP="$ROOT_DIR/polystorechain/trusted_setup.txt"
GO_BIN="${GO_BIN:-$(command -v go)}"
POLYSTORE_CORE_LIB_DIR="${POLYSTORE_CORE_LIB_DIR:-$ROOT_DIR/polystore_core/target/release}"

PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
PROVIDER_PORT_BASE="${PROVIDER_PORT_BASE:-8091}"
# Each polystore_gateway instance runs an optional libp2p server. When enabled by
# default, we must ensure unique listen ports for multi-provider stacks.
P2P_PORT_BASE="${P2P_PORT_BASE:-9200}"

START_WEB="${START_WEB:-1}"

# Shared secret between the gateway router and all providers.
POLYSTORE_GATEWAY_SP_AUTH="${POLYSTORE_GATEWAY_SP_AUTH:-}"

FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"
# Default browser E2E wallet from polystore-website/src/lib/e2eWallet.ts.
POLYSTORE_E2E_WALLET_ADDR="${POLYSTORE_E2E_WALLET_ADDR:-nil1ser7fv30x7e7xr7n62tlr7m7z07ldqj4thdezk}"

mkdir -p "$LOG_DIR" "$PID_DIR"

if [ -d "$POLYSTORE_CORE_LIB_DIR" ]; then
  export LD_LIBRARY_PATH="$POLYSTORE_CORE_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

banner() { printf '\n=== %s ===\n' "$*"; }

CHAIN_MODULE_CLI_NAME="${POLYSTORE_CHAIN_MODULE_CLI_NAME:-}"

detect_chain_module_cli_name() {
  if [ -n "$CHAIN_MODULE_CLI_NAME" ]; then
    printf '%s\n' "$CHAIN_MODULE_CLI_NAME"
    return 0
  fi

  local candidate
  for candidate in polystorechain nilchain; do
    local help_out=""
    help_out="$("$POLYSTORECHAIND_BIN" tx "$candidate" --help 2>/dev/null || true)"
    if printf '%s' "$help_out" | grep -Eq "tx ${candidate}( |$)|${candidate} transactions subcommands"; then
      CHAIN_MODULE_CLI_NAME="$candidate"
      printf '%s\n' "$CHAIN_MODULE_CLI_NAME"
      return 0
    fi
  done

  echo "ERROR: failed to detect polystore module CLI namespace" >&2
  return 1
}

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

  if [ "$POLYSTORE_REINIT_HOME" != "1" ]; then
    cat >&2 <<EOF
Refusing to delete existing CHAIN_HOME outside the repo _artifacts/ tree:
  CHAIN_HOME=$CHAIN_HOME
  (resolved: $chain_home_real)

If you really intend to re-initialize this home, re-run with:
  POLYSTORE_REINIT_HOME=1
EOF
    exit 1
  fi

  banner "Wiping non-_artifacts chain home (POLYSTORE_REINIT_HOME=1): $CHAIN_HOME"
  rm -rf "$CHAIN_HOME"
}

ensure_polystore_core() {
  local lib_dir="$ROOT_DIR/polystore_core/target/release"

  polystore_core_has_symbols() {
    local sym
    local file=""

    # Prefer dynamic libraries because `nm` on archive `.a` can return non-zero
    # (causing false negatives under `set -o pipefail`).
    if [ -f "$lib_dir/libpolystore_core.so" ]; then
      file="$lib_dir/libpolystore_core.so"
    elif [ -f "$lib_dir/libpolystore_core.dylib" ]; then
      file="$lib_dir/libpolystore_core.dylib"
    elif [ -f "$lib_dir/libpolystore_core.a" ]; then
      file="$lib_dir/libpolystore_core.a"
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
      polystore_compute_mdu_root_from_witness_flat \
      polystore_expand_mdu_rs \
      polystore_reconstruct_mdu_rs \
      polystore_mdu0_builder_new_with_commitments \
      polystore_mdu0_builder_load_with_commitments \
      polystore_encode_payload_to_mdu \
      polystore_decode_payload_from_mdu; do
      if [ "$nm_supports_dash_d" = "1" ]; then
        if ! nm -D "$file" 2>/dev/null | awk '{print $3}' | sed 's/@.*$//' | grep -Fxq "$sym"; then
          return 1
        fi
      else
        if ! nm "$file" 2>/dev/null | awk '{print $3}' | sed 's/@.*$//' | grep -Fxq "$sym"; then
          return 1
        fi
      fi
    done

    return 0
  }

  if polystore_core_has_symbols; then
    return 0
  fi

  banner "Building polystore_core (native)"
  (cd "$ROOT_DIR/polystore_core" && cargo build --release)
  if [ ! -f "$lib_dir/libpolystore_core.a" ] && [ ! -f "$lib_dir/libpolystore_core.so" ] && [ ! -f "$lib_dir/libpolystore_core.dylib" ]; then
    local alt=""
    for ext in a so dylib; do
      alt=$(ls "$ROOT_DIR"/polystore_core/target/*/release/libpolystore_core."$ext" 2>/dev/null | head -n1 || true)
      if [ -n "$alt" ]; then
        mkdir -p "$lib_dir"
        cp "$alt" "$lib_dir/libpolystore_core.$ext"
        break
      fi
    done
  fi
  if [ ! -f "$lib_dir/libpolystore_core.a" ] && [ ! -f "$lib_dir/libpolystore_core.so" ] && [ ! -f "$lib_dir/libpolystore_core.dylib" ]; then
    echo "polystore_core native library not found after build" >&2
    exit 1
  fi
  if ! polystore_core_has_symbols; then
    echo "polystore_core native library is missing required symbols (stale build?)" >&2
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
    code=$(timeout 10s curl -sS -o "$tmp" -w '%{http_code}' "http://localhost:${LCD_PORT}/polystorechain/polystorechain/v1/providers" 2>/dev/null || true)
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
    code=$(timeout 10s curl -sS -o "$tmp" -w '%{http_code}' "http://localhost:${LCD_PORT}/polystorechain/polystorechain/v1/providers/$addr" 2>/dev/null || true)
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

ensure_polystorechaind() {
  banner "Building polystorechaind (via $GO_BIN)"
  (cd "$ROOT_DIR/polystorechain" && GOFLAGS="${GOFLAGS:-} -mod=mod" "$GO_BIN" build -o "$POLYSTORECHAIND_BIN" ./cmd/polystorechaind)
  (cd "$ROOT_DIR/polystorechain" && GOFLAGS="${GOFLAGS:-} -mod=mod" "$GO_BIN" install ./cmd/polystorechaind)
}

ensure_polystore_cli() {
  banner "Building polystore_cli (release)"
  (cd "$ROOT_DIR/polystore_cli" && cargo build --release)
}

ensure_polystore_gateway() {
  banner "Building polystore_gateway (via $GO_BIN)"
  (cd "$ROOT_DIR/polystore_gateway" && GOFLAGS="${GOFLAGS:-} -mod=mod" "$GO_BIN" build -o "$POLYSTORE_GATEWAY_BIN" .)
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

# Enable PolyStore EVM precompile for MetaMask tx UX.
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

# Optional devnet overrides for polystorechain params (useful for fast CI/E2E loops).
polystorechain = data.get("app_state", {}).get("polystorechain", {})
params = polystorechain.get("params", {}) if isinstance(polystorechain, dict) else {}
default_denom = (os.getenv("POLYSTORE_DENOM") or "stake").strip() or "stake"

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
set_uint_param("eip712_chain_id", "EVM_CHAIN_ID")
set_uint_param("month_len_blocks", "POLYSTORE_MONTH_LEN_BLOCKS")
set_uint_param("epoch_len_blocks", "POLYSTORE_EPOCH_LEN_BLOCKS")
set_uint_param("quota_bps_per_epoch_hot", "POLYSTORE_QUOTA_BPS_PER_EPOCH_HOT")
set_uint_param("quota_bps_per_epoch_cold", "POLYSTORE_QUOTA_BPS_PER_EPOCH_COLD")
set_uint_param("quota_min_blobs", "POLYSTORE_QUOTA_MIN_BLOBS")
set_uint_param("quota_max_blobs", "POLYSTORE_QUOTA_MAX_BLOBS")
set_uint_param("credit_cap_bps", "POLYSTORE_CREDIT_CAP_BPS")
set_uint_param("evict_after_missed_epochs", "POLYSTORE_EVICT_AFTER_MISSED_EPOCHS")

# Pricing knobs (optional, but useful for trusted devnet economics).
storage_price_set = set_dec_param("storage_price", "POLYSTORE_STORAGE_PRICE")
storage_price_min_set = set_dec_param("storage_price_min", "POLYSTORE_STORAGE_PRICE_MIN")
storage_price_max_set = set_dec_param("storage_price_max", "POLYSTORE_STORAGE_PRICE_MAX")
set_uint_param("storage_target_utilization_bps", "POLYSTORE_STORAGE_TARGET_UTILIZATION_BPS")

base_retrieval_fee_set = set_coin_param("base_retrieval_fee", "POLYSTORE_BASE_RETRIEVAL_FEE")
retrieval_price_set = set_coin_param("retrieval_price_per_blob", "POLYSTORE_RETRIEVAL_PRICE_PER_BLOB")
retrieval_price_min_set = set_coin_param("retrieval_price_per_blob_min", "POLYSTORE_RETRIEVAL_PRICE_PER_BLOB_MIN")
retrieval_price_max_set = set_coin_param("retrieval_price_per_blob_max", "POLYSTORE_RETRIEVAL_PRICE_PER_BLOB_MAX")
set_uint_param("retrieval_target_blobs_per_epoch", "POLYSTORE_RETRIEVAL_TARGET_BLOBS_PER_EPOCH")

deal_creation_fee_set = set_coin_param("deal_creation_fee", "POLYSTORE_DEAL_CREATION_FEE")

dynamic_enabled = set_bool_param("dynamic_pricing_enabled", "POLYSTORE_DYNAMIC_PRICING_ENABLED")
set_uint_param("dynamic_pricing_max_step_bps", "POLYSTORE_DYNAMIC_PRICING_MAX_STEP_BPS")

# If dynamic pricing is enabled and a min is provided, default the current price
# to the min so genesis doesn't start at 0 (storage) or out of range (retrieval).
if dynamic_enabled is True:
    if storage_price_min_set and not storage_price_set:
        params["storage_price"] = params.get("storage_price_min")
    if retrieval_price_min_set and not retrieval_price_set:
        params["retrieval_price_per_blob"] = params.get("retrieval_price_per_blob_min")
if isinstance(polystorechain, dict):
    polystorechain["params"] = params
    data["app_state"]["polystorechain"] = polystorechain

json.dump(data, open(path, "w"), indent=1)
PY
}

gen_provider_key() {
  local name="$1"
  "$POLYSTORECHAIND_BIN" keys add "$name" --home "$CHAIN_HOME" --keyring-backend test --output json >/dev/null 2>&1 || true
  "$POLYSTORECHAIND_BIN" keys show "$name" -a --home "$CHAIN_HOME" --keyring-backend test
}

init_chain() {
  wipe_chain_home_if_safe
  banner "Initializing chain at $CHAIN_HOME"
  "$POLYSTORECHAIND_BIN" init devnet-alpha --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

  printf '%s\n' "$FAUCET_MNEMONIC" | "$POLYSTORECHAIND_BIN" keys add faucet --home "$CHAIN_HOME" --keyring-backend test --recover --output json >/dev/null

  # Create provider keys and pre-fund them in genesis so they can register.
  for i in $(seq 1 "$PROVIDER_COUNT"); do
    addr="$(gen_provider_key "provider$i")"
    "$POLYSTORECHAIND_BIN" genesis add-genesis-account "$addr" "1000000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  done

  # Pre-fund the deterministic browser E2E wallet so live Playwright flows do
  # not depend on the faucet process coming up cleanly.
  "$POLYSTORECHAIND_BIN" genesis add-genesis-account "$POLYSTORE_E2E_WALLET_ADDR" \
    "1000000000$DENOM,1000000000000000000aatom" \
    --home "$CHAIN_HOME" \
    --keyring-backend test

  # Fund faucet + create validator
  "$POLYSTORECHAIND_BIN" genesis add-genesis-account faucet "100000000000$DENOM,1000000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  "$POLYSTORECHAIND_BIN" genesis gentx faucet "50000000000$DENOM" --chain-id "$CHAIN_ID" --home "$CHAIN_HOME" --keyring-backend test
  "$POLYSTORECHAIND_BIN" genesis collect-gentxs --home "$CHAIN_HOME"

  ensure_metadata

  APP_TOML="$CHAIN_HOME/config/app.toml"
  perl -pi -e 's/^max-txs *= *-1/max-txs = 0/' "$APP_TOML"
  perl -pi -e 's/^enable *= *false/enable = true/' "$APP_TOML"            # JSON-RPC enable
  if [ "$POLYSTORE_BIND_ALL" = "1" ]; then
    perl -pi -e "s|^address *= *\"127\\\\.0\\\\.0\\\\.1:[0-9]+\"|address = \"0.0.0.0:$EVM_RPC_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^ws-address *= *\"127\\\\.0\\\\.0\\\\.1:[0-9]+\"|ws-address = \"0.0.0.0:$EVM_WS_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^address *= *\"tcp://(?:localhost|127\\\\.0\\\\.0\\\\.1):[0-9]+\"|address = \"tcp://0.0.0.0:$LCD_PORT\"|" "$APP_TOML"
  else
    # Safe-by-default (hub profile): keep LCD + JSON-RPC local-only and expose only via reverse proxy.
    perl -pi -e "s|^address *= *\"0\\\\.0\\\\.0\\\\.0:[0-9]+\"|address = \"127.0.0.1:$EVM_RPC_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^ws-address *= *\"0\\\\.0\\\\.0\\\\.0:[0-9]+\"|ws-address = \"127.0.0.1:$EVM_WS_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^address *= *\"tcp://0\\\\.0\\\\.0\\\\.0:[0-9]+\"|address = \"tcp://127.0.0.1:$LCD_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^address *= *\"tcp://localhost:[0-9]+\"|address = \"tcp://127.0.0.1:$LCD_PORT\"|" "$APP_TOML"
  fi
  perl -pi -e 's/^enabled-unsafe-cors *= *false/enabled-unsafe-cors = true/' "$APP_TOML"
  perl -pi -e "s/^evm-chain-id *= *[0-9]+/evm-chain-id = $EVM_CHAIN_ID/" "$APP_TOML"
  python3 - "$APP_TOML" <<'PY' || true
import os, sys, pathlib
path = pathlib.Path(sys.argv[1])
txt = path.read_text()
bind_all = os.environ.get("POLYSTORE_BIND_ALL", "0") == "1"
evm_rpc_port = os.environ.get("EVM_RPC_PORT", "8545")
evm_ws_port = os.environ.get("EVM_WS_PORT", "8546")
lcd_port = os.environ.get("LCD_PORT", "1317")
bind_host = "0.0.0.0" if bind_all else "127.0.0.1"
replacements = [
    ('enabled-unsafe-cors = false', 'enabled-unsafe-cors = true'),
    ('evm-chain-id = 262144', f'evm-chain-id = {os.environ.get("EVM_CHAIN_ID", "31337")}'),
]
if bind_all:
    replacements = [
        ('address = "127.0.0.1:8545"', f'address = "0.0.0.0:{evm_rpc_port}"'),
        ('ws-address = "127.0.0.1:8546"', f'ws-address = "0.0.0.0:{evm_ws_port}"'),
        ('address = "tcp://localhost:1317"', f'address = "tcp://0.0.0.0:{lcd_port}"'),
        ('address = "tcp://127.0.0.1:1317"', f'address = "tcp://0.0.0.0:{lcd_port}"'),
    ] + replacements
else:
    replacements = [
        ('address = "0.0.0.0:8545"', f'address = "127.0.0.1:{evm_rpc_port}"'),
        ('ws-address = "0.0.0.0:8546"', f'ws-address = "127.0.0.1:{evm_ws_port}"'),
        ('address = "tcp://0.0.0.0:1317"', f'address = "tcp://127.0.0.1:{lcd_port}"'),
        ('address = "tcp://localhost:1317"', f'address = "tcp://127.0.0.1:{lcd_port}"'),
    ] + replacements
for src, dst in replacements:
    txt = txt.replace(src, dst)
path.write_text(txt)
PY
}

start_chain() {
  banner "Starting polystorechaind"
  local grpc_flags=()
  if [ "${POLYSTORE_GRPC_ENABLE:-0}" = "1" ]; then
    grpc_flags+=(--grpc.enable=true)
    if [ "${POLYSTORE_GRPC_WEB_ENABLE:-1}" = "1" ]; then
      grpc_flags+=(--grpc-web.enable=true)
    else
      grpc_flags+=(--grpc-web.enable=false)
    fi
  else
    # Keep local stacks resilient when port 9090 is already occupied by another
    # service on a developer machine. gRPC is not required for browser/gateway e2e.
    grpc_flags+=(--grpc.enable=false --grpc-web.enable=false)
  fi
  local json_rpc_addr="127.0.0.1:${EVM_RPC_PORT}"
  local json_rpc_ws_addr="127.0.0.1:${EVM_WS_PORT}"
  if [ "$POLYSTORE_BIND_ALL" = "1" ]; then
    json_rpc_addr="0.0.0.0:${EVM_RPC_PORT}"
    json_rpc_ws_addr="0.0.0.0:${EVM_WS_PORT}"
  fi
  nohup "$POLYSTORECHAIND_BIN" start \
    --home "$CHAIN_HOME" \
    --rpc.laddr "$RPC_ADDR" \
    --p2p.laddr "$P2P_ADDR" \
    --minimum-gas-prices "$GAS_PRICE" \
    --api.enable \
    "${grpc_flags[@]}" \
    --json-rpc.enable=true \
    --json-rpc.address "$json_rpc_addr" \
    --json-rpc.ws-address "$json_rpc_ws_addr" \
    --json-rpc.api eth,net,web3 \
    >"$LOG_DIR/polystorechaind.log" 2>&1 &
  echo $! >"$PID_DIR/polystorechaind.pid"
  sleep 1
  if ! kill -0 "$(cat "$PID_DIR/polystorechaind.pid")" 2>/dev/null; then
    echo "polystorechaind failed to start; check $LOG_DIR/polystorechaind.log"
    tail -n 40 "$LOG_DIR/polystorechaind.log" || true
    exit 1
  fi
  echo "polystorechaind pid $(cat "$PID_DIR/polystorechaind.pid"), logs: $LOG_DIR/polystorechaind.log"
}

start_faucet() {
  banner "Starting faucet service"
  (
    cd "$ROOT_DIR/polystore_faucet"
    nohup env POLYSTORE_CHAIN_ID="$CHAIN_ID" POLYSTORE_HOME="$CHAIN_HOME" POLYSTORE_NODE="$RPC_ADDR" POLYSTORE_DENOM="$DENOM" POLYSTORE_AMOUNT="1000000000000000000aatom,100000000stake" POLYSTORE_GAS_PRICES="$GAS_PRICE" POLYSTORE_LISTEN_ADDR="127.0.0.1:${FAUCET_PORT}" \
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
  local module_cli
  module_cli="$(detect_chain_module_cli_name)"
  "$POLYSTORECHAIND_BIN" tx "$module_cli" register-provider General 1099511627776 \
    --endpoint "$endpoint" \
    --from "$key" \
    --chain-id "$CHAIN_ID" \
    --node "$RPC_ADDR" \
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
  addr="$("$POLYSTORECHAIND_BIN" keys show "$key" -a --home "$CHAIN_HOME" --keyring-backend test 2>/dev/null || true)"
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
    cd "$ROOT_DIR/polystore_gateway"
    nohup env \
      POLYSTORE_RUNTIME_PERSONA="provider-daemon" \
      POLYSTORE_LISTEN_ADDR=":$port" \
      POLYSTORE_P2P_ENABLED="${POLYSTORE_P2P_ENABLED:-1}" \
      POLYSTORE_P2P_LISTEN_ADDRS="/ip4/127.0.0.1/tcp/$p2p_port/ws" \
      POLYSTORE_CHAIN_ID="$CHAIN_ID" \
      POLYSTORE_HOME="$CHAIN_HOME" \
      POLYSTORE_NODE="$RPC_ADDR" \
      POLYSTORE_LCD_BASE="http://127.0.0.1:${LCD_PORT}" \
      POLYSTORE_UPLOAD_DIR="$dir" \
      POLYSTORE_CLI_BIN="$POLYSTORE_CLI_BIN" \
      POLYSTORE_TRUSTED_SETUP="$TRUSTED_SETUP" \
      POLYSTORECHAIND_BIN="$POLYSTORECHAIND_BIN" \
      POLYSTORE_PROVIDER_KEY="$key" \
      POLYSTORE_GATEWAY_SP_AUTH="$POLYSTORE_GATEWAY_SP_AUTH" \
      "$POLYSTORE_GATEWAY_BIN" \
      >"$LOG_DIR/$key.log" 2>&1 &
    echo $! >"$PID_DIR/$key.pid"
  )
  echo "$key pid $(cat "$PID_DIR/$key.pid"), logs: $LOG_DIR/$key.log"
}

start_router() {
  banner "Starting gateway router (polystore_gateway)"
  local p2p_port="$P2P_PORT_BASE"
  (
    cd "$ROOT_DIR/polystore_gateway"
    nohup env \
      POLYSTORE_RUNTIME_PERSONA="user-gateway" \
      POLYSTORE_GATEWAY_ROUTER="1" \
      POLYSTORE_P2P_ENABLED="${POLYSTORE_P2P_ENABLED:-1}" \
      POLYSTORE_P2P_LISTEN_ADDRS="/ip4/127.0.0.1/tcp/$p2p_port/ws" \
      POLYSTORE_CHAIN_ID="$CHAIN_ID" \
      POLYSTORE_HOME="$CHAIN_HOME" \
      POLYSTORE_NODE="$RPC_ADDR" \
      POLYSTORE_LCD_BASE="http://127.0.0.1:${LCD_PORT}" \
      POLYSTORE_UPLOAD_DIR="$LOG_DIR/router_tmp" \
      POLYSTORECHAIND_BIN="$POLYSTORECHAIND_BIN" \
      POLYSTORE_GATEWAY_SP_AUTH="$POLYSTORE_GATEWAY_SP_AUTH" \
      "$POLYSTORE_GATEWAY_BIN" \
      >"$LOG_DIR/router.log" 2>&1 &
    echo $! >"$PID_DIR/router.pid"
  )
  echo "router pid $(cat "$PID_DIR/router.pid"), logs: $LOG_DIR/router.log"
}

start_web() {
  banner "Starting web (Vite dev server)"
  (
    cd "$ROOT_DIR/polystore-website"
    if [ ! -d node_modules ]; then npm install >/dev/null; fi
    VITE_ENABLE_FAUCET="${VITE_ENABLE_FAUCET:-1}" \
    VITE_API_BASE="${VITE_API_BASE:-http://localhost:${FAUCET_PORT}}" \
    VITE_LCD_BASE="${VITE_LCD_BASE:-http://localhost:${LCD_PORT}}" \
    VITE_EVM_RPC="${VITE_EVM_RPC:-http://localhost:$EVM_RPC_PORT}" \
    VITE_SP_BASE="${VITE_SP_BASE:-http://localhost:${PROVIDER_PORT_BASE}}" \
    VITE_GATEWAY_BASE="${VITE_GATEWAY_BASE:-http://localhost:8080}" \
    VITE_COSMOS_CHAIN_ID="$CHAIN_ID" \
    VITE_CHAIN_ID="$EVM_CHAIN_ID" \
    VITE_POLYSTORE_PRECOMPILE="${VITE_POLYSTORE_PRECOMPILE:-0x0000000000000000000000000000000000000900}" \
    nohup npm run dev -- --host 0.0.0.0 --port "$WEB_PORT" >"$LOG_DIR/website.log" 2>&1 &
    echo $! >"$PID_DIR/website.pid"
  )
  echo "website pid $(cat "$PID_DIR/website.pid"), logs: $LOG_DIR/website.log"
}

stop_all() {
  banner "Stopping processes"
  for svc in polystorechaind faucet router website; do
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
  local ports=("${RPC_ADDR##*:}" "${P2P_ADDR##*:}" "$LCD_PORT" "$EVM_RPC_PORT" "$EVM_WS_PORT" 8080 "$FAUCET_PORT" "$WEB_PORT" "$P2P_PORT_BASE")
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

  if [ -z "$POLYSTORE_GATEWAY_SP_AUTH" ]; then
    if command -v openssl >/dev/null 2>&1; then
      POLYSTORE_GATEWAY_SP_AUTH="$(openssl rand -hex 32)"
    else
      POLYSTORE_GATEWAY_SP_AUTH="$(date +%s%N)"
    fi
  fi

  ensure_polystore_core
  ensure_polystorechaind
  ensure_polystore_cli
  ensure_polystore_gateway
  init_chain
  start_chain
  start_faucet

  wait_for_http "lcd" "http://localhost:${LCD_PORT}/cosmos/base/tendermint/v1beta1/node_info" "200" 60 1
  wait_for_http "polystorechain lcd" "http://localhost:${LCD_PORT}/polystorechain/polystorechain/v1/params" "200" 60 1
  wait_for_http "faucet" "http://localhost:${FAUCET_PORT}/faucet" "200,405" 60 1

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
  echo "$POLYSTORE_GATEWAY_SP_AUTH" >"$LOG_DIR/sp_auth.txt"
  cat <<EOF
RPC:         http://localhost:${RPC_ADDR##*:}
REST/LCD:    http://localhost:${LCD_PORT}
EVM RPC:     http://localhost:$EVM_RPC_PORT  (Cosmos Chain ID $CHAIN_ID / EVM Chain ID $EVM_CHAIN_ID)
Faucet:      http://localhost:${FAUCET_PORT}/faucet
Gateway:     http://localhost:8080/gateway/upload
Web UI:      http://localhost:${WEB_PORT}/#/dashboard
Providers:   $PROVIDER_COUNT (ports starting at $PROVIDER_PORT_BASE)
Home:        $CHAIN_HOME
SP Auth:     $POLYSTORE_GATEWAY_SP_AUTH  (also saved in $LOG_DIR/sp_auth.txt)
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
