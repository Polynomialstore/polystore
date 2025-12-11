# Handoff State (December 11, 2025)

This file is the short brief for the next agent. The canonical, longer TODO list lives in `AGENTS.md` (see section **11. Active Agent Work Queue (Current)**).

## 1. High-Level State

- **Chain & EVM:**
  - `nilchaind` boots cleanly via `./scripts/run_local_stack.sh start` using Go at `/Users/michaelseiler/.gvm/gos/go1.25.5/bin/go`.
  - EVM JSON-RPC is active on `http://localhost:8545` with `evm-chain-id = 31337`.
  - `MsgCreateDealFromEvm` is **currently broken** due to syntax errors in `msg_server.go` introduced during an attempted fix for EIP-712 verification.
  - Deals now use `manifest_root` (48‑byte KZG commitment) + `size` instead of `cid`/tiers.

- **Gateway (`nil_s3`):**
  - `/gateway/upload`:
    - Default path (`NIL_FAST_SHARD=0`) runs full KZG/MDU triple-proof ingest via `IngestNewDeal` (`nil_s3/ingest.go`).
    - Returns JSON with `manifest_root` (48‑byte hex), `size_bytes`, and `allocated_length`.
    - It is **slow** right now (several minutes for ~2KB) but functionally correct.
  - `/gateway/create-deal-evm`:
    - Writes the EVM intent+signature into a temp JSON file and calls:
      - `nilchaind tx nilchain create-deal-from-evm <file> --broadcast-mode sync --output json`.
    - Parses the CLI JSON (or extracts the JSON body if prefixed with warnings) and then polls LCD at `/cosmos/tx/v1beta1/txs/<txhash>` to confirm success.
    - Extracts `deal_id` from events (type `create_deal` / `nilchain.nilchain.EventCreateDeal`), with a fallback to `query nilchain list-deals`.
  - `/gateway/update-deal-content-evm`:
    - **Recently fixed**: it now also polls LCD for the tx hash and returns `HTTP 500` with the `raw_log` if DeliverTx fails (e.g., unauthorized owner), instead of always returning `"status":"success"`.
    - Valid path:
      - Expects intent `{ creator_evm, deal_id, cid=manifest_root, size_bytes, nonce, chain_id }` and an EIP‑712 `UpdateContent` signature (matching `nil-website/src/hooks/useUpdateDealContent.ts` and `nilchain/x/nilchain/types/eip712.go`).
      - Calls `nilchaind tx nilchain update-deal-content-from-evm <file> --broadcast-mode sync --output json`.

- **Core (`nil_core`) & WASM:**
  - KZG field encoding and manifest commitment logic has been tightened to use canonical big-endian Fr encodings. Tests:
    - `utils::tests::z_for_cell_zero_is_one`
    - `utils::tests::frs_to_blobs_packs_scalars_in_order`
    - `tests/kzg_endianness_test.rs`
    - `tests/coding_expand_test.rs` (one heavy test ignored by default).
  - Mode 2 WASM expansion (`expand_mdu`) now first encodes raw bytes to a valid MDU (using `encode_to_mdu`) before applying RS(12,8) + KZG. This fixed prior `Invalid scalar` errors in the browser.

- **Frontend (`nil-website`):**
  - `useCreateDeal` and `useUpdateDealContent` both use EIP‑712 typed data that matches `nilchain/x/nilchain/types/eip712.go`.
  - Dashboard UI:
    - “Allocate capacity” (create deal) uses `/gateway/create-deal-evm`.
    - “Commit uploaded content” uses `/gateway/update-deal-content-evm` with the manifest root produced by `/gateway/upload`.
  - There is **no browser e2e suite yet** (Cypress/Playwright), only manual flows + shell scripts.

## 2. Known Issues / Open Threads

These are the key things that are currently not fully solved and should be top-of-mind for the next agent. They are also captured (in more detail) as checkboxes in `AGENTS.md` §11.

