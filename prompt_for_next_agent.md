This is a continuation of the NilStore Network project (Phase 3).

**Context:**
- **Project:** A decentralized storage network with a Cosmos SDK L1 (`nilchain`) and a Rust/libp2p Storage Node (`nil_p2p`).
- **Current State:** 
    - Phase 2 (Devnet) is complete and working.
    - Phase 3 (Incentives & Bridge) is in progress.
    - We have defined `MsgSubmitProof` in `nilchain` to verify storage proofs using a Rust library (`nil_core`) via FFI/CGO.
    - The FFI bindings (`x/crypto_ffi`) and the Msg handler (`keeper/msg_server_submit_proof.go`) are implemented.
- **Current Problem:** The `nilchain` Go build (`ignite chain build`) is failing due to **unused imports** in the auto-generated files (`x/nilchain/module/depinject.go` and `simulation.go`).

**Your Task:**
1.  **Fix the Build:** Open `nilchain/x/nilchain/module/depinject.go` and `nilchain/x/nilchain/module/simulation.go`. Remove the unused imports (like `cosmossdk.io/log` and `cosmossdk.io/core/address`) causing the compiler error.
2.  **Compile:** Run `ignite chain build` (or `go build ./cmd/nilchaind`) to confirm the chain binary builds successfully with the new Proof Verification module. *Note: You might need to set `CGO_LDFLAGS` to point to `nil_core` if building manually.*
3.  **Verify Integration:** (Optional but recommended) Run a test that submits a dummy proof (valid or invalid) to ensure the FFI connection is actually working in the binary.
4.  **Continue Phase 3:** Once the L1 is verifying proofs, move to the next Phase 3 item (e.g., connecting this L1 proof verification to the L2 Bridge contract we started in `nil_bridge`).

**Environment Note:**
- Use Go 1.25+ (The previous agent had issues with Go 1.21 vs 1.25).
- `nil_core` (Rust) must be built (`cargo build --release`) so the static lib is available for CGO.
