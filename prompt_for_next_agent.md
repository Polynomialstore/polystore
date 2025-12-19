# Handoff State (December 19, 2025)

This file is the short brief for the next agent. The canonical, longer TODO list lives in `AGENTS.md` (see section **11. Active Agent Work Queue (Current)**).

## 1. High-Level State

- **Devnet Gamma-2 (Thick Client):** **COMPLETE**.
- **Devnet Gamma-3 (Direct Transport & EVM Integration):** **COMPLETE & VERIFIED**.
  - **Direct Upload:** Frontend shards files locally (WASM) and uploads MDUs directly to the Storage Provider (SP) on port 8082.
  - **Direct Commit:** Frontend calls the NilStore EVM Precompile (`updateDealContent`) directly via MetaMask/Wagmi.
  - **Verification:** `tests/direct-upload.spec.ts` passes, confirming the "Expand -> Upload -> Commit" flow and fixing the 0-byte upload regression.
  - **Fixes:** `FileSharder.tsx` buffer detachment bug fixed. `direct-upload.spec.ts` hardened with `eth_sendTransaction` payload validation.

## 2. Active Sprint: Devnet Gamma-4 (Economic Upgrade)

**Objective:** Implement the "Lock-in" pricing model on-chain, requiring `UpdateDealContent` to pay for storage duration upfront.

- [x] **Goal 1: Update `spec.md` for Gamma-4 economics (lock-in pricing + retrieval fees).**
  - Retrieval credits are explicitly **out of scope** for Gamma-4.
- [x] **Goal 2: Chain Params & Fees (Retrieval).**
  - Added: `base_retrieval_fee` (`Coin`, provisional devnet default `1stake`), `retrieval_price_per_blob` (`Coin`, 128KiB unit, provisional devnet default `1stake`), `retrieval_burn_bps` (`uint64`, default 500 = 5%).
- [x] **Goal 3: Refactor `CreateDeal` (Creation Fee).**
  - Implemented for both `MsgCreateDeal` and `MsgCreateDealFromEvm` (fee collector destination), with unit tests.
- [x] **Goal 4: Refactor `UpdateDealContent` (Term Deposit).**
  - Implemented for both `MsgUpdateDealContent` and `MsgUpdateDealContentFromEvm` (`ceil(price * delta_size * duration)`), with unit tests.
- [x] **Goal 5: Retrieval Fees (Lock + Pay Provider + Burn).**
  - `OpenRetrievalSession`: burn `base_retrieval_fee` (non-refundable) + lock `variable = retrieval_price_per_blob * blob_count`.
  - Funds remain locked until session `COMPLETED` (no payout if provider proves but user never confirms).
  - On `COMPLETED`: burn `ceil(variable * burn_bps / 10000)` and transfer the remainder to the provider.
  - Added `MsgCancelRetrievalSession` (owner-only) to unlock `variable` after expiry when not completed.

## 3. Backlog & "Eventual" Goals (Deferred)

- **LibP2P in Browser:** Implement direct P2P connectivity (WebSocket/WebTransport) from the browser to the network.
- **UI/UX Overhaul:** Major design refresh.
- **Robust Gateway Fallback:** Smart toggle/fallback mechanism.
- **Native↔WASM Parity Tests:** Automated parity tests.

## 4. What the Next Agent Should Do First

1.  **Run Gamma-4 smoke checks:** `go test ./x/nilchain/keeper` (retrieval fee tests included).
2.  **Optional UX/CLI:** add a `cancel-retrieval-session` CLI command if needed for devnet ops.
3.  **Coverage expansion note:** If you want me to expand coverage further, I can add a CLI-level integration test around open-retrieval-session with a local chain harness.

## 5. Key Files

- **Roadmap:** `AGENTS.md` (Canonical).
- **Chain Params:** `nilchain/x/nilchain/types/params.go`.
- **Msg Server:** `nilchain/x/nilchain/keeper/msg_server.go`.
- **Retrieval Session types:** `nilchain/proto/nilchain/nilchain/v1/types.proto`.

## 6. How to Run

- **Start Stack (Split Mode):** `./scripts/run_local_stack.sh start`.
- **Run Website Checks:** `sh verify_website_checks.sh`.
- **Run E2E Test:** `cd nil-website && npx playwright test tests/direct-upload.spec.ts`.
- **Run Retrieval Session CLI E2E:** `./e2e_open_retrieval_session_cli.sh`.