1. **EIP-712 Signature Verification & "Insufficient Funds" Error (CRITICAL):**
   - **Symptom:** `CreateDealFromEvm` fails with `insufficient funds` even though the faucet funded the account.
   - **Root Cause:** A Chain ID mismatch in the EIP-712 domain separator. `nilchaind` defaults to ChainID 1 (because parsing `intent.ChainId="test-1"` fails), while the Python/Client signs with EVM ChainID 31337. This causes `recoverEvmAddress` to return a wrong (random) address, which has 0 balance.
   - **Current State:** The file `nilchain/x/nilchain/keeper/msg_server.go` has been modified to hardcode `ChainID = 31337`, but the last edits introduced **syntax errors** (around lines 534-539 in `UpdateDealContentFromEvm`). The build is broken.
   - **Action Item:** Fix the syntax errors in `msg_server.go` and verify that the hardcoded ChainID fix works. Then verify the E2E lifecycle.

2. **Bridge deployment (`NilBridge.sol`) still failing:**
   - `scripts/deploy_bridge_local.sh` runs a Foundry script with `forge`, but broadcasts fail:
     - Initially: `insufficient funds` for deployer.
     - After adding a pre-funded bech32 account for the Foundry dev key and a shared `NIL_EVM_DEV_PRIVKEY` in `scripts/run_local_stack.sh`, broadcast now fails with `error code -32002: request timed out` from `eth_sendRawTransaction`.
   - `run_local_stack.sh` invokes the deploy script every start with `NIL_DEPLOY_BRIDGE=1` by default, but `_artifacts/bridge_address.txt` is never written.
   - NilBridge is therefore **not** yet available to the dashboard widgets; `VITE_BRIDGE_ADDRESS` remains unset or zero.

3. **End-to-end deal lifecycle is only partially covered by tests:**
   - We have:
     - `e2e_create_deal_from_evm.sh` which starts the stack and exercises `/gateway/create-deal-evm`, but:
       - It still assumes a `cid` field in deals and doesn’t align with the new `manifest_root/size` schema.
       - It uses a specific EVM key (0x4f3e…) that is not the same as the MetaMask key from the user’s curl (0xf793…); both work, but expectations aren’t unified.
   - There is **no single script** that does:
     - `upload` → `create-deal-evm` → `update-deal-content-evm` → LCD check → `fetch` verification.
   - `scripts/e2e_lifecycle.sh` was created to fill this gap but is currently blocked by the EIP-712 issue.

4. **Ownership semantics for `UpdateDealContentFromEvm`:**
   - Chain-side enforcement:
     - `CreateDealFromEvm` maps the EVM `creator_evm` into `deal.Owner` (bech32 of the EVM address bytes).
     - `UpdateDealContentFromEvm` recomputes the EIP‑712 digest, recovers the EVM signer, and maps it to a bech32 address; it then requires `deal.Owner == ownerAcc.String()`.
   - In manual testing, an update with a mismatched EVM key rightly fails with `only deal owner can update content: unauthorized`; after the gateway fix, this now surfaces as `HTTP 500` with the error text.
   - The next agent should make sure the **UI and tests are aligned on which EVM account is the “owner”** used for both create and update (and that MetaMask flows stick to that account).

## 3. What the Next Agent Should Do First

1. **Fix `msg_server.go` Syntax Errors:**
   - Open `nilchain/x/nilchain/keeper/msg_server.go`.
   - Go to `UpdateDealContentFromEvm` function (around line 530).
   - Fix the broken `HashUpdateContent` call structure. Ensure proper error handling and variable usage.
   - Verify that `eip712ChainID` is set to `big.NewInt(31337)` in both `CreateDealFromEvm` and `UpdateDealContentFromEvm`.

