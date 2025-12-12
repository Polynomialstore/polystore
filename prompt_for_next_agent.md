# Handoff State (December 12, 2025)

This file is the short brief for the next agent. The canonical, longer TODO list lives in `AGENTS.md` (see section **11. Active Agent Work Queue (Current)**).

## 1. High-Level State

- **Chain & EVM:**
  - `nilchaind` boots cleanly via `./scripts/run_local_stack.sh start`.
  - `UpdateDealContentFromEvm` works with EIP‑712 signatures; gateway retries txs on sequence mismatch.
  - Local EVM bridge deploy remains stable and writes `_artifacts/bridge_address.txt` for the web UI.

- **Gateway (`nil_s3`) — Canonical NilFS Upload (Option D / A1 DONE):**
  - `/gateway/upload` now defaults to **canonical ingest** (`IngestNewDeal`): builds a full slab (MDU #0 + Witness MDUs + User MDUs) and returns a real `manifest_root`.
  - **Option D / A2 DONE:** If `deal_id` is supplied, `/gateway/upload` appends into the existing slab and returns a new `manifest_root` (multi‑file deals supported).
  - Fake modes are still available only behind explicit env flags:
    - `NIL_FAKE_INGEST=1` → old SHA‑based `fastShardQuick` (dev/sim only).
    - `NIL_FAST_INGEST=1` → `IngestNewDealFast` (no witness MDUs; not Triple‑Proof valid).
  - **Timeout hardening:** `shardFile` uses `NIL_SHARD_TIMEOUT_SECONDS` (default 600s) so gateway doesn’t 30s‑timeout during canonical KZG sharding.

- **E2E scripts:**
  - All upload curls now use a finite but long timeout (`timeout 600s`) to avoid hangs during canonical ingest.
  - `./scripts/e2e_lifecycle.sh` passes end‑to‑end with **no ingest env flags set** (Create Deal EVM → Upload → Commit Content EVM → Fetch).

## 2. Known Issues / Open Threads

1. **Thick‑client WASM path still failing:** “Invalid scalar” in `nil_core` WASM `expand_mdu/expand_file` (see Option D / B1).
2. **Dynamic sizing cleanup** remains pending but not blocking the demo.
3. **Frontend MetaMask UX** (Wagmi/Viem provider + Connect flow) still incomplete per AGENTS.md §11.1.

## 3. What the Next Agent Should Do First

1. **Option D / B1 — Fix WASM “Invalid scalar”.**
   - Investigate scalar/roots‑of‑unity mapping in `nil_core` WASM bindings.
   - Add parity tests vs native `nil_cli shard` once fixed (B2).

2. **Protocol Cleanup (Dynamic Sizing)** — remove legacy tiers and align thin‑provisioning end‑to‑end (AGENTS.md §11.2).

3. **Frontend MetaMask UX** — finish Wagmi/Viem wiring and add Connect + NilBridge happy‑path action (AGENTS.md §11.1).

## 4. Key Files

- Roadmap/context: `AGENTS.md` §11.6.
- Canonical ingest: `nil_s3/ingest.go`, `nil_s3/main.go` (`GatewayUpload`, `shardFile`).
- NilFS structs/builders: `nil_s3/pkg/layout/*`, `nil_s3/pkg/builder/*`.
- WASM path: `nil_core/src/wasm/*`, `nil-website/src/workers/mduWorker.ts`.

## 5. How to Run

- Start local stack: `./scripts/run_local_stack.sh start`
- Backend lifecycle gate: `./scripts/e2e_lifecycle.sh`
