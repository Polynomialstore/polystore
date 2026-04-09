#!/usr/bin/env bash
# Spin up a local PolyStore Chain stack: chain (CometBFT+EVM), faucet, and web UI.
# Usage:
#   ./scripts/run_local_stack.sh start   # default
#   ./scripts/run_local_stack.sh stop    # kill background processes started by this script
#
# Networking:
#   By default, LCD + EVM JSON-RPC bind to localhost. Set POLYSTORE_BIND_ALL=1 to bind to 0.0.0.0 (LAN debugging).
# Safety:
#   If POLYSTORE_HOME points outside _artifacts and already exists, the script refuses to wipe it unless POLYSTORE_REINIT_HOME=1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/_artifacts/localnet"
PID_DIR="$LOG_DIR/pids"
CHAIN_HOME="${POLYSTORE_HOME:-$ROOT_DIR/_artifacts/polystorechain_data}"
CHAIN_ID="${CHAIN_ID:-31337}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
EVM_WS_PORT="${EVM_WS_PORT:-8546}"
LCD_PORT="${LCD_PORT:-1317}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
P2P_ADDR="${P2P_ADDR:-tcp://0.0.0.0:26656}"
FAUCET_PORT="${FAUCET_PORT:-8081}"
GAS_PRICE="${POLYSTORE_GAS_PRICES:-0.001aatom}"
DENOM="${POLYSTORE_DENOM:-stake}"
POLYSTORE_BIND_ALL="${POLYSTORE_BIND_ALL:-0}" # set to 1 to bind LCD/EVM JSON-RPC to 0.0.0.0
POLYSTORE_REINIT_HOME="${POLYSTORE_REINIT_HOME:-0}" # set to 1 to allow wiping an existing CHAIN_HOME outside _artifacts/
export POLYSTORE_AMOUNT="1000000000000000000aatom,100000000stake" # 1 aatom, 100 stake
FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"
POLYSTORECHAIND_BIN="$ROOT_DIR/polystorechain/polystorechaind"
GO_BIN="${GO_BIN:-/Users/michaelseiler/.gvm/gos/go1.25.5/bin/go}"
GATEWAY_BIN="$LOG_DIR/polystore_gateway"
POLYSTORE_CORE_LIB_DIR="${POLYSTORE_CORE_LIB_DIR:-$ROOT_DIR/polystore_core/target/release}"
POLYSTORE_CORE_LIB_SO="$POLYSTORE_CORE_LIB_DIR/libpolystore_core.so"
BRIDGE_ADDR_FILE="$ROOT_DIR/_artifacts/bridge_address.txt"
BRIDGE_ADDRESS=""
BRIDGE_STATUS="not deployed"
# Default: attempt to deploy the bridge when the stack starts (set to 0 to skip).
POLYSTORE_DEPLOY_BRIDGE="${POLYSTORE_DEPLOY_BRIDGE:-1}"
POLYSTORE_EVM_DEV_PRIVKEY="${POLYSTORE_EVM_DEV_PRIVKEY:-0xa6694e2fb21957d26c442f80f14954fd84f491a79a7e5f1133495403c0244c1d}"
export POLYSTORE_EVM_DEV_PRIVKEY
# Shared auth between user-gateway and provider-daemon for /sp/session-proof forwarding.
POLYSTORE_GATEWAY_SP_AUTH="${POLYSTORE_GATEWAY_SP_AUTH:-}"
# Enable the EVM mempool by default so JSON-RPC / MetaMask works out of the box.
POLYSTORE_DISABLE_EVM_MEMPOOL="${POLYSTORE_DISABLE_EVM_MEMPOOL:-0}"
export POLYSTORE_DISABLE_EVM_MEMPOOL
# Auto-fund the default demo EVM account by calling the faucet once on startup.
POLYSTORE_AUTO_FAUCET_EVM="${POLYSTORE_AUTO_FAUCET_EVM:-0}"
POLYSTORE_ENABLE_TX_RELAY="${POLYSTORE_ENABLE_TX_RELAY:-0}"
POLYSTORE_AUTO_FAUCET_EVM_ADDR="${POLYSTORE_AUTO_FAUCET_EVM_ADDR:-0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2}"
# Start the faucet service (minimal faucet enabled by default).
# The faucet runs, but auto-funding and the tx-relay remain off so the stack stays wallet-first.
POLYSTORE_START_FAUCET="${POLYSTORE_START_FAUCET:-1}"
# Start the web UI (optional). Set to 0 for headless stacks / CI.
POLYSTORE_START_WEB="${POLYSTORE_START_WEB:-1}"
# User gateway mode (0=standalone local-cache user-gateway, 1=proxy/router compatibility mode).
# Standalone is the default for local developer UX so auto-download can use local gateway MDU cache.
POLYSTORE_USER_GATEWAY_PROXY_MODE="${POLYSTORE_USER_GATEWAY_PROXY_MODE:-${POLYSTORE_GATEWAY_ROUTER:-0}}"
if [ ! -x "$GO_BIN" ]; then
  GO_BIN="$(command -v go)"
fi

if [ -d "$POLYSTORE_CORE_LIB_DIR" ]; then
  export LD_LIBRARY_PATH="$POLYSTORE_CORE_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

if [ -z "$POLYSTORE_GATEWAY_SP_AUTH" ]; then
  if command -v openssl >/dev/null 2>&1; then
    POLYSTORE_GATEWAY_SP_AUTH="$(openssl rand -hex 32)"
  else
    POLYSTORE_GATEWAY_SP_AUTH="$(date +%s%N)"
  fi
fi
export POLYSTORE_GATEWAY_SP_AUTH
echo "$POLYSTORE_GATEWAY_SP_AUTH" >"$LOG_DIR/sp_auth.txt"

banner() { printf '\n=== %s ===\n' "$*"; }

