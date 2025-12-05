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

USER_ADDR=$($BINARY keys show user -a --home $HOME_DIR --keyring-backend test)
PROVIDER1_ADDR=$($BINARY keys show provider1 -a --home $HOME_DIR --keyring-backend test)

# Add genesis accounts
$BINARY genesis add-genesis-account "$USER_ADDR" 100000000000token,100000000stake --home $HOME_DIR
for i in {1..24}
do
   PROV_ADDR=$($BINARY keys show "provider$i" -a --home $HOME_DIR --keyring-backend test)
   $BINARY genesis add-genesis-account "$PROV_ADDR" 1000000000token,1000000stake --home $HOME_DIR
done

$BINARY genesis gentx user 100000000stake --chain-id $CHAIN_ID --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
$BINARY genesis collect-gentxs --home $HOME_DIR > /dev/null 2>&1

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
    STATUS=$(curl -s --max-time 2 http://127.0.0.1:26657/status || echo "")
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

# Create Deal with High MaxSpend
# 12 replicas * 10 NIL = 120 NIL per epoch
# MaxSpend = 300 NIL (Allows 2 stripes, denies 3)
echo ">>> Creating Deal (MaxSpend=300)..."
dd if=/dev/zero of=$MDU_FILE bs=1M count=8 2>/dev/null
yes | $BINARY tx nilchain create-deal "QmElasticity" 8388608 100 1000 300 --from user --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Deal created. Waiting for block..."
sleep 2

# Signal Saturation (Stripe 1 -> 2)
echo ">>> Signaling Saturation (Provider 1)..."
# Provider 1 should be in the first stripe (randomly assigned but likely)
# We try provider1. If it fails, it might be because p1 isn't assigned.
# But with 24 providers and 12 assigned, 50% chance.
# Actually, CreateDeal assigns *first* available? No, `AssignProviders` is deterministic based on hash.
# Let's find an assigned provider.
DEAL_INFO=$($BINARY q nilchain get-deal --id 0 --home $HOME_DIR -o json)
ASSIGNED_ADDR=$(echo $DEAL_INFO | jq -r '.deal.providers[0]')
echo "Assigned Provider: $ASSIGNED_ADDR"

# Find which provider key corresponds to this address
ASSIGNED_KEY=""
for i in {1..24}; do
    ADDR=$($BINARY keys show "provider$i" -a --home $HOME_DIR --keyring-backend test)
    if [ "$ADDR" == "$ASSIGNED_ADDR" ]; then
        ASSIGNED_KEY="provider$i"
        break
    fi
done
echo "Using Key: $ASSIGNED_KEY"

yes | $BINARY tx nilchain signal-saturation 0 --from $ASSIGNED_KEY --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Waiting for block..."
sleep 2

# Check Deal Replication
DEAL_INFO_AFTER=$($BINARY q nilchain get-deal --id 0 --home $HOME_DIR -o json)
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

DEAL_INFO_FINAL=$($BINARY q nilchain get-deal --id 0 --home $HOME_DIR -o json)
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
rm $MDU_FILE
