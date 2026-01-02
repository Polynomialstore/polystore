# Mainnet Gap Tracker (NilStore)

This document tracks **what is missing** between the current implementation in this repo and the **long‑term Mainnet plan** described by `spec.md` (canonical), `rfcs/`, and `notes/`.

**Sources (ordered):**
- `spec.md` (canonical protocol spec; v2.4 at time of writing)
- `rfcs/` (design proposals / deep dives; check header status)
- `notes/roadmap_milestones_strategic.md` (milestone sequencing)

## How To Use

- Keep items **small enough to ship** (1–5 PRs each).
- Every epic should have a **test gate** (unit/e2e/script) before it can be marked “Done”.
- Prefer tracking **code ownership** by directory:
  - Chain: `nilchain/`
  - Gateway/SP: `nil_gateway/`
  - Core crypto/WASM: `nil_core/`
  - CLI automation: `nil_cli/`
  - P2P: `nil_p2p/`
  - Web UX: `nil-website/`

## Status Legend

- **DONE**: implemented + tested in CI and/or e2e scripts
- **PARTIAL (DEVNET)**: exists, but incomplete vs spec/mainnet hardening (often “devnet convenience”)
- **MISSING**: not implemented
- **RFC / UNSPECIFIED**: explicitly underspecified in `spec.md` Appendix B; needs policy finalization

## Critical Path (P0) — Mainnet Blocking

### P0-CHAIN-001 — Mode 2 generations + repair mode + make‑before‑break replacement
- **Status:** MISSING
- **Spec:** `spec.md` §8.4, §5.3, Appendix B (2, 4, 6)
- **Current state:** Mode 2 exists at the client/gateway level, but the chain does not represent `current_gen` / per-slot repair status, and cannot safely coordinate “repair while appending”.
- **DoD:** Chain has explicit generation + slot status; repairs are observable; replacement is make‑before‑break; reads route around repairing slots; append-only commit rules enforced.
- **Test gate:** new e2e (multi-SP) that simulates slot failure → repair catch-up → slot rejoin without breaking reads.

### P0-CHAIN-002 — Challenge derivation + proof demand policy + quota enforcement
- **Status:** RFC / UNSPECIFIED
- **Spec:** `spec.md` §7.6, Appendix B (3, 4)
- **Current state:** sessions/proofs exist, but there is no finalized deterministic policy for required proofs and synthetic fill.
- **DoD:** deterministic challenge derivation from chain state + epoch randomness; quota accounting; penalties for non-compliance distinct from invalid proofs.
- **Test gate:** keeper unit tests + adversarial sim tests for challenge determinism and anti-grind properties.

### P0-CHAIN-003 — Fraud proofs / evidence taxonomy (wrong data, non-response, etc.)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §7.5
- **Current state:** session-based flows exist, but the full evidence/fraud proof pipeline and policy-level outcomes (slash/evict) aren’t complete.
- **DoD:** on-chain evidence messages/types + verification; slashing/jailing/eviction integration; replay protections; clear invariants.
- **Test gate:** unit tests for each evidence type + e2e that demonstrates slash on proven bad data.

### P0-P2P-001 — Deputy system + proxy retrieval market + audit debt
- **Status:** PARTIAL (stub only)
- **Spec:** `spec.md` §7.7–§7.8; `rfcs/rfc-retrieval-validation.md`; Appendix B (7)
- **Current state:** `nil_p2p` has an `AskForProxy` message stub, but no end-to-end deputy selection, relay, compensation, or evidence.
- **DoD:** proxy retrieval works when an SP “ghosts”; failure evidence is produced and aggregated; audit debt tasks are assignable/trackable; griefing mitigations.
- **Test gate:** e2e “ghosting provider” scenario that still retrieves via deputy and records evidence.

### P0-PERF-001 — High-throughput KZG (GPU) + parallel ingest pipeline
- **Status:** RFC / UNSPECIFIED (implementation missing)
- **Spec/Notes:** `notes/kzg_upload_bottleneck_report.md`, `notes/kzg_gpu_design.md`, `notes/roadmap_milestones_strategic.md` (Milestone 2)
- **Current state:** CPU KZG works; parallelism improved, but mainnet target throughput requires GPU-class acceleration for large uploads.
- **DoD:** CUDA (server) and/or WebGPU (client) path that materially raises sustained throughput; pipeline parallelism is default.
- **Test gate:** reproducible perf benchmark suite (CI “doesn’t regress”) + local benchmark script with thresholds.

### P0-CORE-001 — “One core” migration (NilFS + crypto single source of truth)
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `notes/roadmap_milestones_strategic.md` (Milestone 1)
- **Current state:** `nil_gateway` contains NilFS/layout logic in Go, while the browser uses `nil_core` WASM for crypto; risk of drift.
- **DoD:** NilFS builder/layout + commitment logic live in `nil_core` with WASM + CGO bindings; browser + gateway agree on commitments deterministically.
- **Test gate:** parity tests that compare browser vs gateway roots/commitments for the same file set.

### P0-ECON-001 — Mainnet escrow accounting + lock-in pricing (pay-at-ingest)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §6.1–§6.2; Appendix B (5)
- **Current state:** deal escrow exists and retrieval fees exist; “lock-in” and full debit schedule policy isn’t complete.
- **DoD:** clear accounting rules for storage rent + bandwidth; enforce max spend caps; elasticity debits are deterministic and replay-safe.
- **Test gate:** chain-level econ e2e (create deal → upload → retrieve → check balances/fees/burns) for multiple parameter sets.