listener_pids_for_port() {
  local port="$1"
  # Only return server listeners bound on this local port.
  # This avoids killing unrelated client processes (e.g. browsers with ESTABLISHED
  # outbound sockets to localhost:8080/5173).
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
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

eth_to_polystore_bech32() {
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
  if [ "${POLYSTORE_AUTO_FAUCET_EVM}" != "1" ]; then
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

  local target_polystore
  if [[ "$POLYSTORE_AUTO_FAUCET_EVM_ADDR" == 0x* || "$POLYSTORE_AUTO_FAUCET_EVM_ADDR" == 0X* ]]; then
    target_polystore="$(eth_to_polystore_bech32 "$POLYSTORE_AUTO_FAUCET_EVM_ADDR" 2>/dev/null || true)"
  else
    target_polystore="$POLYSTORE_AUTO_FAUCET_EVM_ADDR"
  fi

  if [ -z "$target_polystore" ]; then
    echo "Skipping auto faucet request: failed to convert $POLYSTORE_AUTO_FAUCET_EVM_ADDR"
    return 0
  fi

  # Best-effort: the account may already be funded in genesis. This is just
  # a convenience top-up for local dev UX.
  local attempts=20
  local i
  for i in $(seq 1 "$attempts"); do
    if timeout 10s curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${FAUCET_PORT}/health" 2>/dev/null | grep -q "^200$"; then
      break
    fi
    sleep 0.5
  done

  echo "Auto faucet: requesting funds for $POLYSTORE_AUTO_FAUCET_EVM_ADDR -> $target_polystore"
  timeout 20s curl -sS -X POST "http://127.0.0.1:${FAUCET_PORT}/faucet" \
    -H "Content-Type: application/json" \
    --data "$(printf '{"address":"%s"}' "$target_polystore")" \
    >/dev/null 2>&1 || true
}

wait_for_ports_clear() {
  local rpc_port="${RPC_ADDR##*:}"
  local p2p_port="${P2P_ADDR##*:}"
  local ports=("$rpc_port" "$p2p_port" "$LCD_PORT" "$EVM_RPC_PORT" "$EVM_WS_PORT" 8080 "$FAUCET_PORT" 5173)
  local provider_count="${POLYSTORE_LOCAL_PROVIDER_COUNT:-3}"
  if [ "$provider_count" -lt 1 ]; then
    provider_count=1
  fi
  local idx
  for idx in $(seq 0 $((provider_count - 1))); do
    ports+=( $((8082 + idx)) )
  done
  local attempts=20
  local delay=0.5
  local port
  for port in "${ports[@]}"; do
    local i
    for i in $(seq 1 "$attempts"); do
      if [ -z "$(listener_pids_for_port "$port")" ]; then
        break
      fi
      sleep "$delay"
    done
  done
}

wait_for_local_gateway_health() {
  local name="$1"
  local url="$2"
  local log_file="$3"
  local attempts="${4:-20}"
  local i
  for i in $(seq 1 "$attempts"); do
    if timeout 5s curl -sS -o /dev/null -w "%{http_code}" "$url" 2>/dev/null | grep -q "^200$"; then
      echo "$name healthy at $url"
      return 0
    fi
    sleep 0.25
  done
  echo "$name failed health check at $url; check $log_file"
  tail -n 60 "$log_file" || true
  exit 1
}

ensure_polystorechaind() {
  ensure_polystore_core_shared
  banner "Building and installing polystorechaind (via $GO_BIN)"
  
  # Reconstruct vendor directory to handle partial vendoring strategy
  (
    cd "$ROOT_DIR/polystorechain"
    echo "Reconstructing vendor for polystorechain..."
    "$GO_BIN" mod vendor
    # Restore tracked vendor files (if any) to preserve patches/partial vendoring
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git checkout vendor 2>/dev/null || true
    fi
  )

  (cd "$ROOT_DIR/polystorechain" && "$GO_BIN" build -o "$ROOT_DIR/polystorechain/polystorechaind" ./cmd/polystorechaind)
  # Also install to GOPATH/bin to ensure it's in PATH for arbitrary shell calls
  (cd "$ROOT_DIR/polystorechain" && "$GO_BIN" install ./cmd/polystorechaind)
}

ensure_polystore_cli() {
  banner "Building polystore_cli (release)"
  (cd "$ROOT_DIR/polystore_cli" && cargo build --release)
}

ensure_polystore_gateway() {
  ensure_polystore_core_shared
  # Rebuild when sources changed; the stack script reuses a single binary path
  # under _artifacts/, so a simple "exists" check can lead to stale behavior.
  if [ -x "$GATEWAY_BIN" ]; then
    if ! find "$ROOT_DIR/polystore_gateway" -name '*.go' -newer "$GATEWAY_BIN" -print -quit | grep -q .; then
      return 0
    fi
  fi
  banner "Building polystore_gateway (via $GO_BIN)"
  (cd "$ROOT_DIR/polystore_gateway" && "$GO_BIN" build -o "$GATEWAY_BIN" .)
}

ensure_polystore_core_shared() {
  if [ -f "$POLYSTORE_CORE_LIB_SO" ]; then
    return 0
  fi
  banner "Building polystore_core shared library (release)"
  (
    cd "$ROOT_DIR/polystore_core"
    cargo build --release
  )
  if [ ! -f "$POLYSTORE_CORE_LIB_SO" ]; then
    echo "ERROR: polystore_core shared library missing after build: $POLYSTORE_CORE_LIB_SO" >&2
    exit 1
  fi
  export LD_LIBRARY_PATH="$POLYSTORE_CORE_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
}

register_demo_provider() {
  # Local stacks (and CI) default to 3 providers so Mode 2 auto-placement can
  # select a repair-capable profile (minMode2Slots=3).
  banner "Registering demo storage providers"
  local provider_count="${POLYSTORE_LOCAL_PROVIDER_COUNT:-3}"
  if [ "$provider_count" -lt 1 ]; then
    provider_count=1
  fi
  # Use the faucet key as a General-capability provider with a large capacity,
  # plus (provider_count-1) additional providers.
  # We retry a few times to avoid races with node startup.
  local extra_endpoints_raw="${POLYSTORE_PROVIDER_ENDPOINTS_EXTRA:-}"
  local extra_endpoints_map_raw="${POLYSTORE_PROVIDER_ENDPOINTS_EXTRA_MAP:-}"
  local -a extra_endpoints=()
  if [ -n "$extra_endpoints_raw" ]; then
    IFS=',' read -r -a extra_endpoints <<<"$extra_endpoints_raw"
  fi

  # Avoid racing polystorechaind startup: wait for RPC to come up before attempting txs.
  if command -v curl >/dev/null 2>&1; then
    local rpc_ready=0
    local rpc_tries=30
    local rpc_try
    local rpc_http="http://127.0.0.1:${RPC_ADDR##*:}"
    for rpc_try in $(seq 1 "$rpc_tries"); do
      if curl -sSf --max-time 1 "$rpc_http/status" >/dev/null 2>&1; then
        rpc_ready=1
        break
      fi
      sleep 1
    done
    if [ "$rpc_ready" != "1" ]; then
      echo "Warning: RPC not responding; provider registration may be flaky."
    fi
  fi

  local attempts=10
  local i
  for i in $(seq 1 "$attempts"); do
    local -a endpoint_args=()
    endpoint_args+=("--endpoint" "/ip4/127.0.0.1/tcp/8082/http")
    if [ "${#extra_endpoints[@]}" -gt 0 ]; then
      for ep in "${extra_endpoints[@]}"; do
        ep="$(echo "$ep" | xargs)"
        if [ -n "$ep" ]; then
          endpoint_args+=("--endpoint" "$ep")
        fi
      done
    fi
    if [ -n "$extra_endpoints_map_raw" ]; then
      local -a map_entries=()
      IFS=',' read -r -a map_entries <<<"$extra_endpoints_map_raw"
      local ent
      for ent in "${map_entries[@]}"; do
        ent="$(echo "$ent" | xargs)"
        [ -z "$ent" ] && continue
        local map_key="${ent%%=*}"
        local map_val="${ent#*=}"
        if [ "$map_val" = "$ent" ]; then
          continue
        fi
        map_key="$(echo "$map_key" | xargs)"
        map_val="$(echo "$map_val" | xargs)"
        if [ "$map_key" != "faucet" ]; then
          continue
        fi
        local -a key_eps=()
        IFS=';' read -r -a key_eps <<<"$map_val"
        local key_ep
        for key_ep in "${key_eps[@]}"; do
          key_ep="$(echo "$key_ep" | xargs)"
          if [ -n "$key_ep" ]; then
            endpoint_args+=("--endpoint" "$key_ep")
          fi
        done
      done
    fi

    "$POLYSTORECHAIND_BIN" tx polystorechain register-provider General 1099511627776 \
      --from faucet \
      "${endpoint_args[@]}" \
      --chain-id "$CHAIN_ID" \
      --node "$RPC_ADDR" \
      --yes \
      --home "$CHAIN_HOME" \
      --keyring-backend test \
      --gas-prices "$GAS_PRICE" >/dev/null 2>&1 || true

    # Register additional provider identities for Mode 2 stripes.
    # provider1..provider{provider_count-1}
    if [ "$provider_count" -gt 1 ]; then
      local idx
      for idx in $(seq 1 $((provider_count - 1))); do
        local key_name="provider${idx}"
        if ! "$POLYSTORECHAIND_BIN" keys show "$key_name" --home "$CHAIN_HOME" --keyring-backend test >/dev/null 2>&1; then
          echo "Warning: missing key $key_name in local keyring; skipping provider registration for this key."
          continue
        fi
        local addr
        addr=$("$POLYSTORECHAIND_BIN" keys show "$key_name" -a --home "$CHAIN_HOME" --keyring-backend test 2>/dev/null || true)
        if [ -n "$addr" ]; then
          local port=$((8082 + idx))
          local -a endpoint_args_child=()
          endpoint_args_child+=("--endpoint" "/ip4/127.0.0.1/tcp/${port}/http")
          if [ "${#extra_endpoints[@]}" -gt 0 ]; then
            for ep in "${extra_endpoints[@]}"; do
              ep="$(echo "$ep" | xargs)"
              if [ -n "$ep" ]; then
                endpoint_args_child+=("--endpoint" "$ep")
              fi
            done
          fi
          if [ -n "$extra_endpoints_map_raw" ]; then
            local -a map_entries_child=()
            IFS=',' read -r -a map_entries_child <<<"$extra_endpoints_map_raw"
            local ent_child
            for ent_child in "${map_entries_child[@]}"; do
              ent_child="$(echo "$ent_child" | xargs)"
              [ -z "$ent_child" ] && continue
              local map_key_child="${ent_child%%=*}"
              local map_val_child="${ent_child#*=}"
              if [ "$map_val_child" = "$ent_child" ]; then
                continue
              fi
              map_key_child="$(echo "$map_key_child" | xargs)"
              map_val_child="$(echo "$map_val_child" | xargs)"
              if [ "$map_key_child" != "$key_name" ]; then
                continue
              fi
              local -a key_eps_child=()
              IFS=';' read -r -a key_eps_child <<<"$map_val_child"
              local key_ep_child
              for key_ep_child in "${key_eps_child[@]}"; do
                key_ep_child="$(echo "$key_ep_child" | xargs)"
                if [ -n "$key_ep_child" ]; then
                  endpoint_args_child+=("--endpoint" "$key_ep_child")
                fi
              done
            done
          fi

          "$POLYSTORECHAIND_BIN" tx polystorechain register-provider General 1099511627776 \
            --from "$key_name" \
            "${endpoint_args_child[@]}" \
            --chain-id "$CHAIN_ID" \
            --node "$RPC_ADDR" \
            --yes \
            --home "$CHAIN_HOME" \
            --keyring-backend test \
            --gas-prices "$GAS_PRICE" >/dev/null 2>&1 || true
        fi
      done
    fi

    # Check if we have enough providers for Mode 2 placement.
    local count
    count=$("$POLYSTORECHAIND_BIN" query polystorechain list-providers --node "$RPC_ADDR" --home "$CHAIN_HOME" 2>/dev/null | grep -c "address:" || true)
    if [ "$count" -ge "$provider_count" ]; then
      echo "Demo providers registered successfully ($count provider(s))."
      return 0
    fi

    echo "Demo providers not yet registered ($count/$provider_count) (attempt $i/$attempts); retrying in 4s..."
    sleep 4
  done

  echo "Warning: demo provider registration failed after $attempts attempts (see polystorechaind logs)"
}

init_chain() {
  wipe_chain_home_if_safe
  banner "Initializing chain at $CHAIN_HOME"
  "$POLYSTORECHAIND_BIN" init local --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

  # Import faucet key (deterministic for local use)
  printf '%s\n' "$FAUCET_MNEMONIC" | "$POLYSTORECHAIND_BIN" keys add faucet --home "$CHAIN_HOME" --keyring-backend test --recover --output json >/dev/null

  # Pre-create and pre-fund provider keys in genesis for deterministic local
  # Mode 2 availability (avoids runtime funding/sequence races).
  local provider_count="${POLYSTORE_LOCAL_PROVIDER_COUNT:-3}"
  if [ "$provider_count" -lt 1 ]; then
    provider_count=1
  fi
  if [ "$provider_count" -gt 1 ]; then
    local idx
    for idx in $(seq 1 $((provider_count - 1))); do
      local key_name="provider${idx}"
      "$POLYSTORECHAIND_BIN" keys add "$key_name" --home "$CHAIN_HOME" --keyring-backend test --output json >/dev/null 2>&1 || true
      local addr
      addr=$("$POLYSTORECHAIND_BIN" keys show "$key_name" -a --home "$CHAIN_HOME" --keyring-backend test 2>/dev/null || true)
      if [ -n "$addr" ]; then
        "$POLYSTORECHAIND_BIN" genesis add-genesis-account "$addr" "$POLYSTORE_AMOUNT" --home "$CHAIN_HOME" --keyring-backend test >/dev/null 2>&1 || true
      fi
    done
  fi

  # Fund faucet + create validator
  "$POLYSTORECHAIND_BIN" genesis add-genesis-account faucet "100000000000$DENOM,1000000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  # Pre-fund the EVM dev account (derived from the local Foundry mnemonic) so
  # that MsgCreateDealFromEvm / PolyStoreBridge deployments have gas without relying
  # on the faucet timing. This address is the bech32 mapping of the default
  # Foundry EVM deployer (0x4dd2C8c449581466Df3F62b007A24398DD858f5d).
  "$POLYSTORECHAIND_BIN" genesis add-genesis-account nil1fhfv33zftq2xdhelv2cq0gjrnrwctr6ag75ey4 "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test
  # Pre-fund additional EVM demo account (0xf7931ff7fc55d19ef4a8139fa7e4b3f06e03f2e2).
  "$POLYSTORECHAIND_BIN" genesis add-genesis-account nil177f3lalu2hgeaa9gzw060e9n7phq8uhzpfks5m "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test

  # Also pre-fund EVM signer accounts used by gateway/e2e/bridge deployment.
  # This avoids relying on the faucet, which uses polystorechaind CLI txs that can hang on some setups.
  if command -v python3 >/dev/null 2>&1; then
    local signer_nil_addrs
    signer_nil_addrs=$(python3 - <<'PY' 2>/dev/null || true
from eth_account import Account
import bech32, os

keys = []
keys.append(os.environ.get("EVM_PRIVKEY", "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1"))
alt = os.environ.get("POLYSTORE_EVM_DEV_PRIVKEY", "").strip()
if alt:
    keys.append(alt)

seen = set()
for priv in keys:
    try:
        acct = Account.from_key(priv)
        data = bytes.fromhex(acct.address[2:])
        five = bech32.convertbits(data, 8, 5)
        addr = bech32.bech32_encode("nil", five)
        if addr and addr not in seen:
            seen.add(addr)
            print(addr)
    except Exception:
        pass
PY
    )
    if [ -n "$signer_nil_addrs" ]; then
      while IFS= read -r signer_polystore_addr; do
        [ -z "$signer_polystore_addr" ] && continue
        if "$POLYSTORECHAIND_BIN" genesis add-genesis-account "$signer_polystore_addr" "1000000$DENOM,1000000000000000000aatom" --home "$CHAIN_HOME" --keyring-backend test >/dev/null 2>&1; then
          echo "Pre-funded EVM signer account $signer_polystore_addr"
        fi
      done <<< "$signer_nil_addrs"
    fi
  fi
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
    # Safer local dev defaults: keep LCD + JSON-RPC local-only. Set POLYSTORE_BIND_ALL=1 to override.
    perl -pi -e "s|^address *= *\"0\\\\.0\\\\.0\\\\.0:[0-9]+\"|address = \"127.0.0.1:$EVM_RPC_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^ws-address *= *\"0\\\\.0\\\\.0\\\\.0:[0-9]+\"|ws-address = \"127.0.0.1:$EVM_WS_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^address *= *\"tcp://0\\\\.0\\\\.0\\\\.0:[0-9]+\"|address = \"tcp://127.0.0.1:$LCD_PORT\"|" "$APP_TOML"
    perl -pi -e "s|^address *= *\"tcp://localhost:[0-9]+\"|address = \"tcp://127.0.0.1:$LCD_PORT\"|" "$APP_TOML"
  fi
  perl -pi -e 's/^enabled-unsafe-cors *= *false/enabled-unsafe-cors = true/' "$APP_TOML"
  perl -pi -e "s/^evm-chain-id *= *[0-9]+/evm-chain-id = $EVM_CHAIN_ID/" "$APP_TOML"
  # Fallback patcher in case formats change (pure string replace to avoid extra deps)
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
lines = txt.splitlines()
section = ""
for idx, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped
        continue
    if section == "[api]" and stripped.startswith("address ="):
        lines[idx] = f'address = "tcp://{bind_host}:{lcd_port}"'
    elif section == "[json-rpc]" and stripped.startswith("address ="):
        lines[idx] = f'address = "{bind_host}:{evm_rpc_port}"'
    elif section == "[json-rpc]" and stripped.startswith("ws-address ="):
        lines[idx] = f'ws-address = "{bind_host}:{evm_ws_port}"'
path.write_text("\n".join(lines) + "\n")
PY
  if [ "$POLYSTORE_DISABLE_EVM_MEMPOOL" = "1" ]; then
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
import json, os, sys
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

# Keep polystorechain EIP-712 domain chain id aligned with the local EVM chain id.
polystorechain = data.get("app_state", {}).get("polystorechain", {})
if isinstance(polystorechain, dict):
    nparams = polystorechain.get("params", {})
    raw = (os.getenv("EVM_CHAIN_ID") or "").strip()
    if raw.isdigit():
        nparams["eip712_chain_id"] = raw
    polystorechain["params"] = nparams
    data["app_state"]["polystorechain"] = polystorechain

json.dump(data, open(path, "w"), indent=1)
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
    # service on a developer machine. gRPC is not required for browser/gateway flows.
    grpc_flags+=(--grpc.enable=false --grpc-web.enable=false)
  fi
  local json_rpc_addr="127.0.0.1:${EVM_RPC_PORT}"
  local json_rpc_ws_addr="127.0.0.1:${EVM_WS_PORT}"
  if [ "$POLYSTORE_BIND_ALL" = "1" ]; then
    json_rpc_addr="0.0.0.0:${EVM_RPC_PORT}"
    json_rpc_ws_addr="0.0.0.0:${EVM_WS_PORT}"
  fi
  nohup env POLYSTORE_DISABLE_EVM_MEMPOOL="$POLYSTORE_DISABLE_EVM_MEMPOOL" \
    "$POLYSTORECHAIND_BIN" start \
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
  echo $! > "$PID_DIR/polystorechaind.pid"
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
    nohup env POLYSTORE_CHAIN_ID="$CHAIN_ID" POLYSTORE_HOME="$CHAIN_HOME" POLYSTORE_NODE="$RPC_ADDR" POLYSTORE_DENOM="$DENOM" POLYSTORE_AMOUNT="$POLYSTORE_AMOUNT" POLYSTORE_GAS_PRICES="$GAS_PRICE" POLYSTORE_LISTEN_ADDR="127.0.0.1:${FAUCET_PORT}" \
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
  banner "Starting SP gateway service(s) (ports starting at 8082)"
  ensure_polystore_cli
  ensure_polystore_gateway
  local provider_count="${POLYSTORE_LOCAL_PROVIDER_COUNT:-6}"
  if [ "$provider_count" -lt 1 ]; then
    provider_count=1
  fi

  local p2p_enabled="${POLYSTORE_P2P_ENABLED_SP:-1}"
  local p2p_base_port="${POLYSTORE_P2P_LISTEN_PORT_BASE_SP:-9102}"
  local p2p_identity_dir="${POLYSTORE_P2P_IDENTITY_DIR_SP:-}"

  local idx
  for idx in $(seq 0 $((provider_count - 1))); do
    local key_name="faucet"
    local pid_name="gateway_sp"
    local log_name="gateway_sp.log"
    if [ "$idx" -gt 0 ]; then
      key_name="provider${idx}"
      pid_name="gateway_sp_${key_name}"
      log_name="gateway_sp_${key_name}.log"
    fi

    local port=$((8082 + idx))
    local p2p_listen_addrs="${POLYSTORE_P2P_LISTEN_ADDRS_SP:-/ip4/127.0.0.1/tcp/9102/ws}"
    local p2p_identity_path="${POLYSTORE_P2P_IDENTITY_PATH_SP:-}"
    if [ "$provider_count" -gt 1 ]; then
      p2p_listen_addrs="/ip4/127.0.0.1/tcp/$((p2p_base_port + idx))/ws"
      if [ -n "$p2p_identity_dir" ]; then
        p2p_identity_path="$p2p_identity_dir/${key_name}.key"
      elif [ "$idx" -gt 0 ]; then
        # Avoid reusing faucet identity for other providers unless explicitly configured.
        p2p_identity_path=""
      fi
    fi

    (
      cd "$ROOT_DIR/polystore_gateway"
      # SP Mode (default). Each instance listens on its own port but can share the upload dir.
      nohup env POLYSTORE_CHAIN_ID="$CHAIN_ID" POLYSTORE_HOME="$CHAIN_HOME" POLYSTORE_NODE="$RPC_ADDR" POLYSTORE_LCD_BASE="http://127.0.0.1:$LCD_PORT" POLYSTORE_UPLOAD_DIR="$LOG_DIR/uploads_sp" \
        POLYSTORE_RUNTIME_PERSONA="provider-daemon" \
        POLYSTORE_SESSION_DB_PATH="$LOG_DIR/sessions_sp_${key_name}.db" \
        POLYSTORE_PROVIDER_KEY="$key_name" \
        POLYSTORE_LISTEN_ADDR=":${port}" POLYSTORE_GATEWAY_ROUTER="0" POLYSTORE_GATEWAY_ROUTER_MODE="0" \
      POLYSTORE_REQUIRE_ONCHAIN_SESSION="${POLYSTORE_REQUIRE_ONCHAIN_SESSION:-0}" \
      POLYSTORE_ENABLE_TX_RELAY="${POLYSTORE_ENABLE_TX_RELAY:-1}" \
      POLYSTORE_P2P_ENABLED="$p2p_enabled" \
      POLYSTORE_P2P_LISTEN_ADDRS="$p2p_listen_addrs" \
      POLYSTORE_P2P_IDENTITY_PATH="$p2p_identity_path" \
      POLYSTORE_P2P_IDENTITY_B64="${POLYSTORE_P2P_IDENTITY_B64_SP:-}" \
      POLYSTORE_P2P_RELAY_ADDRS="${POLYSTORE_P2P_RELAY_ADDRS_SP:-}" \
      POLYSTORE_P2P_ANNOUNCE_ADDRS="${POLYSTORE_P2P_ANNOUNCE_ADDRS_SP:-}" \
      POLYSTORE_GATEWAY_SP_AUTH="$POLYSTORE_GATEWAY_SP_AUTH" \
        POLYSTORE_CLI_BIN="$ROOT_DIR/polystore_cli/target/release/polystore_cli" POLYSTORE_TRUSTED_SETUP="$ROOT_DIR/polystorechain/trusted_setup.txt" \
        POLYSTORECHAIND_BIN="$POLYSTORECHAIND_BIN" POLYSTORE_CMD_TIMEOUT_SECONDS="240" \
        "$GATEWAY_BIN" \
        >"$LOG_DIR/$log_name" 2>&1 &
      echo $! > "$PID_DIR/$pid_name.pid"
    )
    sleep 0.5
    if ! kill -0 "$(cat "$PID_DIR/$pid_name.pid")" 2>/dev/null; then
      echo "SP gateway ($key_name) failed to start; check $LOG_DIR/$log_name"
      tail -n 40 "$LOG_DIR/$log_name" || true
      exit 1
    fi
    echo "SP gateway ($key_name) pid $(cat "$PID_DIR/$pid_name.pid"), port $port, logs: $LOG_DIR/$log_name"
    wait_for_local_gateway_health "SP gateway ($key_name)" "http://127.0.0.1:${port}/health" "$LOG_DIR/$log_name" 20
  done
}

start_user_gateway() {
  if [ "${POLYSTORE_DISABLE_GATEWAY:-0}" = "1" ]; then
    echo "Skipping User Gateway (POLYSTORE_DISABLE_GATEWAY=1)"
    return
  fi
  if [ "${POLYSTORE_START_USER_GATEWAY:-1}" != "1" ]; then
    echo "Skipping User Gateway (POLYSTORE_START_USER_GATEWAY=0)"
    return
  fi

  banner "Starting User gateway service (Port 8080)"
  ensure_polystore_cli
  ensure_polystore_gateway
  local user_gateway_proxy_mode="$POLYSTORE_USER_GATEWAY_PROXY_MODE"
  if [ "$user_gateway_proxy_mode" != "1" ]; then
    user_gateway_proxy_mode="0"
  fi
  local user_p2p_enabled="${POLYSTORE_P2P_ENABLED:-1}"
  local user_p2p_listen="${POLYSTORE_P2P_LISTEN_ADDRS:-/ip4/127.0.0.1/tcp/9100/ws}"
  if [ "$user_p2p_enabled" = "1" ] && echo "$user_p2p_listen" | grep -q '/tcp/9100/'; then
    if ss -ltn '( sport = :9100 )' 2>/dev/null | tail -n +2 | grep -q .; then
      user_p2p_listen="${user_p2p_listen//\/tcp\/9100\//\/tcp\/19100\/}"
      echo "User gateway p2p port 9100 already in use; using fallback $user_p2p_listen"
    fi
  fi
  (
    cd "$ROOT_DIR/polystore_gateway"
    # user-gateway persona on :8080.
    # Default is standalone mode (local slab/cache + orchestration).
    # Set POLYSTORE_USER_GATEWAY_PROXY_MODE=1 for legacy proxy/router compatibility.
    nohup env POLYSTORE_CHAIN_ID="$CHAIN_ID" POLYSTORE_HOME="$CHAIN_HOME" POLYSTORE_NODE="$RPC_ADDR" POLYSTORE_LCD_BASE="http://127.0.0.1:$LCD_PORT" POLYSTORE_UPLOAD_DIR="$LOG_DIR/uploads_user" \
      POLYSTORE_RUNTIME_PERSONA="user-gateway" \
      POLYSTORE_LISTEN_ADDR=":8080" \
      POLYSTORE_GATEWAY_ROUTER="$user_gateway_proxy_mode" POLYSTORE_GATEWAY_ROUTER_MODE="$user_gateway_proxy_mode" \
    POLYSTORE_REQUIRE_ONCHAIN_SESSION="${POLYSTORE_REQUIRE_ONCHAIN_SESSION:-0}" \
    POLYSTORE_ENABLE_TX_RELAY="${POLYSTORE_ENABLE_TX_RELAY:-1}" \
    POLYSTORE_P2P_ENABLED="$user_p2p_enabled" \
    POLYSTORE_P2P_LISTEN_ADDRS="$user_p2p_listen" \
    POLYSTORE_P2P_IDENTITY_PATH="${POLYSTORE_P2P_IDENTITY_PATH:-}" \
    POLYSTORE_P2P_IDENTITY_B64="${POLYSTORE_P2P_IDENTITY_B64:-}" \
    POLYSTORE_P2P_RELAY_ADDRS="${POLYSTORE_P2P_RELAY_ADDRS:-}" \
    POLYSTORE_P2P_ANNOUNCE_ADDRS="${POLYSTORE_P2P_ANNOUNCE_ADDRS:-}" \
    POLYSTORE_GATEWAY_SP_AUTH="$POLYSTORE_GATEWAY_SP_AUTH" \
      POLYSTORE_CLI_BIN="$ROOT_DIR/polystore_cli/target/release/polystore_cli" POLYSTORE_TRUSTED_SETUP="$ROOT_DIR/polystorechain/trusted_setup.txt" \
      POLYSTORECHAIND_BIN="$POLYSTORECHAIND_BIN" POLYSTORE_CMD_TIMEOUT_SECONDS="240" \
      "$GATEWAY_BIN" \
      >"$LOG_DIR/gateway_user.log" 2>&1 &
    echo $! > "$PID_DIR/gateway_user.pid"
  )
  sleep 0.5
  if ! kill -0 "$(cat "$PID_DIR/gateway_user.pid")" 2>/dev/null; then
    echo "User gateway failed to start; check $LOG_DIR/gateway_user.log"
    tail -n 20 "$LOG_DIR/gateway_user.log" || true
    exit 1
  fi
  local mode_label="standalone"
  if [ "$user_gateway_proxy_mode" = "1" ]; then
    mode_label="proxy"
  fi
  echo "User gateway pid $(cat "$PID_DIR/gateway_user.pid"), mode=$mode_label, logs: $LOG_DIR/gateway_user.log"
  wait_for_local_gateway_health "User gateway" "http://127.0.0.1:8080/health" "$LOG_DIR/gateway_user.log" 20
}

start_bridge() {
  local mode="${POLYSTORE_DEPLOY_BRIDGE:-1}"
  if [ "$mode" = "0" ]; then
    echo "Skipping bridge deployment (POLYSTORE_DEPLOY_BRIDGE=0)"
    BRIDGE_STATUS="skipped (POLYSTORE_DEPLOY_BRIDGE=0)"
    return
  fi
  if ! command -v forge >/dev/null 2>&1 || ! command -v cast >/dev/null 2>&1; then
    echo "Foundry tools not found; skipping PolyStoreBridge deployment. Install forge/cast or set POLYSTORE_DEPLOY_BRIDGE=0."
    BRIDGE_STATUS="skipped (forge/cast not found)"
    return
  fi

  # Avoid accidentally reusing a stale address from a previous chain reset.
  rm -f "$BRIDGE_ADDR_FILE"

  banner "Waiting for EVM RPC ($EVM_RPC_PORT)..."
  local attempts=30
  local i
  local ready=0
  for i in $(seq 1 "$attempts"); do
    if timeout 10s curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$EVM_RPC_PORT" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' -H "Content-Type: application/json" >/dev/null; then
      echo "EVM RPC is ready."
      ready=1
      break
    fi
    echo "EVM RPC not ready (attempt $i/$attempts); sleeping 1s..."
    sleep 1
  done
  if [ "$ready" != "1" ]; then
    echo "EVM RPC never became ready; skipping PolyStoreBridge deployment."
    BRIDGE_STATUS="failed (EVM RPC not ready)"
    return
  fi

  banner "Deploying PolyStoreBridge to local EVM"
  if env -u PRIVATE_KEY EVM_PRIVKEY= POLYSTORE_EVM_DEV_PRIVKEY="$POLYSTORE_EVM_DEV_PRIVKEY" "$ROOT_DIR/scripts/deploy_bridge_local.sh" >/tmp/bridge_deploy.log 2>&1; then
    if [ -f "$BRIDGE_ADDR_FILE" ]; then
      BRIDGE_ADDRESS="$(cat "$BRIDGE_ADDR_FILE" | tr -d '\n' | tr -d '\r')"
      echo "PolyStoreBridge deployed at $BRIDGE_ADDRESS (exported to VITE_BRIDGE_ADDRESS for the web UI)"
      BRIDGE_STATUS="$BRIDGE_ADDRESS"
    else
      echo "Bridge deploy script completed but address file missing; check /tmp/bridge_deploy.log"
      BRIDGE_STATUS="failed (missing address file; see /tmp/bridge_deploy.log)"
    fi
  else
    echo "Bridge deploy script failed; see /tmp/bridge_deploy.log. Continuing without bridge."
    echo "To retry later: ./scripts/deploy_bridge_local.sh"
    echo "To skip next time: POLYSTORE_DEPLOY_BRIDGE=0 ./scripts/ensure_stack_local.sh"
    BRIDGE_STATUS="failed (see /tmp/bridge_deploy.log)"
  fi
}

start_web() {
  if [ "${POLYSTORE_START_WEB}" != "1" ]; then
    echo "Skipping web UI (POLYSTORE_START_WEB=0)"
    return
  fi
  banner "Starting web (Vite dev server)"
  (
    cd "$ROOT_DIR/polystore-website"
    if [ ! -d node_modules ]; then npm install >/dev/null; fi
    VITE_BRIDGE_ADDRESS="${BRIDGE_ADDRESS:-${VITE_BRIDGE_ADDRESS:-}}" \
    VITE_API_BASE="${VITE_API_BASE:-http://localhost:${FAUCET_PORT}}" \
    VITE_LCD_BASE="${VITE_LCD_BASE:-http://localhost:${LCD_PORT}}" \
    VITE_EVM_RPC="${VITE_EVM_RPC:-http://localhost:${EVM_RPC_PORT}}" \
    VITE_SP_BASE="${VITE_SP_BASE:-http://localhost:8082}" \
    VITE_COSMOS_CHAIN_ID="$CHAIN_ID" \
    VITE_CHAIN_ID="$EVM_CHAIN_ID" \
    VITE_ENABLE_FAUCET="${VITE_ENABLE_FAUCET:-${POLYSTORE_START_FAUCET:-0}}" \
    VITE_POLYSTORE_PRECOMPILE="${VITE_POLYSTORE_PRECOMPILE:-0x0000000000000000000000000000000000000900}" \
    nohup npm run dev -- --host 0.0.0.0 --port 5173 >"$LOG_DIR/website.log" 2>&1 &
    echo $! > "$PID_DIR/website.pid"
  )
  echo "web pid $(cat "$PID_DIR/website.pid"), logs: $LOG_DIR/website.log"
}

restart_gateway() {
  banner "Restarting gateway services (user + SP)"
  restart_gateway_sp
  restart_gateway_user
}

stop_user_gateway_only() {
  local pid_file="$PID_DIR/gateway_user.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      echo "Stopped gateway_user (pid $pid)"
    fi
    rm -f "$pid_file"
  fi

  local gw_pids gw_pids2
  gw_pids=$(listener_pids_for_port 8080)
  if [ -n "$gw_pids" ]; then
    kill $gw_pids 2>/dev/null || true
    sleep 0.5
    gw_pids2=$(listener_pids_for_port 8080)
    if [ -n "$gw_pids2" ]; then
      kill -9 $gw_pids2 2>/dev/null || true
    fi
  fi
}

stop_sp_gateway_only() {
  local pid_file pid
  pid_file="$PID_DIR/gateway_sp.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      echo "Stopped gateway_sp (pid $pid)"
    fi
    rm -f "$pid_file"
  fi

  for pid_file in "$PID_DIR"/gateway_sp_*.pid; do
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file" 2>/dev/null || true)
      if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 0.5
        if kill -0 "$pid" 2>/dev/null; then
          kill -9 "$pid" 2>/dev/null || true
        fi
        echo "Stopped $(basename "$pid_file") (pid $pid)"
      fi
      rm -f "$pid_file"
    fi
  done

  local provider_count="${POLYSTORE_LOCAL_PROVIDER_COUNT:-3}"
  if [ "$provider_count" -lt 1 ]; then
    provider_count=1
  fi

  local idx port gw_pids gw_pids2
  for idx in $(seq 0 $((provider_count - 1))); do
    port=$((8082 + idx))
    gw_pids=$(listener_pids_for_port "$port")
    if [ -n "$gw_pids" ]; then
      kill $gw_pids 2>/dev/null || true
      sleep 0.5
      gw_pids2=$(listener_pids_for_port "$port")
      if [ -n "$gw_pids2" ]; then
        kill -9 $gw_pids2 2>/dev/null || true
      fi
    fi
  done
}

restart_gateway_sp() {
  banner "Restarting SP gateway services"
  stop_sp_gateway_only
  start_sp_gateway
}

restart_gateway_user() {
  banner "Restarting User gateway service"
  stop_user_gateway_only
  start_user_gateway
}

stop_gateway_sp() {
  banner "Stopping SP gateway services"
  stop_sp_gateway_only
}

stop_gateway_user() {
  banner "Stopping User gateway service"
  stop_user_gateway_only
}

start_all() {
  stop_all
  rm -rf "$LOG_DIR/uploads_sp" "$LOG_DIR/uploads_user"
  ensure_polystore_core
  ensure_polystorechaind
  init_chain
  start_chain
  register_demo_provider
  if [ "${POLYSTORE_START_FAUCET}" = "1" ]; then
    start_faucet
    auto_faucet_request
  else
    echo "Skipping faucet (POLYSTORE_START_FAUCET=0)"
  fi
  start_sp_gateway
  start_user_gateway
  start_bridge
  start_web
  banner "Stack ready"
  cat <<EOF
RPC:         http://localhost:${RPC_ADDR##*:}
REST/LCD:    http://localhost:$LCD_PORT
EVM RPC:     http://localhost:$EVM_RPC_PORT  (polystorechaind, Cosmos Chain ID $CHAIN_ID / EVM Chain ID $EVM_CHAIN_ID)
Faucet:      http://localhost:${FAUCET_PORT}/faucet
SP Gateways: http://localhost:8082.. (Uploads to $LOG_DIR/uploads_sp)
User Gateway: http://localhost:8080 (Uploads to $LOG_DIR/uploads_user)
Web UI:      http://localhost:5173/#/dashboard
	Bridge:      ${BRIDGE_ADDRESS:-$BRIDGE_STATUS}
	Home:        $CHAIN_HOME
	Re-init:     To wipe a non-_artifacts Home, set POLYSTORE_REINIT_HOME=1
	To stop:     ./scripts/run_local_stack.sh stop
EOF
}

stop_all() {
  banner "Stopping processes"
  for svc in polystorechaind faucet gateway_sp gateway_user website; do
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

  # Stop additional SP gateway instances (gateway_sp_providerN).
  for pid_file in "$PID_DIR"/gateway_sp_*.pid; do
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file" 2>/dev/null || true)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo "Stopped $(basename "$pid_file") (pid $pid)"
      fi
      rm -f "$pid_file"
    fi
  done

  local provider_count="${POLYSTORE_LOCAL_PROVIDER_COUNT:-3}"
  if [ "$provider_count" -lt 1 ]; then
    provider_count=1
  fi

  for port in "${RPC_ADDR##*:}" "${P2P_ADDR##*:}" "$LCD_PORT" "$EVM_RPC_PORT" "$EVM_WS_PORT" 8080 "$FAUCET_PORT" 5173; do
    pids=$(listener_pids_for_port "$port")
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      sleep 0.5
      # If still alive, force kill.
      pids2=$(listener_pids_for_port "$port")
      if [ -n "$pids2" ]; then
        kill -9 $pids2 2>/dev/null || true
        echo "Force killed processes on port $port ($pids2)"
      else
        echo "Cleared processes on port $port ($pids)"
      fi
    fi
  done

  # Clear SP gateway ports.
  local idx
  for idx in $(seq 0 $((provider_count - 1))); do
    port=$((8082 + idx))
    pids=$(listener_pids_for_port "$port")
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      sleep 0.5
      pids2=$(listener_pids_for_port "$port")
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
  stop-gateway-sp) stop_gateway_sp ;;
  stop-gateway-user) stop_gateway_user ;;
  restart-gateway-sp) restart_gateway_sp ;;
  restart-gateway-user) restart_gateway_user ;;
  restart-gateway) restart_gateway ;;
  *)
    echo "Usage: $0 [start|stop|stop-gateway-sp|stop-gateway-user|restart-gateway|restart-gateway-sp|restart-gateway-user]"
    exit 1
    ;;
esac
