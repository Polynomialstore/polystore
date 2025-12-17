# Handoff State (December 16, 2025)

This file is the short brief for the next agent. The canonical, longer TODO list lives in `AGENTS.md` (see section **11. Active Agent Work Queue (Current)**).

## 1. High-Level State

- **Devnet Gamma-2 (Thick Client):** **COMPLETE**.
  - Browser-side OPFS storage, WASM worker harness, and "Green Dot" local gateway detection implemented.
  - Unit test discovery and E2E wallet injection bugs fixed.

- **Devnet Gamma-3 (Direct Transport & EVM Integration):** **COMPLETE**.
  - **Direct Upload:** Frontend shards files locally (WASM) and uploads MDUs directly to the Storage Provider (SP) on port 8082.
  - **Direct Commit:** Frontend calls the NilStore EVM Precompile (`updateDealContent`) directly via MetaMask/Wagmi.
  - **UI/UX:** `FileSharder.tsx` enforces a linear "Expand -> Upload -> Commit" flow with clear status indicators.
  - **Backend:** `nil_gateway` (SP mode) exposes `POST /sp/upload_mdu` with CORS headers.
  - **Infrastructure:** `run_local_stack.sh` runs separate SP (8082) and User (8080) gateway processes.

- **Pending Actions:**
  - **CRITICAL:** A commit script `commit_yolo_fixes.sh` exists in the root but hasn't been run due to environment restrictions. It contains the final fixes for CORS headers, UI flow, and Playwright tests. **Run this script immediately.**

## 2. Active Sprint: Devnet Gamma-4 (Economic Upgrade)

**Objective:** Implement the "Lock-in" pricing model on-chain, requiring `UpdateDealContent` to pay for storage duration upfront.

- [ ] **Goal 1: Chain Params & Fees.**
- [ ] **Goal 2: Refactor `CreateDeal` (Creation Fee).**
- [ ] **Goal 3: Refactor `UpdateDealContent` (Term Deposit).**
- [ ] **Goal 4: Retrieval Credits.**

## 3. Backlog & "Eventual" Goals (Deferred)

- **LibP2P in Browser:** Implement direct P2P connectivity (WebSocket/WebTransport) from the browser to the network, removing the need for HTTP intermediaries. (Deferred to Phase 4/5).
- **UI/UX Overhaul:** A major design refresh is planned. Current UI improvements should be functional and minimal ("dumb layer") until then.
- **Robust Gateway Fallback:** Eventually implement a smart toggle/fallback mechanism so the UI tries "Direct to SP" first, but falls back to "Gateway Proxy" if direct connection fails (CORS/Network).
- **Native↔WASM Parity Tests:** Add automated tests to ensure Rust `nil_core` and WASM output identical KZG commitments for fixed fixtures.

## 4. What the Next Agent Should Do First

1.  **Execute Pending Commits:** Run `sh commit_yolo_fixes.sh` to push the final Gamma-3 fixes.
2.  **Verify Gamma-3:** Run `npx playwright test tests/direct-upload.spec.ts` to confirm the Thick Client flow.
3.  **Start Gamma-4:** Begin implementing `x/nilchain/types/params.go` for the economic upgrade.

## 5. Key Files

- **Roadmap:** `AGENTS.md` (Canonical).
- **Thick Client UI:** `nil-website/src/components/FileSharder.tsx`.
- **Backend Upload:** `nil_gateway/main.go`.
- **Chain Logic (Next Sprint):** `nilchain/x/nilchain/keeper/msg_server.go`.

## 6. How to Run

- **Start Stack (Split Mode):** `./scripts/run_local_stack.sh start`.
- **Run Website Checks:** `sh verify_website_checks.sh`.
- **Run New E2E Test:** `cd nil-website && npx playwright test tests/direct-upload.spec.ts`.
