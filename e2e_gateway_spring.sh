#!/bin/bash
set -euo pipefail

NILCHAIND_BIN="./nilchain/nilchaind"

# Setup
echo "=== E2E Spring Roadmap: Gateway Flow ==="
export CHAIN_ID="${CHAIN_ID:-test-1}"
./scripts/run_local_stack.sh start
sleep 10 # Wait for startup

# Use faucet address as the logical owner for this legacy Mode 1 flow.
OWNER_ADDR=$(timeout 10s $NILCHAIND_BIN keys show faucet -a --home _artifacts/nilchain_data --keyring-backend test | tail -n 1)
echo "Owner: $OWNER_ADDR"

# Create test file
echo "Hello NilStore Spring" > test_spring.txt

# 1. Upload
echo "=== 1. Uploading File ==="
UPLOAD_RESP=$(timeout 10s curl -s -F "file=@test_spring.txt" -F "owner=$OWNER_ADDR" http://localhost:8080/gateway/upload)
echo "Upload Resp: $UPLOAD_RESP"
MANIFEST_ROOT=$(echo $UPLOAD_RESP | jq -r '.manifest_root // .cid')
SIZE=$(echo $UPLOAD_RESP | jq -r '.size_bytes')

if [ "$MANIFEST_ROOT" == "null" ] || [ -z "$MANIFEST_ROOT" ]; then
  echo "Upload failed"
  exit 1
fi

# 2. Create Deal (Capacity)
echo "=== 2. Creating Deal (Capacity) ==="
# Note: Creator is faucet logic in Gateway, so we pass empty creator or dummy
DEAL_RESP=$(timeout 10s curl -s -X POST http://localhost:8080/gateway/create-deal \
  -H "Content-Type: application/json" \
  -d "{\"creator\":\"\", \"duration_blocks\":100, \"initial_escrow\":\"1000000\", \"max_monthly_spend\":\"500000\"}")
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
COMMIT_RESP=$(timeout 10s curl -s -X POST http://localhost:8080/gateway/update-deal-content \
  -H "Content-Type: application/json" \
  -d "{\"deal_id\":$DEAL_ID, \"cid\":\"$MANIFEST_ROOT\", \"size_bytes\":$SIZE}")
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
FINAL_SIZE=$(echo $FINAL_DEAL | jq -r '.deal.size')

FINAL_MANIFEST_HEX=$(python3 - <<PY
import json, base64
deal = json.loads('''$FINAL_DEAL''').get('deal', {})
mr = deal.get('manifest_root', '') or ''
if mr.startswith('0x'):
    print(mr)
elif mr:
    try:
        print('0x' + base64.b64decode(mr).hex())
    except Exception:
        print(mr)
else:
    print('')
PY
)

echo "Final Manifest Root: $FINAL_MANIFEST_HEX"
echo "Final Size: $FINAL_SIZE"

if [ "$FINAL_MANIFEST_HEX" == "$MANIFEST_ROOT" ] && [ "$FINAL_SIZE" == "$SIZE" ]; then
  echo "SUCCESS: Deal content updated correctly."
else
  echo "FAILURE: Deal content mismatch."
  exit 1
fi

echo "=== Cleanup ==="
./scripts/run_local_stack.sh stop
