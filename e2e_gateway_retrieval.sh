#!/usr/bin/env bash
set -euo pipefail

# End-to-end test of the gateway-based retrieval path:
#   - Start the local stack (chain + faucet + gateway + web).
#   - Upload a file via /gateway/upload.
#   - Create a deal via /gateway/create-deal.
#   - Download via /gateway/fetch/{cid}?deal_id=&owner= and ensure HTTP 200.
#   - Verify that a Proof entry exists for that deal in /nilchain/nilchain/v1/proofs.
#
# Usage:
#   ./e2e_gateway_retrieval.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"
if [ ! -x "$STACK_SCRIPT" ]; then
  echo "run_local_stack.sh not found at $STACK_SCRIPT"
  exit 1
fi

GATEWAY_BASE="http://localhost:8080"
LCD_BASE="http://localhost:1317"
CHAIN_HOME="${NIL_HOME:-$ROOT_DIR/_artifacts/nilchain_data}"

# By default the gateway uses fast-shard mode, which does not generate
# manifest blobs/MDUs needed for on-chain retrieval proofs. Proof checking
# is therefore conditional below.

banner() { printf '\n>>> %s\n' "$*"; }

start_stack() {
  banner "Starting local stack"
  "$STACK_SCRIPT" start
}

stop_stack() {
  banner "Stopping local stack"
  "$STACK_SCRIPT" stop || true
}

wait_for_endpoint() {
  local url="$1"
  local label="$2"
  local attempts=60
  local i
  for i in $(seq 1 "$attempts"); do
    if timeout 10s curl -s --max-time 2 "$url" >/dev/null 2>&1; then
      echo "$label is up at $url"
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $label at $url"
  return 1
}

cleanup() {
  stop_stack
}
trap cleanup EXIT

start_stack

banner "Waiting for LCD and Gateway"
wait_for_endpoint "$LCD_BASE/cosmos/base/tendermint/v1beta1/blocks/latest" "LCD"
wait_for_endpoint "$GATEWAY_BASE/gateway/upload" "Gateway"

banner "Resolving faucet owner address"
OWNER_ADDR="$("$ROOT_DIR/nilchain/nilchaind" keys show faucet -a --home "$CHAIN_HOME" --keyring-backend test 2>/dev/null || true)"
if [ -z "$OWNER_ADDR" ]; then
  echo "Failed to resolve faucet address from nilchaind; check that the stack is running correctly."
  exit 1
fi
echo "Using OWNER_ADDR=$OWNER_ADDR"

	banner "Uploading file via GatewayUpload"
	TEST_FILE="$ROOT_DIR/test_data.bin"
	# Always (re)create a tiny file so full ingest stays under curl timeouts.
	dd if=/dev/zero of="$TEST_FILE" bs=1K count=1 >/dev/null 2>&1

UPLOAD_RESP="$(timeout 60s curl -s -X POST -F "file=@${TEST_FILE}" -F "owner=${OWNER_ADDR}" "$GATEWAY_BASE/gateway/upload")"
echo "Upload response: $UPLOAD_RESP"

		CID="$(echo "$UPLOAD_RESP" | jq -r '.cid')"
		MANIFEST_ROOT="$(echo "$UPLOAD_RESP" | jq -r '.manifest_root // .cid')"
	SIZE_BYTES="$(echo "$UPLOAD_RESP" | jq -r '.size_bytes')"
	if [ -z "$CID" ] || [ "$CID" = "null" ] || [ -z "$MANIFEST_ROOT" ] || [ "$MANIFEST_ROOT" = "null" ] || [ -z "$SIZE_BYTES" ] || [ "$SIZE_BYTES" = "null" ]; then
	  echo "Failed to parse cid/manifest_root/size_bytes from upload response"
	  exit 1
	fi
	echo "CID=$CID manifest_root=$MANIFEST_ROOT size_bytes=$SIZE_BYTES"

