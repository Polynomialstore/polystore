#!/bin/bash
set -e

# End-to-End Elasticity Test
# Usage: ./e2e_elasticity.sh

BINARY="./nilchaind"
CHAIN_ID="nilchain"
HOME_DIR="./.nilchain_elasticity"
MDU_FILE="./test_elasticity.dat"
TRUSTED_SETUP="$(pwd)/nilchain/trusted_setup.txt"

# Ensure binaries are built
echo ">>> Building binaries..."
cd nilchain && go build -o ../nilchaind ./cmd/nilchaind && cd ..

# Clean start
echo ">>> Resetting chain..."
pkill -f nilchaind || true
rm -rf $HOME_DIR
$BINARY init mynode --chain-id $CHAIN_ID --home $HOME_DIR > /dev/null 2>&1
$BINARY config set client chain-id $CHAIN_ID --home $HOME_DIR
$BINARY config set client keyring-backend test --home $HOME_DIR

# Create accounts
echo ">>> Creating accounts..."
yes | $BINARY keys add user --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
# We need enough providers for 2 stripes (12 * 2 = 24 providers)
for i in {1..24}
do
   yes | $BINARY keys add "provider$i" --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
done

USER_ADDR=$($BINARY keys show user -a --home $HOME_DIR --keyring-backend test | tail -n 1)
PROVIDER1_ADDR=$($BINARY keys show provider1 -a --home $HOME_DIR --keyring-backend test | tail -n 1)

# Add genesis accounts
$BINARY genesis add-genesis-account "$USER_ADDR" 100000000000token,200000000stake --home $HOME_DIR
for i in {1..24}
do
   PROV_ADDR=$($BINARY keys show "provider$i" -a --home $HOME_DIR --keyring-backend test | tail -n 1)
   $BINARY genesis add-genesis-account "$PROV_ADDR" 1000000000token,1000000stake --home $HOME_DIR
done

$BINARY genesis gentx user 100000000stake --chain-id $CHAIN_ID --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
$BINARY genesis collect-gentxs --home $HOME_DIR > /dev/null 2>&1

# Inject aatom denom metadata required by the EVM module (local genesis helpers
# in older scripts may omit this, causing nilchaind to panic on start).
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
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' $HOME_DIR/config/config.toml
sed -i.bak 's/minimum-gas-prices = ""/minimum-gas-prices = "0token"/' $HOME_DIR/config/app.toml

# Start Chain
echo ">>> Starting chain..."
export KZG_TRUSTED_SETUP=$TRUSTED_SETUP
$BINARY start --home $HOME_DIR --log_level info > $HOME_DIR/chain.log 2>&1 &
PID=$!

# Wait for start
echo ">>> Waiting for chain start..."
for i in {1..60}; do
    STATUS=$(timeout 10s curl -s --max-time 2 http://127.0.0.1:26657/status || echo "")
    if [ -n "$STATUS" ]; then
        HEIGHT=$(echo "$STATUS" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
        if [[ -n "$HEIGHT" && "$HEIGHT" != "null" && "$HEIGHT" != "0" ]]; then
            echo "Chain started at height $HEIGHT."
            break
        fi
    fi
    sleep 1
done

# Register Providers
echo ">>> Registering 24 Providers..."
for i in {1..24}
do
   yes | $BINARY tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync > /dev/null
done
echo ">>> Waiting for provider registrations to commit..."
sleep 2

# Create Deal with High MaxSpend
# 12 replicas * 10 NIL = 120 NIL per epoch
# MaxSpend = 300 NIL (Allows 2 stripes, denies 3)
echo ">>> Creating Deal (MaxSpend=300)..."
CREATE_RESP=$(yes | $BINARY tx nilchain create-deal 100 1000 300 \
  --service-hint General \
  --from user --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync)
CREATE_TX_HASH=$(echo "$CREATE_RESP" | awk '/txhash:/ {print $2}' | tail -n 1)
echo "CreateDeal txhash: $CREATE_TX_HASH"

# Wait for deliver-tx and confirm success.
sleep 2
CREATE_TX=$($BINARY q tx "$CREATE_TX_HASH" --home $HOME_DIR -o json)
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
GRPC_FLAGS="--grpc-addr localhost:9090 --grpc-insecure"
DEAL_INFO=$($BINARY q nilchain get-deal --id 0 --home $HOME_DIR -o json $GRPC_FLAGS)
ASSIGNED_ADDR=$(echo $DEAL_INFO | jq -r '.deal.providers[0]')
echo "Assigned Provider: $ASSIGNED_ADDR"

# Find which provider key corresponds to this address
ASSIGNED_KEY=""
for i in {1..24}; do
    ADDR=$($BINARY keys show "provider$i" -a --home $HOME_DIR --keyring-backend test | tail -n 1)
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

yes | $BINARY tx nilchain signal-saturation 0 --from $ASSIGNED_KEY --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Waiting for block..."
sleep 2

# Check Deal Replication
DEAL_INFO_AFTER=$($BINARY q nilchain get-deal --id 0 --home $HOME_DIR -o json $GRPC_FLAGS)
REP=$(echo $DEAL_INFO_AFTER | jq -r '.deal.current_replication')
echo "Current Replication: $REP"

if [ "$REP" == "24" ]; then
    echo "SUCCESS: Replication increased to 24 (2 stripes)."
else
    echo "FAILURE: Replication is $REP (Expected 24)."
fi

# Signal Saturation Again (Stripe 2 -> 3)
# Cost would be 36 * 10 = 360. MaxSpend is 300. Should FAIL.
echo ">>> Signaling Saturation Again (Budget Limit Test)..."
yes | $BINARY tx nilchain signal-saturation 0 --from $ASSIGNED_KEY --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Waiting for block..."
sleep 2

DEAL_INFO_FINAL=$($BINARY q nilchain get-deal --id 0 --home $HOME_DIR -o json $GRPC_FLAGS)
REP_FINAL=$(echo $DEAL_INFO_FINAL | jq -r '.deal.current_replication')
echo "Final Replication: $REP_FINAL"

if [ "$REP_FINAL" == "24" ]; then
    echo "SUCCESS: Replication capped at 24 due to budget."
else
    echo "FAILURE: Replication increased to $REP_FINAL (Should be capped)."
fi

# Cleanup
kill $PID
rm -rf $HOME_DIR
rm -f $MDU_FILE
