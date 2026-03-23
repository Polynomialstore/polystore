# Manual Devnet Runbook

This document is the human companion to the guarded end-to-end scripts in `scripts/`.
It is intentionally a checklist: when you need exact commands, prefer reading/running the scripts with `set -x`.

## Profiles (pick one)

### Profile A — Script parity (CI-like; uses tx relay endpoints)

This mirrors `scripts/e2e_lifecycle.sh` and uses the gateway relay endpoints (`/gateway/*-evm`).

Start the stack with tx relay enabled:

```bash
NIL_ENABLE_TX_RELAY=1 scripts/run_local_stack.sh start
```

### Profile B — Wallet-first (mainnet parity; no relay)

Tx relay is **off by default** and should remain off for mainnet parity.

- Browser: follow `HAPPY_PATH.md` (Option C) and `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`.
- CLI: prefer the dedicated scripts (`scripts/e2e_open_retrieval_session_cli.sh`, `scripts/e2e_open_retrieval_session_mode2_cli.sh`) rather than reproducing the low-level steps here.

## 1. Prerequisites

1. Ensure local tooling is available:
   - Go + Rust toolchains
   - Node.js + npm (for `tsx` helper scripts under `nil-website/scripts/`)
   - `curl` + `python3` (used for JSON parsing / tiny helpers)
2. Install website deps (needed for `tsx` scripts used below):

   ```bash
   npm -C nil-website ci
   ```

3. Start the canonical local stack:

   ```bash
   scripts/run_local_stack.sh start
   ```

   Notes:
   - `scripts/run_local_stack.sh start` **always re-initializes** the chain home.
   - Default home is `_artifacts/nilchain_data`. If you set `NIL_HOME` outside `_artifacts/`, the script will refuse to wipe it unless you set `NIL_REINIT_HOME=1`.
     - Example: `NIL_HOME=/var/lib/nilstore/local NIL_REINIT_HOME=1 scripts/run_local_stack.sh start`
   - Tx relay is **off by default**; enable it only if you’re following **Profile A**:
     - `NIL_ENABLE_TX_RELAY=1 scripts/run_local_stack.sh start`

4. Confirm endpoints are healthy:

   ```bash
   scripts/devnet_healthcheck.sh hub
   ```

## 2. Manual lifecycle smoke (Create → Upload → Commit → Fetch)

This section mirrors `scripts/e2e_lifecycle.sh`, but you run the commands yourself.

Set local endpoint env vars (defaults match the local stack):

