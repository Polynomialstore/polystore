# Manual Devnet Runbook

This document translates the guarded end-to-end scripts into a human‑operable checklist. Run the standard stack once (`./scripts/run_local_stack.sh start`), then follow the sections below in order to exercise lifecycle, retrieval, healing, and economic behaviors manually.

## 1. Prerequisites

1. Build or ensure the local tools are available (`nilchain/nilchaind`, gateway binary, `tsx` helper, etc.).
2. Start the canonical devnet stack. The script now brings up a minimal faucet by default (auto-funding and relay remain disabled) so you can interact manually:
   ```bash
   ./scripts/run_local_stack.sh start
   ```
   This launches CometBFT + EVM chain, faucet, router, and SP gateways configured for multi‑SP scenarios.
3. Confirm health endpoints are returning 200 (LCD `/cosmos/base/tendermint/v1beta1/node_info`, gateway `/gateway/create-deal-evm`), as done by `scripts/e2e_lifecycle.sh`.

## 2. Manual lifecycle smoke (Create → Upload → Commit → Fetch)

Use the same steps as `scripts/e2e_lifecycle.sh`, but type the commands yourself:

- **Derive the dev keypair** (EVM + `nil` addresses) using `python3` with `eth-account` (see the script’s `python3` block). Fund the resulting `nil` address through `curl -X POST $FAUCET_BASE/faucet`.
- **Create the deal**:
  ```bash
  CREATE_PAYLOAD=$(CHAIN_ID=test-1 EVM_CHAIN_ID=31337 \
    tsx nil-website/scripts/sign_intent.ts create-deal)
  curl -X POST -H "Content-Type: application/json" -d "$CREATE_PAYLOAD" http://localhost:8080/gateway/create-deal-evm
  ```
  Retry on nonce / bridge mismatch just like the script’s loop.
- **Upload content**: `curl -X POST -F "file=@<path>" -F "owner=<nil addr>" http://localhost:8080/gateway/upload?deal_id=<id>`.
  Capture `manifest_root`, `size_bytes`, `total_mdus`, `witness_mdus`.
- **Commit content** through `nilchain tx nilchain update-deal-content --deal-id ... --cid ... --size ... --total-mdus ... --witness-mdus ...`.
- **Fetch & verify**: `curl` the gateway fetch endpoint with `deal_id`, `owner`, and `file_path` to confirm bytes match the upload. Use the raw bytes output to `cmp`.
- **Double-check on-chain state** with `nilchain query nilchain get-deal --id <deal_id>` to ensure the manifest root matches and the deal owner/slots look healthy.

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
