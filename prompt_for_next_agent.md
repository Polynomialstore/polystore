You are resuming the implementation of the NilStore Network in Phase 5. The previous agent has successfully implemented the Tokenomics (Inflationary Decay, Escrow, Rewards), Elasticity (Budget Checks), and a basic S3 Adapter. The Website now features a detailed Performance Report linked to the official Test Plan.

**Current State:**
1.  **Core Logic:**
    *   `ProveLiveness` uses Inflationary Decay. Rewards accumulate in `ProviderRewards`.
    *   `SignalSaturation` enforces `MaxMonthlySpend`.
    *   New messages `AddCredit` and `WithdrawRewards` are active.
    *   Parameters `BaseStripeCost` and `HalvingInterval` are now governable via `MsgUpdateParams`.
2.  **CLI:**
    *   Economy commands (`signal-saturation`, `add-credit`, `withdraw-rewards`) integrated.
3.  **S3 Adapter:**
    *   `nil_s3` uploads shards, computes CID via `nil_cli`, and creates deals on-chain.
4.  **Website:**
    *   `PerformanceReport.tsx` includes context from `PERFORMANCE_TEST_PLAN.md` and links to GitHub.
5.  **Scripts:**
    *   `e2e_elasticity.sh` verified (replication cap logic works).
    *   `e2e_flow.sh` verified.

**Your Objective:**
Execute Phase 5: **Final Polish & Release Prep**.

1.  **Advanced Features (Optional):**
    *   **Reputation System:** Add `UptimeScore` to `Provider` struct. Update it in `ProveLiveness` (increment on success, decrement/reset on slash).
    *   **Deal Expiry:** Implement logic in `EndBlock` (or a separate cleanup loop) to mark expired deals as "Expired" or free up capacity.

2.  **Documentation & Website:**
    *   Update `README.md` with instructions for the S3 Adapter and Elasticity tests.
    *   Review and finalize `whitepaper.md` and `litepaper.md` if needed.

3.  **Distribution:**
    *   Create a `release.sh` script. It should:
        *   Run `make proto-gen` in `nilchain`.
        *   Build `nil_core` (release mode).
        *   Build `nilchaind` (linking to release core).
        *   Build `nil_cli` and `nil_s3`.
        *   Package everything into a `dist/` folder (tarball).

4.  **Final Verification:**
    *   Run `e2e_flow.sh` one last time with the release binaries.

**Important Guidelines:**
*   **Quality:** Ensure no linting errors.
*   **Stability:** The `release.sh` script must produce a working set of binaries that can be distributed.