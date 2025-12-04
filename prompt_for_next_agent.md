# Context for Next Agent: NilStore Network Phase 3 Implementation

## Current Status
We are currently in **Phase 3: Code Implementation** of the NilStore Network development roadmap. We have just completed a major architectural pivot in the specification (Phase 1) and a comprehensive audit (Phase 2).

### Recent Accomplishments
1.  **Specification Overhaul (v2.6):**
    *   **Unified Liveness:** Merged "Storage" and "Retrieval" markets. User retrievals now count as storage proofs.
    *   **Performance Market:** Replaced strict "PoDE" timing checks with a **Block-Tiered Reward** system (Platinum/Gold/Silver).
    *   **System-Defined Placement:** Deterministic slotting (`Hash(Deal+Block)`) to prevent Sybil attacks.
    *   **Stripe-Aligned Elasticity:** Scaling now happens in units of `n=12` shards to ensure balanced throughput.
    *   **MDU Architecture:** Standardized on **8 MiB Mega-Data Units** composed of 64 x 128 KiB KZG blobs.
2.  **Codebase Updates:**
    *   **`nil_core` (Rust):** Removed deprecated `argon2` logic. Added `rs-merkle` and `blake2` for MDU Merkle root computation. Updated FFI bindings to support MDU-centric verification.
    *   **`nilchain` (Go):** 
        *   Defined new Protobuf types (`Deal`, `Provider`, `KzgProof`, `RetrievalReceipt`) in `types.proto`.
        *   Updated `tx.proto` with `MsgRegisterProvider`, `MsgCreateDeal`, `MsgProveLiveness`, `MsgSignalSaturation`.
        *   Implemented `AssignProviders` logic in `Keeper` (Deterministic Placement).
        *   Implemented `MsgCreateDeal` handler (Escrow deduction, Deal creation).
        *   Implemented `MsgRegisterProvider` handler.
        *   Implemented `MsgProveLiveness` handler (Unified verification, Tiered Rewards, Bandwidth payment).
        *   Implemented `MsgSignalSaturation` handler (Saturation check, Budget check, Stripe-Aligned scaling).

## Outstanding Tasks (Immediate To-Dos)

The next agent should focus on **verifying and refining the implementation**.

### 1. Build & Verify
*   **Run `ignite generate proto-go`**: Ensure all Protobuf updates are correctly generated.
*   **Fix Compile Errors**: The recent large commits to `msg_server.go` likely introduced imports or type mismatches (e.g., `crypto_ffi` package usage).
*   **Unit Tests**: Create `msg_server_test.go` to test:
    *   `CreateDeal`: Verify deterministic placement produces distinct providers.
    *   `ProveLiveness`: Verify tiered reward calculation (mock block heights).
    *   `SignalSaturation`: Verify budget checks and replica counts.

### 2. Core Cryptography (Rust)
*   **Verify MDU Logic**: Ensure `nil_core` correctly computes Merkle roots for 64-blob batches.
*   **FFI Integration**: The Go `crypto_ffi` package is calling Rust functions. Ensure the `libnil_core.a` is built and linked correctly for `go test` to pass.

### 3. End-to-End Simulation
*   Run a simulated "Deal Lifecycle":
    1.  Register 20 Providers.
    2.  Create a Deal.
    3.  Submit a "Platinum" Proof (immediate block).
    4.  Check Provider Balance (should increase).
    5.  Submit a "Fail" Proof (late block).
    6.  Check Provider Balance (should not increase).

## Key Architectural References
*   **`spec.md`**: Detailed normative spec for v2.6 (MDU sizes, Tiered Rewards).
*   **`metaspec.md`**: System constraints (Cold Start, Viral Debt).
*   **`whitepaper.md`**: High-level unified economy logic.

## Prompt for Next Agent
"You are resuming the implementation of the NilStore Network in Phase 3. The previous agent has implemented the core Message Handlers for `CreateDeal`, `ProveLiveness`, and `SignalSaturation` in `nilchain/x/nilchain/keeper/msg_server.go`, and updated the Rust `nil_core` cryptography library to support MDU Merkle proofs.

Your goal is to **stabilize and verify** this code.
1.  Run the build (`go build ./...` in `nilchain`). Fix any syntax errors or missing imports in the new `msg_server.go` code.
2.  Create a unit test suite for the Keeper methods to verify the logic (Placement, Tiers, Rewards) works as intended.
3.  Ensure the Rust FFI binding is correctly linked and callable from Go tests.
4.  Once stable, document the 'Happy Path' execution trace."