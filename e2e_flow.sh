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

# Inject aatom metadata for EVM
GENESIS="$HOME_DIR/config/genesis.json"
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
bank["denom_metadata"] = md
data["app_state"]["bank"] = bank
json.dump(data, open(path, "w"), indent=1)
PY

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
    if timeout 10s curl -s --max-time 5 http://127.0.0.1:26657/status > /dev/null; then
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

# Create Deal (Alice) - Step 1: Capacity
echo ">>> Creating Deal (Capacity)..."
yes | $BINARY tx nilchain create-deal 1000 1000000000 1000000000 --from alice --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync
sleep 5

# Update Deal Content - Step 2: Content
echo ">>> Updating Deal Content..."
yes | $BINARY tx nilchain update-deal-content --deal-id 1 --cid "QmTestCid" --size 8388608 --from alice --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync
sleep 5

# Verify Deal Created
# We can query deals? (Need to implement Query commands... skipped for now)
# Assuming Deal ID is 1 (first deal).

# Prove Liveness (Provider 1 - assuming they got assigned)
# We try provider1. If they aren't assigned, it will fail.
# With 12 providers and redundancy 12, ALL 12 should be assigned!
echo ">>> Submitting Proof (Provider 1)..."
yes | $BINARY tx nilchain prove-liveness-local 1 $MDU_FILE $TRUSTED_SETUP --from provider1 --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Waiting for block..."
sleep 5

echo ">>> Done! Check logs for success."
kill $PID
rm -rf $HOME_DIR
rm $MDU_FILE
rm $BINARY
