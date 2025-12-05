#!/bin/bash
# set -e # Re-enable exit on error

# Performance Load Generator
# Usage: ./load_gen.sh [small|medium|large]

SCALE=$1
if [ -z "$SCALE" ]; then
    echo "Usage: ./load_gen.sh [small|medium|large]"
    exit 1
fi

# Config based on Scale
if [ "$SCALE" == "small" ]; then
    NUM_PROVIDERS=5
    NUM_DEALS=5
    BROADCAST_MODE="sync"
elif [ "$SCALE" == "medium" ]; then
    NUM_PROVIDERS=20
    NUM_DEALS=50
    BROADCAST_MODE="async"
elif [ "$SCALE" == "large" ]; then
    NUM_PROVIDERS=50
    NUM_DEALS=200
    BROADCAST_MODE="async"
else
    echo "Invalid scale."
    exit 1
fi

BINARY="$(pwd)/../nilchaind"
CHAIN_ID="nilchain"
HOME_DIR="$(pwd)/.nilchain_perf"
MDU_FILE="./perf_mdu.dat"
TRUSTED_SETUP="../nilchain/trusted_setup.txt"
KEYRING="--keyring-backend test"

echo ">>> Starting Performance Test: $SCALE Scale"
echo ">>> Configuration: $NUM_PROVIDERS Providers, $NUM_DEALS Deals, Mode: $BROADCAST_MODE"

# Ensure binaries are built
echo ">>> Building binaries..."
(
    cd ../nilchain # Change to the nilchain module directory
    echo "Cleaning Go build cache..."
    go clean -cache -modcache
    CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 go build -o "../nilchaind" ./cmd/nilchaind # Build to project root
)
echo "Binary info for $BINARY:"
file "$BINARY"
ls -l "$BINARY"

# 1. Setup Chain

echo ">>> Resetting Chain..."

pkill -f nilchaind || true

rm -rf "$HOME_DIR" # Ensure clean slate before any init commands

mkdir -p "$HOME_DIR" # Ensure HOME_DIR exists



echo "Initializing new chain home..."
rm -rf "$HOME_DIR" # Clear it for a fresh run
mkdir -p "$HOME_DIR" # Ensure HOME_DIR exists

set -x # Debug shell execution for the following commands
"$BINARY" init mynode --chain-id "$CHAIN_ID" --home "$HOME_DIR" > /dev/null 2>&1 # Let init create its own genesis.json
set +x # Turn off debug shell execution
"$BINARY" config chain-id "$CHAIN_ID" --home "$HOME_DIR"
"$BINARY" config keyring-backend test --home "$HOME_DIR"

# 2. Create User Account
yes | "$BINARY" keys add user --home "$HOME_DIR" $KEYRING > /dev/null 2>&1
USER_ADDR=$("$BINARY" keys show user -a --home "$HOME_DIR" $KEYRING)

# 3. Create Provider Accounts (Sequential for reliability)
echo ">>> Creating $NUM_PROVIDERS Provider Accounts..."
for i in $(seq 1 "$NUM_PROVIDERS"); do
    yes | "$BINARY" keys add "provider$i" --home "$HOME_DIR" $KEYRING > /dev/null 2>&1
done

# 4. Genesis Setup
echo ">>> preparing genesis..."
"$BINARY" genesis add-genesis-account "$USER_ADDR" 1000000000000token,1000000000stake --home "$HOME_DIR"
for i in $(seq 1 "$NUM_PROVIDERS"); do
    PROV_ADDR=$("$BINARY" keys show "provider$i" -a --home "$HOME_DIR" $KEYRING)
    "$BINARY" genesis add-genesis-account "$PROV_ADDR" 1000000000token,1000000stake --home "$HOME_DIR"
    echo "Added provider$i ($PROV_ADDR) to genesis"
done
"$BINARY" genesis gentx user 100000000stake --chain-id "$CHAIN_ID" --home "$HOME_DIR" $KEYRING
"$BINARY" genesis collect-gentxs --home "$HOME_DIR"

# Debug: Check genesis accounts
echo ">>> Debug: Genesis auth.accounts:"
cat "$HOME_DIR/config/genesis.json" | jq .app_state.auth.accounts | head -n 10
echo ">>> Debug: Genesis bank.balances:"
cat "$HOME_DIR/config/genesis.json" | jq .app_state.bank.balances | head -n 10

# Config: Fast blocks
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' "$HOME_DIR/config/config.toml"
sed -i.bak 's/minimum-gas-prices = ""/minimum-gas-prices = "0token"/' "$HOME_DIR/config/app.toml"

