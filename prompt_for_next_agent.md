# Handoff State (December 16, 2025)

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

- [ ] **Goal 1: Chain Params & Fees.** (Start Here)
- [ ] **Goal 2: Refactor `CreateDeal` (Creation Fee).**
- [ ] **Goal 3: Refactor `UpdateDealContent` (Term Deposit).**
- [ ] **Goal 4: Retrieval Credits.**

## 3. Backlog & "Eventual" Goals (Deferred)

- **LibP2P in Browser:** Implement direct P2P connectivity (WebSocket/WebTransport) from the browser to the network.
- **UI/UX Overhaul:** Major design refresh.
- **Robust Gateway Fallback:** Smart toggle/fallback mechanism.
- **Native↔WASM Parity Tests:** Automated parity tests.

## 4. What the Next Agent Should Do First

1.  **Start Gamma-4:** Begin implementing `x/nilchain/types/params.go` for the economic upgrade.
    *   Define parameters for storage cost (e.g., `StoragePricePerBytePerBlock`).
    *   Define parameters for minimum lock-in duration.
2.  **Refactor CreateDeal:** Update `MsgCreateDeal` handler to deduct a "Creation Fee" (anti-spam) from the creator's balance.
3.  **Refactor UpdateDealContent:** Update `MsgUpdateDealContent` to calculate the "Term Deposit" (`Size * Duration * Price`) and transfer it to an escrow module/account.

## 5. Key Files

- **Roadmap:** `AGENTS.md` (Canonical).
- **Chain Params:** `nilchain/x/nilchain/types/params.go`.
- **Msg Server:** `nilchain/x/nilchain/keeper/msg_server.go`.

## 6. How to Run

- **Start Stack (Split Mode):** `./scripts/run_local_stack.sh start`.
- **Run Website Checks:** `sh verify_website_checks.sh`.
- **Run E2E Test:** `cd nil-website && npx playwright test tests/direct-upload.spec.ts`.