#!/bin/bash
set -e

# Configuration
GATEWAY_URL="http://localhost:8080"
LCD_URL="http://localhost:1317"
CHAIN_ID="test-1"

# 1. Upload File (New Deal Flow)
echo ">>> Uploading file..."
echo "Hello World" > test_file.txt
UPLOAD_RESP=$(timeout 60s curl -s -X POST -F "file=@test_file.txt" "$GATEWAY_URL/gateway/upload")
echo "Upload Response: $UPLOAD_RESP"

CID=$(echo $UPLOAD_RESP | jq -r '.cid')
ALLOC_LEN=$(echo $UPLOAD_RESP | jq -r '.allocated_length')
SIZE=$(echo $UPLOAD_RESP | jq -r '.size_bytes')

if [ "$CID" == "null" ] || [ "$ALLOC_LEN" == "null" ]; then
    echo "❌ Upload failed or missing fields"
    exit 1
fi

echo "✅ Got CID: $CID"
echo "✅ Got Allocated Length: $ALLOC_LEN"

# 2. Create Deal (Mocking EVM Sig for now, or using direct create-deal if available)
# Since we don't have a running chain in this environment, we stop here.
# In a real environment, we would:
# curl -X POST ... /gateway/create-deal-evm -d '{"intent": {"cid": "'$CID'", "allocated_length": '$ALLOC_LEN', ...}}'

# 3. Fetch File
echo ">>> Fetching file..."
# Assuming deal_id=1 for test
FETCH_URL="$GATEWAY_URL/gateway/fetch/$CID?deal_id=1&owner=nil1owner&file_path=test_file.txt"
# curl -s "$FETCH_URL" > fetched.txt
# diff test_file.txt fetched.txt

echo "✅ Lifecycle Script Prepared (Requires running nilchaind)"
