#!/usr/bin/env bash
set -euo pipefail

# End-to-End Elasticity Test
# Usage: ./e2e_elasticity.sh

BINARY="./polystorechaind"
CHAIN_ID="polystorechain"
HOME_DIR="./.polystorechain_elasticity"
MDU_FILE="./test_elasticity.dat"
TRUSTED_SETUP="$(pwd)/polystorechain/trusted_setup.txt"
RPC_PORT="${POLYSTORE_ELASTICITY_RPC_PORT:-27657}"
P2P_PORT="${POLYSTORE_ELASTICITY_P2P_PORT:-27656}"
PROXY_PORT="${POLYSTORE_ELASTICITY_PROXY_PORT:-27658}"
GRPC_PORT="${POLYSTORE_ELASTICITY_GRPC_PORT:-9190}"
LCD_PORT="${POLYSTORE_ELASTICITY_LCD_PORT:-1417}"
NODE_ADDR="tcp://127.0.0.1:${RPC_PORT}"
LCD_BASE="http://127.0.0.1:${LCD_PORT}"
PID=""

cleanup() {
    if [ -n "${PID:-}" ]; then
        kill "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
    rm -rf "$HOME_DIR"
    rm -f "$MDU_FILE"
}
trap cleanup EXIT

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: missing required command: $1" >&2
        exit 1
    fi
}

query_tx_code() {
    local tx_hash="$1"
    local tx_json
    tx_json=$("$BINARY" q tx "$tx_hash" --node "$NODE_ADDR" --home "$HOME_DIR" -o json)
    echo "$tx_json" | jq -r '.code // 0'
}

submit_signal_saturation() {
    local from_key="$1"
    local response
    response=$("$BINARY" tx nilchain signal-saturation 0 \
        --from "$from_key" \
        --chain-id "$CHAIN_ID" \
        --yes \
        --home "$HOME_DIR" \
        --keyring-backend test \
        --node "$NODE_ADDR" \
        --broadcast-mode sync \
        --output json)
    echo "$response" | jq -r '.txhash'
}

provider_capability() {
    local provider="$1"
    timeout 10s curl -sS --max-time 3 "$LCD_BASE/polystorechain/polystorechain/v1/providers/$provider" \
      | jq -r '.provider.capabilities // ""'
}

assert_virtual_stripe_edge_only() {
    local stripe_index="$1"
    local expected_count="$2"
    local stripe_json providers_len

    stripe_json=$(timeout 10s curl -sS --max-time 3 "$LCD_BASE/polystorechain/polystorechain/v1/deals/0/virtual-stripes/$stripe_index")
    providers_len=$(echo "$stripe_json" | jq -r '.stripe.overlay_providers | length')
    if [ "$providers_len" != "$expected_count" ]; then
        echo "FAILURE: virtual stripe $stripe_index has $providers_len providers (expected $expected_count)." >&2
        echo "$stripe_json" >&2
        exit 1
    fi

    while IFS= read -r provider; do
        [ -n "$provider" ] || continue
        cap=$(provider_capability "$provider")
        if [ "$cap" != "Edge" ]; then
            echo "FAILURE: virtual stripe $stripe_index provider $provider has capability $cap (expected Edge)." >&2
            echo "$stripe_json" >&2
            exit 1
        fi
    done < <(echo "$stripe_json" | jq -r '.stripe.overlay_providers[]')

    echo "SUCCESS: virtual stripe $stripe_index is queryable and Edge-only ($providers_len providers)."
}

assert_virtual_stripe_count() {
    local expected="$1"
    local list_json count
    list_json=$(timeout 10s curl -sS --max-time 3 "$LCD_BASE/polystorechain/polystorechain/v1/deals/0/virtual-stripes")
    count=$(echo "$list_json" | jq -r '.stripes | length')
    if [ "$count" != "$expected" ]; then
        echo "FAILURE: virtual stripe list has $count entries (expected $expected)." >&2
        echo "$list_json" >&2
        exit 1
    fi
}