2. **Verify Fix with `e2e_lifecycle.sh`:**
   - Run `./scripts/e2e_lifecycle.sh`.
   - Ensure `nilchaind` compiles successfully.
   - Verify that the `CreateDeal` transaction succeeds (no "insufficient funds" or "exit status 1").
   - Verify that `UpdateDealContent` succeeds.

3. **Finish EVM UX for create + update (no bridge yet):**
   - Once the chain side is fixed, choose a single dev EVM key (ideally the one used in `e2e_create_deal_from_evm.sh`) and drive this sequence:
     - Start stack: `./scripts/run_local_stack.sh start`.
     - Upload a small file via `/gateway/upload` and capture `manifest_root` + `size_bytes`.
     - Create a deal via `/gateway/create-deal-evm` (either through the web UI using MetaMask or via the script).
     - Commit content via `/gateway/update-deal-content-evm` using an EIP‑712 signature for the same EVM owner and the manifest root from upload.
     - Confirm via LCD (`/nilchain/nilchain/v1/deals`) that `manifest_root` and `size` are updated, and that the dashboard shows a non-zero size for the deal.
   - If any step fails:
     - Inspect LCD tx responses directly (`/cosmos/tx/v1beta1/txs/<hash>`).
     - Fix either the EIP‑712 layer (`nilchain/x/nilchain/types/eip712.go`, hooks in `nil-website`, or payloads in scripts) or gateway parsing accordingly.

## 4. Key Files to Look At

- **Agent / roadmap context:**
  - `AGENTS.md` (esp. section 11 for the active work queue).

- **Gateway & ingest:**
  - `nil_s3/main.go` — gateway handlers (upload, create/update deal, EVM flows).
  - `nil_s3/ingest.go` — `IngestNewDeal` triple-proof MDU logic.
  - `nil_s3/pkg/builder/builder.go`, `nil_s3/pkg/layout/layout.go` — NilFS MDU #0 format and builder.

- **Chain & EVM:**
  - `nilchain/x/nilchain/keeper/msg_server.go` — `CreateDeal`, `CreateDealFromEvm`, `UpdateDealContent`, `UpdateDealContentFromEvm`.
  - `nilchain/x/nilchain/types/eip712.go` — EIP‑712 hashing (domain + CreateDeal/UpdateContent).
  - `nilchain/x/nilchain/types/evm_bridge.go` — legacy string-based EVM message builders (currently superseded by EIP‑712, but useful for context).

- **Frontend:**
  - `nil-website/src/config.ts` — chain IDs, gateway base, bridge address.
  - `nil-website/src/hooks/useCreateDeal.ts` — EIP‑712 CreateDeal typed data + gateway POST.
  - `nil-website/src/hooks/useUpdateDealContent.ts` — EIP‑712 UpdateContent typed data + gateway POST.
  - `nil-website/src/components/Dashboard.tsx`, `DealDetail.tsx` — deal list and size display.

- **Core / WASM:**
  - `nil_core/src/utils.rs`, `nil_core/src/kzg.rs`, `nil_core/src/coding.rs`.
  - `nil_core/tests/kzg_endianness_test.rs`, `nil_core/tests/coding_expand_test.rs`.

## 5. How to Run Things

- Start/stop the local stack:
  - `./scripts/run_local_stack.sh start`
  - `./scripts/run_local_stack.sh stop`
- Hit key endpoints:
  - LCD node info: `curl http://localhost:1317/cosmos/base/tendermint/v1beta1/node_info`
  - List deals: `curl http://localhost:1317/nilchain/nilchain/v1/deals`
  - Upload: `curl -F 'file=@README.md' -F 'owner=<nil-address>' http://localhost:8080/gateway/upload`
  - Create deal (EVM): see `e2e_create_deal_from_evm.sh` or use the UI.
  - Update content (EVM): send manifest root + size to `/gateway/update-deal-content-evm` using a valid EIP‑712 signature.

When picking up this work, please also review the latest edits to `AGENTS.md` so that any new tasks you complete are checked off there and in this handoff file.*** End Patch