```bash
export LCD_BASE="${LCD_BASE:-http://localhost:1317}"
export GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
export FAUCET_BASE="${FAUCET_BASE:-http://localhost:8081}"
export EVM_RPC="${EVM_RPC:-http://localhost:8545}"

export CHAIN_ID="${CHAIN_ID:-test-1}"
export EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"

# Deterministic dev key (Foundry default #0); used by `nil-website/scripts/*`.
export EVM_PRIVKEY="${EVM_PRIVKEY:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
```

Note: the `/gateway/*-evm` relay endpoints used below require `NIL_ENABLE_TX_RELAY=1` (Profile A).

### 2.1 Create deal (EVM intent + optional relay)

Build a signed intent (this prints JSON to stdout):

```bash
CREATE_PAYLOAD=$(
  NONCE=1 \
  DURATION_BLOCKS=100 \
  SERVICE_HINT="General" \
  INITIAL_ESCROW="1000000" \
  MAX_MONTHLY_SPEND="500000" \
  nil-website/node_modules/.bin/tsx nil-website/scripts/sign_intent.ts create-deal
)
```

Extract the EVM address from the payload, then convert it to the NIL bech32 address:

```bash
EVM_ADDRESS="$(python3 - <<PY
import json
print(json.loads('''$CREATE_PAYLOAD''')["intent"]["creator_evm"])
PY
)"

NIL_ADDRESS="$(python3 - "$EVM_ADDRESS" <<'PY'
import sys

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def bech32_polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk

def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]

def bech32_create_checksum(hrp, data):
    values = bech32_hrp_expand(hrp) + data
    polymod = bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]

def bech32_encode(hrp, data):
    combined = data + bech32_create_checksum(hrp, data)
    return hrp + "1" + "".join([CHARSET[d] for d in combined])

def convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret

addr = sys.argv[1].strip()
if addr.startswith("0x") or addr.startswith("0X"):
    addr = addr[2:]
if len(addr) != 40:
    raise SystemExit("invalid eth address length")
raw = bytes.fromhex(addr)
data5 = convertbits(raw, 8, 5, True)
print(bech32_encode("nil", data5))
PY
)"

echo "EVM: $EVM_ADDRESS"
echo "NIL: $NIL_ADDRESS"
```

Fund the NIL address (local faucet):

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d "{\"address\":\"$NIL_ADDRESS\"}" \
  "$FAUCET_BASE/faucet"
```

If you are following **Profile A (script parity)**, create the deal via the gateway relay endpoint:

```bash
CREATE_RESP="$(curl -sS -X POST -H "Content-Type: application/json" -d "$CREATE_PAYLOAD" \
  "$GATEWAY_BASE/gateway/create-deal-evm")"
DEAL_ID="$(python3 - <<PY
import json
print(json.loads('''$CREATE_RESP''')["deal_id"])
PY
)"
echo "Deal ID: $DEAL_ID"
```

### 2.2 Upload + commit content

Upload a file into the deal (captures a new `manifest_root` / NilFS slab state):

```bash
UPLOAD_FILE="${UPLOAD_FILE:-README.md}"
FILE_PATH="$(basename "$UPLOAD_FILE")"
UPLOAD_RESP="$(curl -sS -X POST -F "file=@$UPLOAD_FILE" -F "owner=$NIL_ADDRESS" \
  "$GATEWAY_BASE/gateway/upload?deal_id=$DEAL_ID")"

MANIFEST_ROOT="$(python3 - <<PY
import json
j=json.loads('''$UPLOAD_RESP''')
print(j.get("manifest_root") or j.get("cid") or "")
PY
)"
SIZE_BYTES="$(python3 - <<PY
import json
j=json.loads('''$UPLOAD_RESP''')
print(j.get("size_bytes") or j.get("sizeBytes") or "")
PY
)"
FILE_SIZE_BYTES="$(python3 - <<PY
import json
j=json.loads('''$UPLOAD_RESP''')
print(j.get("file_size_bytes") or j.get("fileSizeBytes") or "")
PY
)"
TOTAL_MDUS="$(python3 - <<PY
import json
j=json.loads('''$UPLOAD_RESP''')
print(j.get("total_mdus") or j.get("totalMdus") or j.get("allocated_length") or "")
PY
)"
WITNESS_MDUS="$(python3 - <<PY
import json
j=json.loads('''$UPLOAD_RESP''')
print(j.get("witness_mdus") or j.get("witnessMdus") or "")
PY
)"
echo "manifest_root=$MANIFEST_ROOT size_bytes=$SIZE_BYTES file_size_bytes=$FILE_SIZE_BYTES total_mdus=$TOTAL_MDUS witness_mdus=$WITNESS_MDUS"
```

Commit the content (Profile A relay path; mirrors `scripts/e2e_lifecycle.sh`):

```bash
UPDATE_PAYLOAD=$(
  NONCE=2 \
  DEAL_ID="$DEAL_ID" \
  PREVIOUS_MANIFEST_ROOT="$(curl -sS "$LCD_BASE/nilchain/nilchain/v1/deals/$DEAL_ID" | jq -r '.deal.manifest_root // ""')" \
  CID="$MANIFEST_ROOT" \
  SIZE_BYTES="$SIZE_BYTES" \
  TOTAL_MDUS="$TOTAL_MDUS" \
  WITNESS_MDUS="$WITNESS_MDUS" \
  nil-website/node_modules/.bin/tsx nil-website/scripts/sign_intent.ts update-content
)
curl -sS -X POST -H "Content-Type: application/json" -d "$UPDATE_PAYLOAD" \
  "$GATEWAY_BASE/gateway/update-deal-content-evm"
```

The signed update intent now carries both `previous_manifest_root` and `manifest_root`; the relay and chain reject stale swaps.

Verify on chain (LCD):

```bash
curl -sS "$LCD_BASE/nilchain/nilchain/v1/deals/$DEAL_ID" | python3 -m json.tool
```

### 2.3 Plan + open a retrieval session (mandatory)

Plan the blob-range and provider for your file:

```bash
ENC_FILE_PATH="$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote('''$FILE_PATH'''))
PY
)"
PLAN_RESP="$(curl -sS \
  "$GATEWAY_BASE/gateway/plan-retrieval-session/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$NIL_ADDRESS&file_path=$ENC_FILE_PATH&range_start=0&range_len=$FILE_SIZE_BYTES")"

PROVIDER_ADDR="$(python3 - <<PY
import json
print(json.loads('''$PLAN_RESP''')["provider"])
PY
)"
START_MDU_INDEX="$(python3 - <<PY
import json
print(json.loads('''$PLAN_RESP''')["start_mdu_index"])
PY
)"
START_BLOB_INDEX="$(python3 - <<PY
import json
print(json.loads('''$PLAN_RESP''')["start_blob_index"])
PY
)"
BLOB_COUNT="$(python3 - <<PY
import json
print(json.loads('''$PLAN_RESP''')["blob_count"])
PY
)"
echo "provider=$PROVIDER_ADDR start_mdu_index=$START_MDU_INDEX start_blob_index=$START_BLOB_INDEX blob_count=$BLOB_COUNT"
```

Open the retrieval session on-chain (precompile tx):

```bash
HEIGHT="$(curl -sS http://127.0.0.1:26657/status | python3 -c \"import sys,json; print(int(json.load(sys.stdin)['result']['sync_info']['latest_block_height']))\")"
SESSION_EXPIRES_AT="$((HEIGHT + 20))"
SESSION_NONCE="$(python3 -c 'import time; print(time.time_ns())')"

SESSION_OPEN_JSON=$(
  DEAL_ID="$DEAL_ID" \
  PROVIDER="$PROVIDER_ADDR" \
  MANIFEST_ROOT="$MANIFEST_ROOT" \
  START_MDU_INDEX="$START_MDU_INDEX" \
  START_BLOB_INDEX="$START_BLOB_INDEX" \
  BLOB_COUNT="$BLOB_COUNT" \
  NONCE="$SESSION_NONCE" \
  EXPIRES_AT="$SESSION_EXPIRES_AT" \
  EVM_PRIVKEY="$EVM_PRIVKEY" \
  EVM_RPC="$EVM_RPC" \
  EVM_CHAIN_ID="$EVM_CHAIN_ID" \
  nil-website/node_modules/.bin/tsx nil-website/scripts/open_retrieval_session.ts
)
SESSION_ID="$(python3 - <<PY
import json
print(json.loads('''$SESSION_OPEN_JSON''')["session_id"])
PY
)"
echo "session_id=$SESSION_ID"
```

### 2.4 Sign fetch request + fetch bytes (range-gated)

Sign the fetch request (EIP-712) for the file range:

```bash
REQ_NONCE=1
REQ_EXPIRES_AT="$(( $(date +%s) + 120 ))"
REQ_SIG_JSON=$(
  NONCE="$REQ_NONCE" \
  DEAL_ID="$DEAL_ID" \
  FILE_PATH="$FILE_PATH" \
  RANGE_START=0 \
  RANGE_LEN="$FILE_SIZE_BYTES" \
  EXPIRES_AT="$REQ_EXPIRES_AT" \
  nil-website/node_modules/.bin/tsx nil-website/scripts/sign_intent.ts sign-fetch-request
)
REQ_SIG="$(python3 - <<PY
import json
print(json.loads('''$REQ_SIG_JSON''')["evm_signature"])
PY
)"
```

Fetch bytes (requires the session id + signed request headers):

```bash
FETCH_URL="$GATEWAY_BASE/gateway/fetch/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$NIL_ADDRESS&file_path=$ENC_FILE_PATH"
RANGE_END="$((FILE_SIZE_BYTES - 1))"
curl -fsS -o fetched.bin "$FETCH_URL" \
  -H "X-Nil-Session-Id: $SESSION_ID" \
  -H "X-Nil-Req-Sig: $REQ_SIG" \
  -H "X-Nil-Req-Nonce: $REQ_NONCE" \
  -H "X-Nil-Req-Expires-At: $REQ_EXPIRES_AT" \
  -H "X-Nil-Req-Range-Start: 0" \
  -H "X-Nil-Req-Range-Len: $FILE_SIZE_BYTES" \
  -H "Range: bytes=0-$RANGE_END"

cmp -s "$UPLOAD_FILE" fetched.bin && echo "OK: fetched bytes match"
```

## 3. Retrieval proof across multiple SPs

Mirrors `scripts/e2e_gateway_retrieval_multi_sp.sh`:

1. Create a Mode2 deal using `General:rs=2+1` so the gateway splits shards across many SPs (`nilchain tx nilchain create-deal ... --service-hint "General:rs=2+1"`).
2. Upload and commit a 1 MiB payload via the router exactly as above.
3. Use `nilchain query nilchain get-deal --id <deal_id>` to read `providers[]` and choose the assigned provider that differs from the owner. Note its `endpoints[0]`.
4. Hit the router’s `/gateway/prove-retrieval` endpoint with JSON:
   ```json
   {
     "deal_id": <id>,
     "manifest_root": "<cid>",
     "file_path": "<filename>",
     "owner": "<nil address>",
     "provider": "<assigned provider address>",
     "epoch_id": <current epoch>
   }
   ```
   (The epoch can be computed via `curl http://127.0.0.1:26657/status`, matching the script’s `current_epoch` helper.)
5. Watch the gateway reply with a `tx_hash`. Use `nilchain query tx <hash>` to confirm the `MsgSubmitRetrievalProof` succeeded under the assigned provider key. This proves the router can reconstruct Mode2 MDUs and authorize cross-account receipts.

## 4. Deputy-led healing / repair validation

Following the latter half of `scripts/e2e_deputy_ghost_repair_multi_sp.sh`:

1. Create another deal (Mode2), upload/commit, and request a retrieval plan with `curl http://localhost:8080/gateway/plan-retrieval-session/<manifest>?deal_id=<id>&owner=<owner>&file_path=<file>&range_start=0&range_len=<bytes>`. Capture the returned provider; this is the planned slot owner.
2. Fetch bytes via `/gateway/fetch/...` using the owner signature. Inspect `X-Nil-Provider` in the response headers—if the planner routes around the busy slot, the header should show a deputy provider.
3. Submit a deputy session proof: POST to `/gateway/session-proof` with the same `session_id` and the deputy provider address. The gateway should reply `{"status":"success"}`.
4. Wait for the next epoch boundary (see the script’s `wait_for_height` logic) and inspect `nilchain query nilchain get-deal --id <id>` to confirm the targeted `mode2_slots` entry shows `status=REPAIRING` with a `pending_provider`.
5. Use the planner again to ensure it now returns the pending provider, proving the healing path defers traffic away from repairing slots.

## 5. Economics, slashing, and quotas

Manual checks derived from keeper tests:

- Query `nilchain query nilchain params` and `nilchain query nilchain list-deals` to examine `Params.max_drain_bytes_per_epoch`, `Params.max_repairing_bytes_ratio_bps`, and deal heat statistics.
- Execute `nilchain tx nilchain set-provider-draining <provider>` to test that new placement requests avoid that provider, as tested in `nilchain/x/nilchain/keeper/draining_test.go`.
- Open sponsored retrieval sessions and vouchers via `/gateway/plan-retrieval-session` + `/gateway/session-receipt`; inspect `nilchain query nilchain retrieval-sessions` to ensure quotas decrement just like `msg_server_sponsored_sessions_test.go`.
- Watch reward distribution by querying `nilchain query nilchain rewards` or running dedicated `go test ./nilchain/x/nilchain/keeper/base_rewards_test.go` for a reference baseline.

## 6. Keeping the runbook up to date

Whenever the scripts above change, mirror the updated commands back into this runbook. This doc should remain the human-readable companion to the scripted automation.
### Provisional generation retention

The gateway keeps newly uploaded NilFS generations in a provisional state until the signed chain swap succeeds.

- Default devnet retention: `24h`
- Override with: `NIL_PROVISIONAL_GENERATION_RETENTION_TTL`
- Disable age-based provisional GC: `NIL_PROVISIONAL_GENERATION_RETENTION_TTL=0`
- Browser/gateway/provider artifact uploads may send `X-Nil-Previous-Manifest-Root` to reject stale append bases before large upload bodies are consumed

Inspect the effective policy and current generation inventory with:

```bash
curl -s http://127.0.0.1:8080/status | jq '.extra | with_entries(select(.key | startswith("nilfs_generation_")))'

# Observe stale CAS / concurrent-writer pressure at the gateway preflight layer.
curl -s http://127.0.0.1:8080/status | jq '.extra | with_entries(select(.key | startswith("nilfs_cas_preflight_conflicts_")))'
```