require_cmd curl
require_cmd jq
require_cmd python3

# Ensure binaries are built
echo ">>> Building binaries..."
cd polystorechain && go build -o ../polystorechaind ./cmd/polystorechaind && cd ..

# Clean start
echo ">>> Resetting chain..."
pkill -f "$HOME_DIR" || true
rm -rf "$HOME_DIR"
"$BINARY" init mynode --chain-id "$CHAIN_ID" --home "$HOME_DIR" > /dev/null 2>&1
"$BINARY" config set client chain-id "$CHAIN_ID" --home "$HOME_DIR"
"$BINARY" config set client keyring-backend test --home "$HOME_DIR"

# Create accounts
echo ">>> Creating accounts..."
"$BINARY" keys add user --home "$HOME_DIR" --keyring-backend test > /dev/null 2>&1
# We need enough providers for 2 stripes (12 * 2 = 24 providers)
for i in {1..24}
do
   "$BINARY" keys add "provider$i" --home "$HOME_DIR" --keyring-backend test > /dev/null 2>&1
done

USER_ADDR=$("$BINARY" keys show user -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)

# Add genesis accounts
"$BINARY" genesis add-genesis-account "$USER_ADDR" 100000000000token,200000000stake --home "$HOME_DIR"
for i in {1..24}
do
   PROV_ADDR=$("$BINARY" keys show "provider$i" -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
   "$BINARY" genesis add-genesis-account "$PROV_ADDR" 1000000000token,1000000stake --home "$HOME_DIR"
done

"$BINARY" genesis gentx user 100000000stake --chain-id "$CHAIN_ID" --home "$HOME_DIR" --keyring-backend test > /dev/null 2>&1
"$BINARY" genesis collect-gentxs --home "$HOME_DIR" > /dev/null 2>&1

# Inject aatom denom metadata required by the EVM module (local genesis helpers
# in older scripts may omit this, causing polystorechaind to panic on start).
python3 - "$HOME_DIR/config/genesis.json" <<'PY' || true
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
bank["denom_metadata"] = md
data["app_state"]["bank"] = bank
json.dump(data, open(path, "w"), indent=1)
PY

# Config: Fast blocks
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' "$HOME_DIR/config/config.toml"
sed -i.bak 's/minimum-gas-prices = ""/minimum-gas-prices = "0token"/' "$HOME_DIR/config/app.toml"
python3 - "$HOME_DIR/config/config.toml" "$HOME_DIR/config/app.toml" "$RPC_PORT" "$P2P_PORT" "$PROXY_PORT" "$GRPC_PORT" "$LCD_PORT" <<'PY'
from pathlib import Path
import sys

config_path = Path(sys.argv[1])
app_path = Path(sys.argv[2])
rpc_port, p2p_port, proxy_port, grpc_port, lcd_port = sys.argv[3:8]

lines = config_path.read_text().splitlines()
section = ""
out = []
for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped.strip("[]")
    if stripped.startswith("proxy_app = "):
        line = f'proxy_app = "tcp://127.0.0.1:{proxy_port}"'
    elif section == "rpc" and stripped.startswith("laddr = "):
        line = f'laddr = "tcp://127.0.0.1:{rpc_port}"'
    elif section == "p2p" and stripped.startswith("laddr = "):
        line = f'laddr = "tcp://127.0.0.1:{p2p_port}"'
    out.append(line)
config_path.write_text("\n".join(out) + "\n")

path = app_path
lines = path.read_text().splitlines()
section = ""
out = []
for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped.strip("[]")
    if section == "api" and stripped.startswith("enable = "):
        line = "enable = true"
    elif section == "api" and stripped.startswith("address = "):
        line = f'address = "tcp://127.0.0.1:{lcd_port}"'
    elif section == "grpc" and stripped.startswith("address = "):
        line = f'address = "127.0.0.1:{grpc_port}"'
    out.append(line)
path.write_text("\n".join(out) + "\n")
PY

# Start Chain
echo ">>> Starting chain..."
export KZG_TRUSTED_SETUP=$TRUSTED_SETUP
"$BINARY" start --home "$HOME_DIR" --log_level info > "$HOME_DIR/chain.log" 2>&1 &
PID=$!

# Wait for start
echo ">>> Waiting for chain start..."
CHAIN_STARTED=0
for i in {1..60}; do
    STATUS=$(timeout 10s curl -s --max-time 2 "http://127.0.0.1:${RPC_PORT}/status" || echo "")
    if [ -n "$STATUS" ]; then
        HEIGHT=$(echo "$STATUS" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
        if [[ -n "$HEIGHT" && "$HEIGHT" != "null" && "$HEIGHT" != "0" ]]; then
            echo "Chain started at height $HEIGHT."
            CHAIN_STARTED=1
            break
        fi
    fi
    sleep 1
done
if [ "$CHAIN_STARTED" != "1" ]; then
    echo "FAILURE: chain did not start." >&2
    exit 1
fi

echo ">>> Waiting for LCD API..."
for i in {1..60}; do
    if timeout 10s curl -sS --max-time 2 "$LCD_BASE/polystorechain/polystorechain/v1/params" >/dev/null 2>&1; then
        echo "LCD API reachable."
        break
    fi
    if [ "$i" = "60" ]; then
        echo "FAILURE: LCD API was not reachable." >&2
        exit 1
    fi
    sleep 1
done

# Register Providers
echo ">>> Registering 24 Providers (12 General, 12 Edge)..."
for i in {1..24}
do
   CAPABILITY="General"
   if [ "$i" -gt 12 ]; then
      CAPABILITY="Edge"
   fi
   ENDPOINT="/ip4/127.0.0.1/tcp/$((18000 + i))/http"
   "$BINARY" tx nilchain register-provider "$CAPABILITY" 1000000000 --endpoint "$ENDPOINT" --from "provider$i" --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --node "$NODE_ADDR" --broadcast-mode sync > /dev/null
done
echo ">>> Waiting for provider registrations to commit..."
sleep 2

# Create Deal with one-stripe MaxSpend.
# Default base stripe cost is 10 per replica, so one 12-provider overlay costs 120.
echo ">>> Creating Deal (MaxSpend=120, exactly one overlay stripe)..."
CREATE_RESP=$("$BINARY" tx nilchain create-deal 100 1000 120 \
  --service-hint General \
  --from user --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --node "$NODE_ADDR" --gas 300000 --broadcast-mode sync)
CREATE_TX_HASH=$(echo "$CREATE_RESP" | awk '/txhash:/ {print $2}' | tail -n 1)
echo "CreateDeal txhash: $CREATE_TX_HASH"

# Wait for deliver-tx and confirm success.
sleep 2
CREATE_TX=$("$BINARY" q tx "$CREATE_TX_HASH" --node "$NODE_ADDR" --home "$HOME_DIR" -o json)
CREATE_CODE=$(echo "$CREATE_TX" | jq -r '.code // 0')
if [ "$CREATE_CODE" != "0" ]; then
  echo "CreateDeal failed: $(echo "$CREATE_TX" | jq -r '.raw_log')"
  exit 1
fi

echo ">>> Deal created. Waiting for block..."
sleep 2

# Signal Saturation (Stripe 1 -> 2)
echo ">>> Signaling Saturation (Provider 1)..."
# Provider 1 should be in the first stripe (randomly assigned but likely)
# We try provider1. If it fails, it might be because p1 isn't assigned.
# But with 24 providers and 12 assigned, 50% chance.
# Actually, CreateDeal assigns *first* available? No, `AssignProviders` is deterministic based on hash.
# Let's find an assigned provider.
GRPC_FLAGS="--grpc-addr localhost:${GRPC_PORT} --grpc-insecure"
DEAL_INFO=$("$BINARY" q nilchain get-deal --id 0 --home "$HOME_DIR" -o json $GRPC_FLAGS)
ASSIGNED_ADDR=$(echo "$DEAL_INFO" | jq -r '.deal.providers[0]')
echo "Assigned Provider: $ASSIGNED_ADDR"

# Find which provider key corresponds to this address
ASSIGNED_KEY=""
for i in {1..24}; do
    ADDR=$("$BINARY" keys show "provider$i" -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
    if [ "$ADDR" == "$ASSIGNED_ADDR" ]; then
        ASSIGNED_KEY="provider$i"
        break
    fi
done
echo "Using Key: $ASSIGNED_KEY"

if [ -z "$ASSIGNED_KEY" ]; then
    echo "WARNING: could not map assigned provider address to local key; falling back to provider1"
    ASSIGNED_KEY="provider1"
fi

SIGNAL_TX_HASH=$(submit_signal_saturation "$ASSIGNED_KEY")
echo "SignalSaturation txhash: $SIGNAL_TX_HASH"

echo ">>> Waiting for block..."
sleep 2
SIGNAL_CODE=$(query_tx_code "$SIGNAL_TX_HASH")
if [ "$SIGNAL_CODE" != "0" ]; then
    echo "FAILURE: first SignalSaturation failed with code $SIGNAL_CODE." >&2
    "$BINARY" q tx "$SIGNAL_TX_HASH" --node "$NODE_ADDR" --home "$HOME_DIR" -o json >&2 || true
    exit 1
fi

# Check Deal Replication
DEAL_INFO_AFTER=$("$BINARY" q nilchain get-deal --id 0 --home "$HOME_DIR" -o json $GRPC_FLAGS)
REP=$(echo "$DEAL_INFO_AFTER" | jq -r '.deal.current_replication')
echo "Current Replication: $REP"

if [ "$REP" == "24" ]; then
    echo "SUCCESS: Replication increased to 24 (2 stripes)."
else
    echo "FAILURE: Replication is $REP (Expected 24)."
    exit 1
fi

assert_virtual_stripe_count 1
assert_virtual_stripe_edge_only 2 12

# Signal Saturation Again (Stripe 2 -> 3). MaxSpend equals one overlay cost,
# so the second request should fail closed.
echo ">>> Signaling Saturation Again (Budget Limit Test, should fail)..."
SIGNAL_FAIL_TX_HASH=$(submit_signal_saturation "$ASSIGNED_KEY")
echo "Second SignalSaturation txhash: $SIGNAL_FAIL_TX_HASH"

echo ">>> Waiting for block..."
sleep 2
SIGNAL_FAIL_CODE=$(query_tx_code "$SIGNAL_FAIL_TX_HASH")
if [ "$SIGNAL_FAIL_CODE" = "0" ]; then
    echo "FAILURE: second SignalSaturation unexpectedly succeeded." >&2
    "$BINARY" q tx "$SIGNAL_FAIL_TX_HASH" --node "$NODE_ADDR" --home "$HOME_DIR" -o json >&2 || true
    exit 1
fi

DEAL_INFO_FINAL=$("$BINARY" q nilchain get-deal --id 0 --home "$HOME_DIR" -o json $GRPC_FLAGS)
REP_FINAL=$(echo "$DEAL_INFO_FINAL" | jq -r '.deal.current_replication')
echo "Final Replication: $REP_FINAL"

if [ "$REP_FINAL" == "24" ]; then
    echo "SUCCESS: Replication capped at 24 due to budget."
else
    echo "FAILURE: Replication increased to $REP_FINAL (Should be capped)."
    exit 1
fi

assert_virtual_stripe_count 1
STRIPE3_CODE=$(timeout 10s curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$LCD_BASE/polystorechain/polystorechain/v1/deals/0/virtual-stripes/3")
if [ "$STRIPE3_CODE" != "404" ]; then
    echo "FAILURE: expected virtual stripe 3 query to return HTTP 404, got $STRIPE3_CODE." >&2
    exit 1
fi

echo "SUCCESS: Elasticity overlay route-state E2E passed."
