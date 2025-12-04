#!/bin/bash
set -e

# Directories
ROOT_DIR=$(pwd)
CHAIN_DIR="$ROOT_DIR/nilchain"
CORE_DIR="$ROOT_DIR/nil_core"
LOG_FILE="$ROOT_DIR/e2e_chain.log"

echo "[E2E] Starting End-to-End Test..."

# 1. Build Rust Core
echo "[E2E] Building nil_core..."
cd "$CORE_DIR"
cargo build --release
cd "$ROOT_DIR"

# 2. Build NilChain
echo "[E2E] Building nilchaind..."
cd "$CHAIN_DIR"
# Ensure trusted setup is present
cp ../demos/kzg/trusted_setup.txt .
# Build with linker flags
export CGO_LDFLAGS="-L$CORE_DIR/target/release -lnil_core"
go build -v ./cmd/nilchaind

# 3. Start Chain (Background)
echo "[E2E] Killing old instances..."
pkill nilchaind || true

echo "[E2E] Starting chain..."
# Start in background, redirect logs
./nilchaind start > "$LOG_FILE" 2>&1 &
CHAIN_PID=$!
echo "[E2E] Chain PID: $CHAIN_PID"

# Wait for chain to initialize and produce blocks
echo "[E2E] Waiting 10s for chain startup..."
sleep 10

# 4. Submit Proof
echo "[E2E] Submitting Proof (128KB Data Unit)..."
# Valid non-zero proof values (Blob[0]=42, Blob[32]=69, z=10)
C="877a8a151198b0face7c5a12d1c02ed9f1570ac3c859719e00edd120e35183db0a69e68ba394f341eee8d629b10ee6a3"
Z="0a00000000000000000000000000000000000000000000000000000000000000"
Y="547e3ff09598a939051a5d3af5767c49beb4763ada0daea6a53675650f562673"
P="ab91c229c5c40c56dff69aec2b96d17d1fc368731ecf6a422f910e9da88b980a5b616c4633d155075521d602d9a1e161"

# Submit tx
TX_RES=$(./nilchaind tx nilchain submit-proof $C $Z $Y $P --from alice --chain-id nilchain --yes --output json)
echo "Tx Response: $TX_RES"

# Extract TxHash (simple grep/cut)
TX_HASH=$(echo "$TX_RES" | grep -o '"txhash":"[^"]*"' | cut -d'"' -f4)
echo "[E2E] Tx Hash: $TX_HASH"

if [ -z "$TX_HASH" ]; then
    echo "[E2E] Failed to get TxHash"
    cat "$LOG_FILE"
    kill $CHAIN_PID
    exit 1
fi

# Wait for block inclusion
echo "[E2E] Waiting 6s for block inclusion..."
sleep 6

# 5. Query Tx Result
echo "[E2E] Querying Tx..."
QUERY_RES=$(./nilchaind q tx $TX_HASH --output json)
echo "$QUERY_RES"

# Check for "code": 0
# We grep for "code":0 or "code": 0. If it failed, code would be non-zero.
if echo "$QUERY_RES" | grep -q '"code":0'; then
    echo "[E2E] SUCCESS: Transaction code is 0."
else
    echo "[E2E] FAILURE: Transaction failed (code not 0)."
    # Print relevant log lines
    grep "verification error" "$LOG_FILE" || true
    grep "KZG" "$LOG_FILE" || true
    kill $CHAIN_PID
    exit 1
fi

# 6. Check Logs for "VALID"
if grep -q "KZG Proof VALID" "$LOG_FILE"; then
    echo "[E2E] SUCCESS: Found 'KZG Proof VALID' in chain logs."
else
    echo "[E2E] FAILURE: Log does not contain success message."
    grep "KZG" "$LOG_FILE" || true
    kill $CHAIN_PID
    exit 1
fi

echo "[E2E] Test Completed Successfully."
kill $CHAIN_PID
