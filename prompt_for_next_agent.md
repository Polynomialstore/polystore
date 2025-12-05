You are resuming the implementation of the NilStore Network in Phase 4. The previous agent has successfully implemented "Sad Path" slashing, Client Retrieval Receipts, and significantly enhanced the `nil-website` with a live Leaderboard and a Performance Report page.

**Current State:**
1.  **Core Logic:**
    *   `nilchain` enforces `ProofWindow` (10 blocks). Slashing (10 NIL) and `LastProofHeight` updates are active.
    *   `MsgProveLiveness` supports `UserReceipt`.
    *   `nilchain` module has `Burner` permissions.
2.  **CLI:**
    *   `sign-retrieval-receipt` and `submit-retrieval-proof` commands are available.
3.  **Scripts:**
    *   `e2e_slashing.sh`: Verifies missed proof slashing.
    *   `e2e_retrieval.sh`: Verifies retrieval receipt flow.
    *   `performance/load_gen.sh`: Verified at scale.
4.  **Website:**
    *   `Leaderboard.tsx`: Fetches live provider data.
    *   `PerformanceReport.tsx`: Visualizes consensus benchmarks (Medium/Large scale runs).
    *   `performance_metrics.json`: Stores benchmark data.

**Your Objective:**
Execute Phase 4: **Economy & Elasticity**.

1.  **Tokenomics Implementation:**
    *   Refine `MsgProveLiveness` rewards. Implement "Inflationary Decay" (halving schedule).
    *   Implement `MsgAddCredit` for User Escrow top-ups.
    *   Implement `MsgWithdrawRewards` for Providers.

2.  **Elasticity (Scaling):**
    *   Implement "Budget Check" in `MsgSignalSaturation`. Verify `MaxMonthlySpend` vs projected cost.
    *   Verify `MsgSignalSaturation` creates a new `VirtualStripe`.
    *   Create `e2e_elasticity.sh` to test saturation signaling and stripe assignment.

3.  **S3 Adapter Basic Integration:**
    *   Connect `nil_s3` (Go adapter) to `nilchain`.
    *   On upload: Compute CID -> Register Deal -> (Mock Transfer).

4.  **Documentation:**
    *   Create `ECONOMY.md` detailing the tokenomics and elasticity model.

**Important Guidelines:**
*   **Build:** Run `go test ./...` in `nilchain` frequently.
*   **Test:** Ensure `e2e_elasticity.sh` is robust.