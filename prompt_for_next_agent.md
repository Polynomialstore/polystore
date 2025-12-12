# Handoff State (December 12, 2025)

This file is the short brief for the next agent. The canonical, longer TODO list lives in `AGENTS.md` (see section **11. Active Agent Work Queue (Current)**).

## 1. High-Level State

- **Chain & EVM:**
  - `nilchaind` boots cleanly via `./scripts/run_local_stack.sh start`.
  - **Syntax Errors Fixed:** `msg_server.go` is now correct and `UpdateDealContentFromEvm` works as expected with EIP-712.
  - **Account Sequence Mismatch Fixed:** `nil_s3` gateway now includes a retry mechanism for `tx` commands, making it robust against race conditions.
  - **Bridge Deployed:** `NilBridge.sol` is successfully deployed to the local EVM. The address is written to `_artifacts/bridge_address.txt` and exported to the web UI.

- **Gateway (`nil_s3`):**
  - **Robustness:** Added `runTxWithRetry` to handle "account sequence mismatch" errors automatically.
  - **E2E Lifecycle:** Confirmed working via `./scripts/e2e_lifecycle.sh`. Full flow: Create Deal (EVM) -> Upload -> Update Content (EVM) -> Fetch.

- **Frontend (`nil-website`):**
  - **Wagmi/Viem:** Dependencies installed.
  - **Bridge Config:** `VITE_BRIDGE_ADDRESS` is correctly wired in `src/config.ts`.
  - **Pending:** "Connect MetaMask" button and direct interaction with the deployed bridge contract.

## 2. Known Issues / Open Threads

1. **Frontend EVM Integration (Primary Focus):**
   - The infrastructure is ready, but the UI lacks the "Connect Wallet" button and logic to invoke the bridge.
   - **Action Item:** Implement the wallet connection flow using Wagmi/Viem and add a simple interaction with `NilBridge` (e.g., viewing deal status or creating a deal via contract).

2. **Protocol Cleanup:**
   - Dynamic Sizing (removing Tiers) is still a pending roadmap item but not blocking immediate devnet usage.

## 3. What the Next Agent Should Do First

1. **Implement Wallet Connection:**
   - Add a "Connect MetaMask" button to the dashboard.
   - Display the connected user's NIL balance (from `aatom` or `stake` on the EVM side).

2. **Test Bridge Interaction:**
   - Use the `useContractWrite` or similar Wagmi hooks to interact with `NilBridge` at `VITE_BRIDGE_ADDRESS`.
   - Verify that a user can initiate a transaction from the UI that hits the local EVM.

3. **Browser E2E:**
   - Once the UI is interactive, add a Playwright/Cypress test to verify the "Connect -> Create Deal" flow in a real browser environment.

## 4. Key Files to Look At

- **Agent / roadmap context:** `AGENTS.md`.
- **Frontend:** `nil-website/src/App.tsx`, `nil-website/src/components/Dashboard.tsx`, `nil-website/src/config.ts`.
- **Gateway:** `nil_s3/main.go` (reference for how the backend handles deals).

## 5. How to Run Things

- Start/stop the local stack:
  - `./scripts/run_local_stack.sh start` (Deploys bridge automatically)
- Run E2E verification (Backend/CLI):
  - `./scripts/e2e_lifecycle.sh`
*** End Patch
