#!/bin/bash
set -e

# End-to-End Retrieval Receipt Test
# Usage: ./e2e_retrieval.sh

BINARY="./nilchaind"
CHAIN_ID="nilchain"
HOME_DIR="./.nilchain_retrieval"
MDU_FILE="./test_retrieval_mdu.dat"
RECEIPT_FILE="./receipt.json"
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
for i in {1..12}
do
   yes | $BINARY keys add "provider$i" --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
done

USER_ADDR=$($BINARY keys show user -a --home $HOME_DIR --keyring-backend test)
PROVIDER1_ADDR=$($BINARY keys show provider1 -a --home $HOME_DIR --keyring-backend test)

# Add genesis accounts
$BINARY genesis add-genesis-account "$USER_ADDR" 100000000000token,100000000stake --home $HOME_DIR
for i in {1..12}
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
echo ">>> Registering Providers..."
for i in {1..12}
do
   yes | $BINARY tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync > /dev/null
done

# Create Deal
echo ">>> Creating Deal..."
dd if=/dev/zero of=$MDU_FILE bs=1M count=8 2>/dev/null
yes | $BINARY tx nilchain create-deal "QmTestRetrieval" 8388608 100 1000 100 --from user --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Deal created. Waiting for block..."
sleep 2

# --- Test Case: Retrieval Receipt ---
echo ">>> Signing Retrieval Receipt (User)..."
# sign-retrieval-receipt [deal-id] [provider] [epoch] [file] [trusted-setup]
# Deal ID 0. Epoch 1.
# We use --offline because we just need keys, not node.
$BINARY tx nilchain sign-retrieval-receipt 0 $PROVIDER1_ADDR 1 $MDU_FILE $TRUSTED_SETUP --from user --keyring-backend test --home $HOME_DIR --offline > $RECEIPT_FILE

echo ">>> Receipt generated:"
head -n 5 $RECEIPT_FILE

echo ">>> Submitting Retrieval Proof (Provider)..."
# Provider 1 submits the receipt
yes | $BINARY tx nilchain submit-retrieval-proof $RECEIPT_FILE --from provider1 --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Waiting for block processing..."
sleep 3

# Check logs for success
if grep -q "success" $HOME_DIR/chain.log; then
    echo "SUCCESS: Retrieval Proof accepted."
else
    echo "FAILURE: Retrieval Proof NOT found in logs."
    cat $HOME_DIR/chain.log
fi

# Cleanup
kill $PID
rm -rf $HOME_DIR
rm $MDU_FILE $RECEIPT_FILE
