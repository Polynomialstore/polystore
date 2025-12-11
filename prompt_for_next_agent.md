# Current State (December 10, 2025)

## System Status: Stable & Feature Complete (Sprint "StripeReplica")
- **Core:** `nil_core` is WASM-compatible (using manual `bls12_381` implementation). `expand_mdu` logic (RS 12,8 + KZG) is active.
- **Web:** "Thick Client" features enabled.
    -   `FileSharder.tsx` expands files locally via `WasmWorker`.
    -   `DealDetail.tsx` and `Dashboard.tsx` polished (Light Mode, No Tiers).
    -   `nil_core.wasm` artifact built and committed to `public/wasm/`.
- **Specs:** Updated to include Mode 2 and Dynamic Sizing.

## Next Priorities
1.  **Protocol Cleanup:** Remove `DealSize` enum from `nilchain` (Proto/Go). Currently only hidden in UI.
2.  **Mode 2 Network:** Implement StripeReplica distribution logic in `nil_p2p` (currently Mode 1).
3.  **End-to-End Test:** Verify actual file retrieval from a striped deal (Mode 2) once network logic is in place.

## Code Context
- `nil_core/src/coding.rs`: Expansion logic.
- `nil-website/src/workers/mduWorker.ts`: Frontend expansion bridge.
