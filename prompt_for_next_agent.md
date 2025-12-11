# Current State (December 10, 2025)

## System Status: Ready for WASM Build
- **Core:** `nil_core` is fully implemented and WASM-compatible.
    - `kzg.rs`: Manual MSM implementation using `bls12_381` (Upstream).
    - `coding.rs`: `expand_mdu` logic (Reed-Solomon + KZG).
    - `wasm.rs`: Exposed via `wasm-bindgen`.
- **Web:** `useFileSharder` hook and `mduWorker.ts` created.
- **Assets:** `trusted_setup.txt` copied to `nil-website/public/`.

## Next Steps (Build & Verify)
1.  **Build WASM:** Install `wasm-pack` and build `nil_core`.
    ```bash
    cargo install wasm-pack
    cd nil_core && wasm-pack build --target web --out-dir ../nil-website/public/wasm
    ```
2.  **Verify Web:** Run `nil-website` (`npm run dev`) and test the "Thick Client" flow (Client-side sharding).
    -   Need to update `FileSharder.tsx` or Dashboard to use the new `useFileSharder` hook.
3.  **UI Polish:** Complete the "Light Mode" and "Remove Tiers" tasks from `AGENTS.md`.

## Code Context
- `nil_core/src/kzg.rs`: The crypto engine.
- `nil-website/src/workers/mduWorker.ts`: The bridge.