### P0-OPS-001 — Mainnet-grade security + audits + threat model closure
- **Status:** MISSING
- **Spec/Notes:** `spec.md` §5, Appendix B (8, 9)
- **Current state:** devnet-grade hardening exists (auth tokens, strict parsing in many places), but audit posture is not “mainnet ready”.
- **DoD:** external audits (crypto + chain + gateway), hardening issues resolved, incident response plan, secure defaults.
- **Test gate:** security test suite + documented audit scope and “must-fix” checklist.

## Domain Backlog (P1/P2) — Organized By Subsystem

### Chain / Protocol (`nilchain/`)

#### CHAIN-101 — Explicit Mode 2 encoding on-chain (K/M, slot mapping, overlays)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §6.2, §8.1.3; Appendix B (2)
- **Notes:** Today, RS profile is encoded in `service_hint` and slots are represented via `providers[]`. Mainnet needs explicit typed state + upgrade strategy.

#### CHAIN-102 — Rotation policy + governance-gated bootstrap mode
- **Status:** MISSING
- **Spec:** `spec.md` §4.3, §5.1, §5.3; Appendix B (1, 4)

#### CHAIN-103 — HealthState / self-healing placement + eviction curve
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §7.9; Appendix B (1, 4)

#### CHAIN-104 — Deletion semantics (deal cancel, expiry enforcement, crypto-erasure UX hooks)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §6.3, §8.4.4; Appendix B (6, 8)
- **Notes:** “Crypto-erasure” is a client contract; chain still needs consistent cancellation semantics and post-expiry invariants.

#### CHAIN-105 — Third-party sponsorship / funding flows (viral debt mitigation)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §5.2
- **Notes:** confirm whether `MsgAddCredit` is sufficient for sponsorship (non-owner funding) and whether UI exposes it.

#### CHAIN-106 — EVM module production posture (simulation vs runtime)
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `AGENTS.md` Phase 5 notes; `nilchain/app/app.go` simulation exclusions
- **Notes:** EVM/FeeMarket are excluded from simulation to avoid signer panics; ensure production builds are safe and tested.

### Gateway / Provider (`nil_gateway/`)

#### GW-201 — Strict session enforcement on data-plane fetches
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` Appendix A “Gateway/API note”, §7.2
- **DoD:** gateway/SP enforce `X‑Nil‑Session‑Id` when sessions required; out-of-session range fetches are rejected; consistent error JSON.

#### GW-202 — Repair tooling + deterministic reconstruction for Mode 2 slots
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §8.4, §8.2

#### GW-203 — Upload delegation (third-party uploader pattern)
- **Status:** MISSING
- **Notes:** `notes/launch_todos.md`

#### GW-204 — S3 adapter polish + bidirectional sync scripts (nilstore ↔ S3)
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** roadmap milestone 5, `notes/launch_todos.md`

### Web / UX (`nil-website/`)

#### WEB-301 — Provider onboarding wizard (“Become a Provider”)
- **Status:** MISSING
- **Notes:** `notes/roadmap_milestones_strategic.md` (Milestone 1)

#### WEB-302 — Hybrid client “unified namespace” + sync manager (OPFS ↔ Gateway ↔ Network)
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `notes/roadmap_milestones_strategic.md` (Milestone 1)

#### WEB-303 — Educational content remediation (Mode 2, Triple Proof, Deputy)
- **Status:** MISSING
- **Source:** `nil-website/AGENTS.md` §8

### Core crypto / WASM (`nil_core/`)

#### CORE-401 — WebGPU KZG commitments/proofs (client-side velocity)
- **Status:** MISSING
- **Notes:** `notes/kzg_gpu_design.md`

#### CORE-402 — Determinism harness (cross-runtime, cross-platform)
- **Status:** PARTIAL (DEVNET)
- **DoD:** stable outputs for commitments across Mac/Linux and browser/gateway; fuzzers for edge-cases.

### CLI / Automation (`nil_cli/`, `scripts/`)

#### CLI-501 — Enterprise upload job runner (delegated key, scoped funding, teardown)
- **Status:** MISSING
- **Notes:** `notes/launch_todos.md`

#### CLI-502 — Fast download / mirror scripts (provider → local, nilstore → S3)
- **Status:** PARTIAL (DEVNET)
- **Notes:** `notes/launch_todos.md`

### P2P (`nil_p2p/`)

#### P2P-601 — Production transport + discovery (beyond stubs)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` Appendix B (9)

## Spec ↔ Implementation Divergences To Track Explicitly

- **Deal sizing naming:** `spec.md` uses `allocated_length`; code uses `Deal.size` on-chain and may surface `allocated_length` as a gateway/UI alias. Decide and converge.
- **Mode 2 on-chain representation:** `service_hint` encoding works for devnet; mainnet likely needs explicit typed fields for `(K,M)` and slot status.
- **EVM simulation posture:** EVM/FeeMarket excluded from simulation to avoid signer panics; ensure this doesn’t mask mainnet correctness issues.

## Suggested Sequencing (Pragmatic)

1. **CORE-001 One-core migration** (reduce drift risk first).
2. **ECON-001 Lock-in + escrow accounting** (mainnet business logic).
3. **PERF-001 GPU + ingest parallelism** (make the product usable at scale).
4. **CHAIN-001/002/003/103** (repair, challenges, fraud proofs, health).
5. **P2P-001 deputy + audit debt** (adversarial resilience).
6. **OPS-001 audits + hardening** (gate before mainnet).

