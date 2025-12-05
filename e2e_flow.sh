#!/bin/bash
set -e

# End-to-End Flow Script for NilStore Network (Phase 3)
# This script simulates a full lifecycle: Setup -> Register -> Deal -> Prove -> Reward

BINARY="./nilchaind"
CHAIN_ID="nilchain"
HOME_DIR="./.nilchain"
MDU_FILE="./test_mdu.dat"
TRUSTED_SETUP="$(pwd)/nilchain/trusted_setup.txt"

# Ensure binaries are built
echo ">>> Building binaries..."
cd nilchain && go build -o ../nilchaind ./cmd/nilchaind && cd ..

# Clean start
echo ">>> Resetting chain..."
pkill -f nilchaind || true
rm -rf $HOME_DIR
$BINARY init mynode --chain-id $CHAIN_ID --home $HOME_DIR > /dev/null 2>&1
$BINARY config chain-id $CHAIN_ID --home $HOME_DIR
$BINARY config keyring-backend test --home $HOME_DIR

# Create accounts
echo ">>> Creating accounts..."
yes | $BINARY keys add alice --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
yes | $BINARY keys add bob --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
yes | $BINARY keys add charlie --home $HOME_DIR --keyring-backend test > /dev/null 2>&1 # Storage Provider 2

ALICE_ADDR=$($BINARY keys show alice -a --home $HOME_DIR --keyring-backend test)

# Actually, we need 12 unique providers for placement.
# Let's script generating 12 provider keys.
for i in {1..12}
do
   yes | $BINARY keys add "provider$i" --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
done

# Add genesis accounts
$BINARY genesis add-genesis-account "$ALICE_ADDR" 100000000000token,100000000stake --home $HOME_DIR
for i in {1..12}
do
   PROV_ADDR=$($BINARY keys show "provider$i" -a --home $HOME_DIR --keyring-backend test)
   $BINARY genesis add-genesis-account "$PROV_ADDR" 1000000000token,1000000stake --home $HOME_DIR
done

# Gentx
$BINARY genesis gentx alice 100000000stake --chain-id $CHAIN_ID --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
$BINARY genesis collect-gentxs --home $HOME_DIR > /dev/null 2>&1

# Set minimum-gas-prices in app.toml to avoid startup error
sed -i.bak 's/minimum-gas-prices = ""/minimum-gas-prices = "0token"/' $HOME_DIR/config/app.toml
# Speed up block time to 1s for faster testing (config.toml)
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' $HOME_DIR/config/config.toml

# Start Chain in background
echo ">>> Starting chain..."
$BINARY start --home $HOME_DIR > $HOME_DIR/chain.log 2>&1 &
PID=$!

# Wait for chain to start and produce blocks
echo ">>> Waiting for chain to start..."
for i in {1..120}; do
    if curl -s --max-time 5 http://127.0.0.1:26657/status > /dev/null; then
        echo "Chain started!"
        break
    fi
    sleep 2
done

# Register Providers
echo ">>> Registering 12 Providers..."
for i in {1..12}
do
   yes | $BINARY tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync
done

# Create 8MB Test File
echo ">>> Generating 8MB Test File..."
dd if=/dev/zero of=$MDU_FILE bs=1M count=8

# Create Deal (Alice)
echo ">>> Creating Deal..."
yes | $BINARY tx nilchain create-deal "QmTestCid" 8388608 100 1000 100 --from alice --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync
sleep 5

# Verify Deal Created
# We can query deals? (Need to implement Query commands... skipped for now)
# Assuming Deal ID is 0 (first deal).

# Prove Liveness (Provider 1 - assuming they got assigned)
# We try provider1. If they aren't assigned, it will fail.
# With 12 providers and redundancy 12, ALL 12 should be assigned!
echo ">>> Submitting Proof (Provider 1)..."
yes | $BINARY tx nilchain prove-liveness-local 0 $MDU_FILE $TRUSTED_SETUP --from provider1 --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Waiting for block..."
sleep 5

echo ">>> Done! Check logs for success."
kill $PID
rm -rf $HOME_DIR
rm $MDU_FILE
rm $BINARY
