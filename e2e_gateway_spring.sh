#!/bin/bash
set -e

NILCHAIND_BIN="./nilchain/nilchaind"

# Setup
echo "=== E2E Spring Roadmap: Gateway Flow ==="
./scripts/run_local_stack.sh start
sleep 10 # Wait for startup

# Ensure we have a provider
echo "=== Registering Provider ==="
$NILCHAIND_BIN tx nilchain register-provider Archive 100000000000 \
  --chain-id test-1 --from faucet --yes --home _artifacts/nilchain_data --keyring-backend test --gas-prices 0.001aatom
sleep 6

# Create test file
echo "Hello NilStore Spring" > test_spring.txt

# 1. Upload
echo "=== 1. Uploading File ==="
UPLOAD_RESP=$(curl -s -F "file=@test_spring.txt" -F "owner=nil1..." http://localhost:8080/gateway/upload)
echo "Upload Resp: $UPLOAD_RESP"
CID=$(echo $UPLOAD_RESP | jq -r '.cid')
SIZE=$(echo $UPLOAD_RESP | jq -r '.size_bytes')

if [ "$CID" == "null" ]; then
  echo "Upload failed"
  exit 1
fi

# 2. Create Deal (Capacity) - Tier 1 (4GiB)
echo "=== 2. Creating Deal (Capacity) ==="
# Note: Creator is faucet logic in Gateway, so we pass empty creator or dummy
DEAL_RESP=$(curl -s -X POST http://localhost:8080/gateway/create-deal \
  -d "{\"creator\":\"\", \"size_tier\":1, \"duration_blocks\":100, \"initial_escrow\":\"1000000\", \"max_monthly_spend\":\"500000\"}")
echo "Create Deal Resp: $DEAL_RESP"
TX_HASH=$(echo $DEAL_RESP | jq -r '.tx_hash')

sleep 6

echo "Checking TX status..."
$NILCHAIND_BIN q tx $TX_HASH -o json

# Get Deal ID from Chain (query list-deals and pick last)
DEALS_JSON=$($NILCHAIND_BIN query nilchain list-deals -o json)
echo "Deals JSON: $DEALS_JSON"
DEAL_ID=$(echo $DEALS_JSON | jq -r '.deals[-1].id // 0')
echo "Deal ID: $DEAL_ID"

# 3. Committing Content
echo "=== 3. Committing Content ==="
$NILCHAIND_BIN tx nilchain update-deal-content --help
COMMIT_RESP=$(curl -s -X POST http://localhost:8080/gateway/update-deal-content \
  -d "{\"deal_id\":$DEAL_ID, \"cid\":\"$CID\", \"size_bytes\":$SIZE}")
echo "Commit Resp: $COMMIT_RESP"

if [[ "$COMMIT_RESP" == *"failed"* ]]; then
  echo "Commit failed. Gateway logs:"
  tail -n 20 _artifacts/localnet/gateway.log
  exit 1
fi

sleep 6

# 4. Verify
echo "=== 4. Verifying State ==="
FINAL_DEAL=$($NILCHAIND_BIN query nilchain get-deal --id $DEAL_ID -o json)
FINAL_CID=$(echo $FINAL_DEAL | jq -r '.deal.cid')
FINAL_SIZE=$(echo $FINAL_DEAL | jq -r '.deal.size')

echo "Final CID: $FINAL_CID"
echo "Final Size: $FINAL_SIZE"

if [ "$FINAL_CID" == "$CID" ] && [ "$FINAL_SIZE" == "$SIZE" ]; then
  echo "SUCCESS: Deal content updated correctly."
else
  echo "FAILURE: Deal content mismatch."
  exit 1
fi

echo "=== Cleanup ==="
./scripts/run_local_stack.sh stop
