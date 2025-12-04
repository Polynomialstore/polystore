#!/bin/bash
set -e

# Directories
ROOT_DIR=$(pwd)
CHAIN_DIR="$ROOT_DIR/nilchain"
CORE_DIR="$ROOT_DIR/nil_core"
LOG_FILE="$ROOT_DIR/e2e_burn.log"

echo "[E2E-BURN] Building..."
cd "$CHAIN_DIR"
# Ensure trusted setup is present
cp ../demos/kzg/trusted_setup.txt .
export CGO_LDFLAGS="-L$CORE_DIR/target/release -lnil_core"
go build -v ./cmd/nilchaind

echo "[E2E-BURN] Starting chain..."
pkill nilchaind || true
./nilchaind start > "$LOG_FILE" 2>&1 &
CHAIN_PID=$!
sleep 10

echo "[E2E-BURN] Faucet..."
# Bob needs tokens to be slashed
# Faucet is usually at :4500 or similar, or we can transfer from Alice
# Assuming Alice has genesis funds
./nilchaind tx bank send alice $(./nilchaind keys show bob -a) 50000000token --chain-id nilchain --yes
sleep 6

echo "[E2E-BURN] Submitting INVALID Proof (Bob)..."
# Invalid Proof (All Zeros is valid for Z=0, Y=0? Wait, previously we said c00... is valid for zero poly.)
# Let's use a commitment that doesn't match the proof.
# C = c00... (Zero Poly)
# Z = 1 (0...01)
# Y = 100 (Non-zero)
# Proof = c00... (Identity)
# This should FAIL verification because P(1) != 100 for P(x)=0.

C="c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
Z="0100000000000000000000000000000000000000000000000000000000000000"
Y="6400000000000000000000000000000000000000000000000000000000000000"
P="c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

TX_RES=$(./nilchaind tx nilchain submit-proof $C $Z $Y $P --from bob --chain-id nilchain --yes --output json)
TX_HASH=$(echo "$TX_RES" | grep -o '"txhash":"[^"]*"' | cut -d'"' -f4)
echo "[E2E-BURN] Tx Hash: $TX_HASH"

sleep 6

QUERY_RES=$(./nilchaind q tx $TX_HASH --output json)
# We expect Code 0 (Tx processed) but Valid=false inside response?
# Actually MsgSubmitProofResponse has Valid bool.
# But we added slashing logic. The Tx execution itself should succeed (fee deducted/slashed).
# Wait, if SendCoins fails (insufficient funds), Tx fails?
# We gave bob 50token. Slashed 10token. He has enough.

if echo "$QUERY_RES" | grep -q '"code":0'; then
    echo "[E2E-BURN] Tx Executed."
else
    echo "[E2E-BURN] Tx Failed (unexpected)."
    echo "$QUERY_RES"
    kill $CHAIN_PID
    exit 1
fi

# Check Logs for Slash
if grep -q "Slashing Sender" "$LOG_FILE"; then
    echo "[E2E-BURN] SUCCESS: Slashing triggered."
else
    echo "[E2E-BURN] FAILURE: No slashing log found."
    grep "KZG" "$LOG_FILE" || true
    kill $CHAIN_PID
    exit 1
fi

kill $CHAIN_PID
