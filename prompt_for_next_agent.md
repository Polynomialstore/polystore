# Critical: Validate UX & E2E Reliability

The previous sprint successfully fixed EIP-712 signing and network configuration, allowing deals to be created and content to be committed via the web UI. However, the UI is not updating to reflect these changes, and there are discrepancies in data display.

**Goal:** Fix the UI state management and verify the entire pipeline with a rigorous End-to-End (E2E) test.

## 1. Investigation Tasks
*   **UI Updates:** The "Success" toast appears, but the Dashboard list does not refresh (or takes too long). Investigate `nil-website/src/components/Dashboard.tsx` and the `useDeals` hook. Ensure they are polling the correct endpoint and handling the response correctly.
*   **Size Mismatch:** User reports deals created as "4GB" (Tier 1) show as "512GB" in the UI. Check `Dashboard.tsx` or the Gateway response mapping. Ensure the `DealSize` enum (1, 2, 3) is correctly mapped to labels.

## 2. E2E Test Construction
You must build a new test script (e.g., `tests/e2e_full_stack.sh` or Python) that validates the **Happy Path** without manual UI clicking. 

**Test Requirements:**
1.  **Setup:** Start the local stack (`./scripts/run_local_stack.sh`).
2.  **Act (Deal):** Use `curl` or a helper script to call the Gateway endpoint `/gateway/create-deal-evm` directly (simulating the frontend). You will need to construct a valid EIP-712 signature (use `nil-website/debug_final_original.js` logic or a Python script using `web3.py`/`eth_account`).
3.  **Verify (Deal):** Poll the Gateway or LCD (`http://localhost:1317/nilchain/nilchain/v1/deals/{id}`) to confirm the deal exists and `deal_id` is returned.
4.  **Act (Content):** Call `/gateway/upload` (multipart) to get a CID, then call `/gateway/update-deal-content-evm` with the signature.
5.  **Verify (Content):** Query the deal again to ensure `manifest_root` (CID) is updated and `size` matches the uploaded file.
6.  **Verify (Size):** explicitly assert that `capacity_tier` or mapped size matches the input (e.g., if input was Tier 1, result is 4GB, not 512GB).

## 3. Mandates
*   **Use the E2E test as the source of truth.** Do not rely on "it looks okay" in the browser. If the script passes, the backend is solid. Then fix the React UI to match the backend reality.
*   **Fix the EIP-712 Signing in Test:** Your test script needs to generate valid signatures. Use the findings from `debug_final_original.js` (Metamask sorts fields, uses correct chain ID).

## Context
*   **Chain ID:** `31337`
*   **Gateway:** `http://localhost:8080`
*   **LCD:** `http://localhost:1317`
*   **Backend:** `nilchaind` (Cosmos SDK)
*   **EIP-712 Domain:** `NilStore`, Version `1`, VerifyingContract `0x00...00`.