banner "Creating deal via GatewayCreateDeal"
	CREATE_PAYLOAD="$(cat <<JSON
	{
	  "creator": "",
	  "duration_blocks": 100,
	  "service_hint": "General",
	  "initial_escrow": "1000000",
	  "max_monthly_spend": "5000000"
	}
	JSON
	)"

CREATE_RESP="$(echo "$CREATE_PAYLOAD" | timeout 10s curl -s -X POST -H "Content-Type: application/json" -d @- "$GATEWAY_BASE/gateway/create-deal")"
echo "Create-deal response: $CREATE_RESP"

	banner "Resolving latest deal ID from LCD"
	DEAL_ID=""
	for i in {1..30}; do
	  DEALS_JSON="$(timeout 10s curl -s "$LCD_BASE/nilchain/nilchain/v1/deals")"
	  DEAL_ID="$(echo "$DEALS_JSON" | jq -r '.deals[-1].id // empty')"
	  if [ -n "$DEAL_ID" ]; then
	    echo "Found deal_id=$DEAL_ID"
	    break
	  fi
	  echo "Deals not yet visible; retrying..."
	  sleep 2
	done

	if [ -z "$DEAL_ID" ] || [ "$DEAL_ID" = "null" ]; then
	  echo "Failed to resolve latest deal from LCD"
	  exit 1
	fi

	banner "Committing content via GatewayUpdateDealContent"
	UPDATE_PAYLOAD="$(cat <<JSON
	{
	  "deal_id": $DEAL_ID,
	  "cid": "$MANIFEST_ROOT",
	  "size_bytes": $SIZE_BYTES
	}
	JSON
	)"
	UPDATE_RESP="$(echo "$UPDATE_PAYLOAD" | timeout 10s curl -s -X POST -H "Content-Type: application/json" -d @- "$GATEWAY_BASE/gateway/update-deal-content")"
	echo "Update-deal-content response: $UPDATE_RESP"
	sleep 3

banner "Downloading file via GatewayFetch (and proving retrieval)"
ENCODED_CID="$(python3 - "$CID" <<'PY'
import urllib.parse, sys
print(urllib.parse.quote(sys.argv[1]))
PY
)"

FETCH_URL="$GATEWAY_BASE/gateway/fetch/${ENCODED_CID}?deal_id=${DEAL_ID}&owner=${OWNER_ADDR}"

HTTP_CODE="$(timeout 10s curl -s -o /dev/null -w '%{http_code}' "$FETCH_URL")"
echo "GatewayFetch HTTP status: $HTTP_CODE"
if [ "$HTTP_CODE" != "200" ]; then
  echo "Expected HTTP 200 from GatewayFetch, got $HTTP_CODE"
  exit 1
fi

if [ "${NIL_FULL_INGEST:-0}" != "1" ]; then
  banner "Skipping proof check (fast ingest mode)"
  exit 0
fi

banner "Checking /proofs for a proof entry for deal_id=$DEAL_ID"
FOUND_PROOF="false"
for i in {1..30}; do
  PROOFS_JSON="$(timeout 10s curl -s "$LCD_BASE/nilchain/nilchain/v1/proofs")"
  COUNT="$(echo "$PROOFS_JSON" | jq -r --arg id "$DEAL_ID" '[.proof[]? | select(.commitment | contains("deal:" + $id + "/"))] | length')"
  if [ "$COUNT" != "null" ] && [ "$COUNT" -gt 0 ]; then
    echo "Found $COUNT proof(s) for deal:$DEAL_ID in proofs endpoint."
    FOUND_PROOF="true"
    break
  fi
  echo "No proofs yet for deal_id=$DEAL_ID; retrying..."
  sleep 2
done

if [ "$FOUND_PROOF" != "true" ]; then
  echo "FAILURE: no proofs found for deal_id=$DEAL_ID after GatewayFetch"
  exit 1
fi

banner "SUCCESS: gateway upload/create/fetch produced on-chain proofs"
