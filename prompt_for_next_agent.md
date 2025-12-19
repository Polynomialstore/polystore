# Handoff State (December 19, 2025)

This file is the short brief for the next agent. The canonical, longer TODO list lives in `AGENTS.md` (see section **11. Active Agent Work Queue (Current)**).

## 1. High-Level State

- **Devnet Gamma-2 (Thick Client):** **COMPLETE**.
- **Devnet Gamma-3 (Direct Transport & EVM Integration):** **COMPLETE & VERIFIED**.
  - **Direct Upload:** Frontend shards files locally (WASM) and uploads MDUs directly to the Storage Provider (SP) on port 8082.
  - **Direct Commit:** Frontend calls the NilStore EVM Precompile (`updateDealContent`) directly via MetaMask/Wagmi.
  - **Verification:** `tests/direct-upload.spec.ts` passes, confirming the "Expand -> Upload -> Commit" flow and fixing the 0-byte upload regression.
  - **Fixes:** `FileSharder.tsx` buffer detachment bug fixed. `direct-upload.spec.ts` hardened with `eth_sendTransaction` payload validation.
- **Devnet Gamma-4 (Economic Upgrade):** **COMPLETE**.
  - Retrieval credits remain explicitly out-of-scope for Gamma-4.

## 2. Next Sprint: Devnet Gamma-Delta (Gateway Fallback + Native/WASM Parity)

**Gateway fallback is only partially done. We have:**
- Local gateway detection + green‑dot widget (`useLocalGateway`, `GatewayStatusWidget`).
- OPFS fallback paths in `DealDetail.tsx` for showing local slab/manifest data.

**What’s still missing for a “robust fallback”:**
- No unified routing layer that automatically switches upload/fetch between local gateway, direct‑to‑SP, and chain precompile.
- No retry policy or error classification to trigger fallback.
- No user‑visible “fallback decision” state (or manual override) for upload/retrieval flows.

**Native↔WASM parity tests are not done:**
- There are unit tests for WASM pieces (e.g., `Mdu0Builder`), but no automated parity checks comparing native outputs to WASM outputs across key flows (`expand_mdu`, manifest commitments, proofs).
- There is no CI job for parity.

## 3. PM-Level Backlog (Priority Buckets)

**P0 (Highest):**
- LibP2P browser.
- UI/UX overhaul of dashboard.

**P1 (Medium):**
- Synchronize specs to code + TODOs.
  - Synchronize whitepaper and litepaper.
- Improve website overall: audit accessible pages, remove/replace/add necessary pages.

**P2 (Lower):**
- Mode 2 RS parity.
- Require regular proofs from SPs.
- Formalize block rewards.
- Formalize strikes against SPs who don't give proofs.
- Strengthen retrieval process against deviations from happy path (including "deputy" system).

**P10 (Lowest):**
- Revisit retrieval credits later (explicitly out‑of‑scope for Gamma‑4).

## 4. What the Next Agent Should Do First

1.  Align on Gamma‑Delta plan (gateway fallback routing + native↔WASM parity tests).
2.  Confirm CI is green after the new E2E coverage.

## 5. Key Files

- **Roadmap:** `AGENTS.md` (Canonical).
- **Chain Params:** `nilchain/x/nilchain/types/params.go`.
- **Msg Server:** `nilchain/x/nilchain/keeper/msg_server.go`.
- **Retrieval Session types:** `nilchain/proto/nilchain/nilchain/v1/types.proto`.
- **E2E scripts:** `e2e_retrieval_fees.sh`, `e2e_open_retrieval_session_cli.sh`.

## 6. How to Run

- **Start Stack (Split Mode):** `./scripts/run_local_stack.sh start`.
- **Run Website Checks:** `sh verify_website_checks.sh`.
- **Run E2E Test:** `cd nil-website && npx playwright test tests/direct-upload.spec.ts`.
- **Run Retrieval Fees E2E:** `./e2e_retrieval_fees.sh`.
- **Run Retrieval Session CLI E2E:** `./e2e_open_retrieval_session_cli.sh`.