# 5. Start Chain
echo ">>> Starting Chain (output to console with debug logs)..."
# Change to project root before starting nilchaind
pushd ../ > /dev/null
"$BINARY" start --home "$HOME_DIR" --log_level debug --trace &
PID=$!
popd > /dev/null

# Wait for start
echo ">>> Waiting for block production (height >= 1)..."
START_TIME=$(date +%s)
CHAIN_STARTED=0
for i in {1..60}; do
    STATUS=$(curl -s --max-time 2 http://127.0.0.1:26657/status)
    HEIGHT=$(echo "$STATUS" | grep -o '"latest_block_height":"[0-9]*"' | cut -d'"' -f4)
    if [[ ! -z "$HEIGHT" && "$HEIGHT" != "0" ]]; then
        echo "Chain active at height $HEIGHT"
        CHAIN_STARTED=1
        break
    fi
    sleep 1
done

if [ "$CHAIN_STARTED" -eq 0 ]; then
    echo "ERROR: Chain did not start within 60 seconds. See above for any nilchaind errors."
    kill "$PID" || true # Kill for debugging purposes if it didn't start properly
    rm -rf "$HOME_DIR" # Re-enable cleanup
    rm "$MDU_FILE"
    exit 1
fi


# 6. Register Providers (Batch)
echo ">>> Registering Providers..."
# Debug: Query user (validator) account
echo ">>> Debug: Querying user (validator) account..."
"$BINARY" query auth account $("$BINARY" keys show user -a --home "$HOME_DIR" $KEYRING) --home "$HOME_DIR" --node tcp://127.0.0.1:26657
echo ">>> Debug: Querying provider1 account..."
"$BINARY" query auth account $("$BINARY" keys show provider1 -a --home "$HOME_DIR" $KEYRING) --home "$HOME_DIR" --node tcp://127.0.0.1:26657

for i in $(seq 1 "$NUM_PROVIDERS"); do
    yes | "$BINARY" tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" $KEYRING --broadcast-mode "$BROADCAST_MODE" --node tcp://127.0.0.1:26657
done
# If async, wait a bit for inclusion
if [ "$BROADCAST_MODE" == "async" ]; then sleep 5; fi

# 7. Create Deals
echo ">>> Creating $NUM_DEALS Deals..."
# Generate dummy file
dd if=/dev/zero of="$MDU_FILE" bs=1M count=8 2>/dev/null

DEAL_START_TIME=$(date +%s)
for i in $(seq 1 "$NUM_DEALS"); do
    yes | "$BINARY" tx nilchain create-deal "QmPerf$i" 8388608 100 1000 100 --from user --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" $KEYRING --broadcast-mode "$BROADCAST_MODE" --node tcp://127.0.0.1:26657
    # Sequential to handle nonce correctly for single user
done
DEAL_END_TIME=$(date +%s)

# 8. Submit Proofs (Simulation)
echo ">>> Submitting Proofs..."
PROOF_START_TIME=$(date +%s)
for i in $(seq 1 "$NUM_DEALS"); do
    P_IDX=$(( (i % NUM_PROVIDERS) + 1 ))
    DEAL_ID=$((i - 1))
    
    yes | "$BINARY" tx nilchain prove-liveness-local "$DEAL_ID" "$MDU_FILE" "$TRUSTED_SETUP" --from "provider$P_IDX" --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" $KEYRING --broadcast-mode "$BROADCAST_MODE" --node tcp://127.0.0.1:26657
done
PROOF_END_TIME=$(date +%s)

# 9. Wait for processing
echo ">>> Waiting for final blocks..."
sleep 10

END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

# 10. Analysis
LATEST_HEIGHT=$(curl -s http://127.0.0.1:26657/status | grep -o '"latest_block_height":"[0-9]*"' | cut -d'"' -f4)

echo "------------------------------------------------"
echo "Performance Report: $SCALE"
echo "------------------------------------------------"
echo "Total Duration: ${TOTAL_DURATION}s"
echo "Final Block Height: $LATEST_HEIGHT"
echo "Transactions Sent: $((NUM_PROVIDERS + NUM_DEALS + NUM_DEALS))" # Reg + Create + Prove
echo "Avg Block Time: $(echo "$TOTAL_DURATION / $LATEST_HEIGHT" | bc -l)s"

# Cleanup
kill "$PID"
rm -rf "$HOME_DIR"
rm "$MDU_FILE"