```MAINNET_GAP_TRACKER.md
# Mainnet Gap Tracker (NilStore)

This document tracks **what is missing** between the current implementation in this repo and the **long‑term Mainnet plan** described by `spec.md` (canonical), `rfcs/`, and `notes/`.

**Sources (ordered):**
- `spec.md` (canonical protocol spec; v2.4 at time of writing)
- `rfcs/` (design proposals / deep dives; check header status)
- `notes/roadmap_milestones_strategic.md` (milestone sequencing)
- `notes/mainnet_policy_resolution_jan2026.md` (proposal: concrete defaults for remaining econ/repair/deputy policies)

## How To Use

- Keep items **small enough to ship** (1–5 PRs each).
- Every epic should have a **test gate** (unit/e2e/script) before it can be marked “Done”.
- Prefer tracking **code ownership** by directory:
  - Chain: `polystorechain/`
  - Gateway/SP: `polystore_gateway/`
  - Core crypto/WASM: `polystore_core/`
  - CLI automation: `polystore_cli/`
  - P2P: `polystore_p2p/`
  - Web UX: `polystore-website/`

## Status Legend

- **DONE**: implemented + tested in CI and/or e2e scripts
- **PARTIAL (DEVNET)**: exists, but incomplete vs spec/mainnet hardening (often “devnet convenience”)
- **MISSING**: not implemented
- **RFC / UNSPECIFIED**: explicitly underspecified in `spec.md` Appendix B; needs policy finalization
- **SPECIFIED (RFC)**: policy/interfaces frozen in RFCs, but implementation is still missing

## Critical Path (P0) — Mainnet Blocking

### P0-CHAIN-001 — Mode 2 generations + repair mode + make‑before‑break replacement
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §8.4, §5.3, Appendix B (2, 4, 6)
- **Current state:** the chain now tracks typed Mode 2 slots + a first-pass `current_gen` and per-slot repair state, but make-before-break replacement, append-safe repair coordination, and read routing around repairing slots are not fully implemented.
- **DoD:** Chain has explicit generation + slot status; repairs are observable; replacement is make‑before‑break; reads route around repairing slots; append-only commit rules enforced.
- **Test gate:** new e2e (multi-SP) that simulates slot failure → repair catch-up → slot rejoin without breaking reads.

### P0-CHAIN-002 — Challenge derivation + proof demand policy + quota enforcement
- **Status:** SPECIFIED (RFC)
- **Spec:** `spec.md` §7.6, Appendix B (3, 4); `rfcs/rfc-challenge-derivation-and-quotas.md`
- **Current state:** sessions/proofs exist; deterministic quota + synthetic fill policy is now specified, but not implemented in keeper state machines.
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
- **Current state:** `polystore_p2p` has an `AskForProxy` message stub, but no end-to-end deputy selection, relay, compensation, or evidence.
- **DoD:** proxy retrieval works when an SP “ghosts”; failure evidence is produced and aggregated; audit debt tasks are assignable/trackable; griefing mitigations.
- **Test gate:** e2e “ghosting provider” scenario that still retrieves via deputy and records evidence.

### P0-PERF-001 — High-throughput KZG (GPU) + parallel ingest pipeline
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `notes/kzg_upload_bottleneck_report.md`, `notes/kzg_gpu_design.md`, `notes/roadmap_milestones_strategic.md` (Milestone 2)
- **Current state:** CPU KZG works and the gateway ingest pipeline is parallelized by default; GPU-class acceleration is still missing for mainnet target throughput.
- **DoD:** CUDA (server) and/or WebGPU (client) path that materially raises sustained throughput; pipeline parallelism is default.
- **Test gate:** reproducible perf benchmark suite (CI “doesn’t regress”) + local benchmark script with thresholds.

### P0-CORE-001 — “One core” migration (PolyFS + crypto single source of truth)
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `notes/roadmap_milestones_strategic.md` (Milestone 1)
- **Current state:** `polystore_gateway` contains PolyFS/layout logic in Go, while the browser uses `polystore_core` WASM for crypto; risk of drift.
- **DoD:** PolyFS builder/layout + commitment logic live in `polystore_core` with WASM + CGO bindings; browser + gateway agree on commitments deterministically.
- **Test gate:** parity tests that compare browser vs gateway roots/commitments for the same file set.

### P0-ECON-001 — Mainnet escrow accounting + lock-in pricing (pay-at-ingest)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §6.1–§6.2, §7.2.1; Appendix B (5); `rfcs/rfc-pricing-and-escrow-accounting.md`
- **Current state:** deal escrow exists and retrieval fees exist; lock-in + fee settlement is partially implemented, but spend windows and deterministic elasticity debits remain incomplete.
- **DoD:** clear accounting rules for storage rent + bandwidth; enforce max spend caps; elasticity debits are deterministic and replay-safe.
- **Test gate:** chain-level econ e2e (create deal → upload → retrieve → check balances/fees/burns) for multiple parameter sets.

### P0-OPS-001 — Mainnet-grade security + audits + threat model closure
- **Status:** MISSING
- **Spec/Notes:** `spec.md` §5, Appendix B (8, 9)
- **Current state:** devnet-grade hardening exists (auth tokens, strict parsing in many places), but audit posture is not “mainnet ready”.
- **DoD:** external audits (crypto + chain + gateway), hardening issues resolved, incident response plan, secure defaults.
- **Test gate:** security test suite + documented audit scope and “must-fix” checklist.

## Domain Backlog (P1/P2) — Organized By Subsystem

### Chain / Protocol (`polystorechain/`)

#### CHAIN-101 — Explicit Mode 2 encoding on-chain (K/M, slot mapping, overlays)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` §6.2, §8.1.3; Appendix B (2); `rfcs/rfc-mode2-onchain-state.md`
- **Notes:** Today, RS profile is encoded in `service_hint` and slots are represented via `providers[]`. Mainnet needs explicit typed state + upgrade strategy (now specified in RFC).

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
- **Spec/Notes:** `AGENTS.md` Phase 5 notes; `polystorechain/app/app.go` simulation exclusions
- **Notes:** EVM/FeeMarket are excluded from simulation to avoid signer panics; ensure production builds are safe and tested.

### Gateway / Provider (`polystore_gateway/`)

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

### Web / UX (`polystore-website/`)

#### WEB-301 — Provider onboarding wizard (“Become a Provider”)
- **Status:** MISSING
- **Notes:** `notes/roadmap_milestones_strategic.md` (Milestone 1)

#### WEB-302 — Hybrid client “unified namespace” + sync manager (OPFS ↔ Gateway ↔ Network)
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `notes/roadmap_milestones_strategic.md` (Milestone 1)

#### WEB-303 — Educational content remediation (Mode 2, Triple Proof, Deputy)
- **Status:** MISSING
- **Source:** `polystore-website/AGENTS.md` §8

### Core crypto / WASM (`polystore_core/`)

#### CORE-401 — WebGPU KZG commitments/proofs (client-side velocity)
- **Status:** MISSING
- **Notes:** `notes/kzg_gpu_design.md`

#### CORE-402 — Determinism harness (cross-runtime, cross-platform)
- **Status:** PARTIAL (DEVNET)
- **DoD:** stable outputs for commitments across Mac/Linux and browser/gateway; fuzzers for edge-cases.

### CLI / Automation (`polystore_cli/`, `scripts/`)

#### CLI-501 — Enterprise upload job runner (delegated key, scoped funding, teardown)
- **Status:** MISSING
- **Notes:** `notes/launch_todos.md`

#### CLI-502 — Fast download / mirror scripts (provider → local, nilstore → S3)
- **Status:** PARTIAL (DEVNET)
- **Notes:** `notes/launch_todos.md`

### P2P (`polystore_p2p/`)

#### P2P-601 — Production transport + discovery (beyond stubs)
- **Status:** PARTIAL (DEVNET)
- **Spec:** `spec.md` Appendix B (9)

## Spec ↔ Implementation Divergences To Track Explicitly

- **Deal sizing naming (resolved):** `spec.md` uses `Deal.size`/`size_bytes` (logical bytes) plus `Deal.total_mdus` + `Deal.witness_mdus` (slab bounds). Gateway may still return legacy `allocated_length` as an alias for `total_mdus` (count).
- **Mode 2 on-chain representation (specified):** explicit typed `(K,M)`, slot mapping, generations, and repair state frozen in `rfcs/rfc-mode2-onchain-state.md`.
- **EVM simulation posture:** EVM/FeeMarket excluded from simulation to avoid signer panics; ensure this doesn’t mask mainnet correctness issues.

## Suggested Sequencing (Pragmatic)

1. **CORE-001 One-core migration** (reduce drift risk first).
2. **ECON-001 Lock-in + escrow accounting** (mainnet business logic).
3. **PERF-001 GPU + ingest parallelism** (make the product usable at scale).
4. **CHAIN-001/002/003/103** (repair, challenges, fraud proofs, health).
5. **P2P-001 deputy + audit debt** (adversarial resilience).
6. **OPS-001 audits + hardening** (gate before mainnet).

---

## Sprint Roadmap (Proposed)

Assumption: **2-week engineering sprints**, with a strict “test gate” on every sprint exit. Adjust duration as needed; keep the **scope** bounded.

### Sprint 0 — RFC closure + interfaces freeze (Protocol planning sprint)
- **Goal:** turn Appendix B “unspecified” items into implementable, testable contracts.
- **Delivers (Docs + reference code stubs):**
  - Finalize the target on-chain representation for Mode 2: explicit `(K,M)`, slot mapping, overlay state, slot status, and generation fields (Appendix B #2, #6).
  - Finalize challenge derivation + proof quota policy (Appendix B #3, #4).
  - Finalize pricing/escrow accounting policy (Appendix B #5).
  - Decide and document the `allocated_length` vs `size` vs `total_mdus` naming convergence (see “Divergences” section).
- **Outputs (Sprint 0):**
  - `rfcs/rfc-mode2-onchain-state.md`
  - `rfcs/rfc-challenge-derivation-and-quotas.md`
  - `rfcs/rfc-pricing-and-escrow-accounting.md`
  - `spec.md` naming + Appendix B references aligned to the RFCs
- **Exit criteria:** updated RFCs/spec deltas + a checklist of exact protobuf/state transitions to implement in the next sprints.

### Sprint 1 — “One core” foundation (PolyFS + commitments unified)
- **Targets:** **P0-CORE-001**, **CORE-402** (partial), plus the “Divergences” naming decision groundwork.
- **Goal:** eliminate browser/gateway drift risk by centralizing PolyFS layout + commitment computation in `polystore_core`.
- **Delivers:**
  - Port PolyFS layout/builder primitives from `polystore_gateway/pkg/*` into `polystore_core` (Rust) with a stable API surface.
  - WASM bindings used by `polystore-website` AND CGO/FFI bindings used by `polystore_gateway` point to the same implementation.
  - Parity tests: same file set → identical manifest root + per-MDU roots across browser(WASM) and gateway(native).
- **Test gate:** new parity test suite + existing `./scripts/e2e_browser_smoke.sh`.

### Sprint 2 — Economic model v1 (lock-in, caps, top-ups)
- **Targets:** **P0-ECON-001**, **CHAIN-105**.
- **Goal:** make “user-funded elasticity + storage rent” real and enforceable (not a narrative).
- **Delivers:**
  - Implement pay-at-ingest debit schedule (or equivalent lock-in) for `UpdateDealContent*` and retrieval session fees accounting.
  - Enforce `max_monthly_spend` in code paths that can increase cost (uploads/elasticity triggers).
  - Clarify and implement third-party sponsorship semantics (whether `MsgAddCredit` supports it safely, and how UI exposes it).
- **Test gate:** chain econ e2e (deal → upload → retrieve → verify balances/burns/caps) across multiple parameter sets.

### Sprint 3 — Mode 2 on-chain encoding (explicit state, not service_hint encoding)
- **Targets:** **CHAIN-101**, plus prerequisites for **P0-CHAIN-001**.
- **Goal:** move Mode 2 out of “devnet convenience encoding” into explicit typed state.
- **Delivers:**
  - Deal stores explicit `(K,M)` (or equivalent) and a canonical ordered `slot → provider` mapping.
  - Upgrade strategy from legacy `service_hint` encoding (devnet) to typed fields without breaking existing deals.
- **Test gate:** migration tests + multi-provider e2e that creates Mode 2 deals and verifies slot ordering invariants.

### Sprint 4 — Mode 2 generations + repair mode + make-before-break replacement
- **Targets:** **P0-CHAIN-001**, **GW-202** (partial).
- **Goal:** the chain can coordinate repairs safely while allowing append-only writes.
- **Delivers:**
  - `current_gen` + slot status (ACTIVE/REPAIRING) + append-only commit enforcement.
  - Replacement workflow: add new provider in REPAIRING, require catch-up proof/readiness, then promote to ACTIVE (make-before-break).
  - Gateway repair tooling for deterministic reconstruction and catch-up tasks.
- **Test gate:** multi-SP e2e that simulates slot failure → repair catch-up → slot rejoin; reads succeed throughout.

### Sprint 5 — Unified liveness v1 (quota + synthetic fill + health)
- **Targets:** **P0-CHAIN-002**, **CHAIN-103**, **GW-201** (tighten enforcement).
- **Goal:** make “Retrieval IS Storage” enforceable with deterministic fallback challenges and health accounting.
- **Delivers:**
  - Deterministic challenge derivation for synthetic fill + quota accounting.
  - Session credits reduce synthetic demand; synthetic challenges target only ACTIVE slots.
  - HealthState per (Deal, Provider/Slot) and eviction/jail integration hooks (policy from Sprint 0).
  - Enforce session-bound fetch requirements on the data plane (when enabled).
- **Test gate:** keeper unit tests + adversarial simulation + e2e showing quota enforcement and health impact.

### Sprint 6 — Fraud proofs + evidence pipeline (bad data, non-response)
- **Targets:** **P0-CHAIN-003**, **CHAIN-102** (policy hooks), **P0-OPS-001** (partial hardening).
- **Goal:** “wrong bytes” becomes slashable with a clean evidence path.
- **Delivers:**
  - On-chain evidence types + verification for wrong data and bounded non-response challenges (per spec shape).
  - Slashing/jailing/eviction curve wired to evidence outcomes (parameters from Sprint 0).
  - Clear replay/expiry protections and audit-friendly event emission.
- **Test gate:** unit tests for each evidence type + e2e that produces a slash on proven bad data.

### Sprint 7 — Deputy system (proxy retrieval) + audit debt v1
- **Targets:** **P0-P2P-001**, **P2P-601** (incremental), **spec.md** Appendix B #7.
- **Goal:** handle “ghosting SPs” and scale coverage even when users are idle.
- **Delivers:**
  - Deputy discovery + proxy retrieval path (end-to-end) with anti-griefing controls.
  - Evidence collection for repeated failures, plus the first “audit debt” scheduler shape (even if conservatively parameterized).
- **Test gate:** e2e ghosting scenario: user retrieves via deputy; evidence recorded; no false slashes from a single deputy.

### Sprint 8 — Throughput (GPU) + production ingest defaults
- **Targets:** **P0-PERF-001**, **CORE-401** (optional client track), plus perf regression gates.
- **Goal:** remove the CPU KZG bottleneck for large data ingest; ensure the fast path is default (not behind env flags).
- **Delivers:**
  - GPU KZG acceleration in the gateway/CLI ingest path (CUDA/Icicle or equivalent), plus parallel pipeline scheduling.
  - Benchmark harness + perf regression thresholds (CI “alerts on regression”, local “meets target MB/s”).
  - Decide whether WebGPU KZG is a mainnet requirement or a post-mainnet UX upgrade; if required, implement minimal viable path.
- **Test gate:** perf suite + large-file ingest e2e on a reference machine (documented).

### Sprint 9 — Enterprise surface area (S3 polish + delegation tooling)
- **Targets:** **GW-204**, **GW-203**, **CLI-501**, **CLI-502**.
- **Goal:** “looks like S3” and supports delegated upload jobs safely.
- **Delivers:**
  - S3 adapter correctness + compatibility testing (aws-cli/rclone).
  - Third-party uploader pattern: scoped key funding + teardown + audit workflow.
  - Fast download / mirroring scripts (nilstore ↔ S3) with documented performance expectations.
- **Test gate:** integration tests + scripted “upload from S3 → verify on-chain → retrieve to S3” pipeline.

### Sprint 10 — Mainnet hardening + audits + launch readiness
- **Targets:** **P0-OPS-001**, plus closure of remaining P0s.
- **Goal:** turn “working devnet” into “auditable, operable mainnet”.
- **Delivers:**
  - Audit scopes (crypto/chain/gateway), fixes, and a “must-fix before mainnet” checklist.
  - Incident response runbooks, monitoring/alerting, safe defaults, and security posture docs.
  - Final “Mainnet readiness” e2e suite and release checklist.
- **Test gate:** security test suite + external audit signoff + final e2e battery green.

## Sprint Coverage Matrix (IDs → Sprint)

- **Sprint 1:** P0-CORE-001, CORE-402 (partial)
- **Sprint 2:** P0-ECON-001, CHAIN-105
- **Sprint 3:** CHAIN-101 (and prerequisites for P0-CHAIN-001)
- **Sprint 4:** P0-CHAIN-001, GW-202 (partial)
- **Sprint 5:** P0-CHAIN-002, CHAIN-103, GW-201
- **Sprint 6:** P0-CHAIN-003, CHAIN-102 (hooks), OPS (partial)
- **Sprint 7:** P0-P2P-001, P2P-601 (incremental)
- **Sprint 8:** P0-PERF-001, CORE-401 (optional/if required)
- **Sprint 9:** GW-203, GW-204, CLI-501, CLI-502
- **Sprint 10:** P0-OPS-001 (+ remaining closure)

---

## Execution Status (Repo)

As of `main` (Jan 2026), the repo has executed and merged the following sprint branches (used as **shipping increments** toward devnet/beta stability; not all Mainnet DoDs are fully satisfied yet):

- `sprint0-rfc-freeze`: RFC freezes for Mode 2 state, challenge derivation/quotas, and pricing/escrow.
- `sprint1-one-core-foundation`: Mode 2 ingest/upload hardening (one-core migration still PARTIAL).
- `sprint2-economic-model-v1`: enforce elasticity spend caps (full lock-in accounting still PARTIAL).
- `sprint3-mode2-onchain-encoding`: typed Mode 2 slot state scaffolding on-chain.
- `sprint4-mode2-repair-workflows`: generation + slot repair state tracking (replacement policy still PARTIAL).
- `sprint5-unified-liveness-v1`: liveness constraints during repair (quota/challenge derivation still SPECIFIED (RFC)).
- `sprint6-fraud-proofs-evidence`: non-response evidence recording (full evidence taxonomy still PARTIAL).
- `sprint7-deputy-system`: router-side fetch failover (full deputy market still PARTIAL).
- `sprint8-throughput-gpu-defaults`: faster Mode 2 artifact pipeline + WASM UX hardening (GPU KZG still MISSING).
- `sprint9-enterprise-s3-delegation`: deal-backed S3 adapter + docs/sync scripts (polish still PARTIAL).
- `sprint10-mainnet-hardening`: Mode 2 idempotency + CI-aligned E2E stability fixes.
- `sprint11-gap-tracker-refresh`: record repo execution status and tighten P0 status notes.
- `sprint12-mode2-routing-order`: prefer ACTIVE Mode 2 slots for routing/provider ordering.
- `sprint13-e2e-health-readiness`: standardize E2E readiness checks on `/health`.
- `sprint14-mode2-upload-reliability`: avoid Go client-side ContentLength mismatch errors via `Expect: 100-continue`.
- `sprint15-gap-tracker-status`: expand Mainnet gap tracker with per-sprint execution status and DoD mapping.
- `sprint16-e2e-mode2-stripe-stability`: stabilize Mode 2 StripeReplica E2E flows (upload/commit/retrieve) against UI regressions.
- `sprint17-proof-context-cleanup`: replace legacy proofs wiring with LCD retrieval sessions + `useProofs` polling where needed.
- `sprint18-remove-legacy-proofs`: remove stale dashboard UI paths that relied on the old `/proofs` store.
- `sprint19-upload-benchmark`: print upload wall-time and MiB/s in `scripts/e2e_lifecycle.sh` to prevent silent perf regressions.
- `sprint20-mode2-finalize-race`: harden Mode 2 slab finalize against rename races and make finalize idempotent under retries.
- `sprint21-dashboard-cleanup`: restore CI/E2E compatibility by removing redundant dashboard controls and keeping a single transport preference selector.
- `sprint22-wallet-unlock-detection`: detect MetaMask authorization (`eth_accounts`) early so “Create deal” prompts unlock before submit.
- `sprint23-gap-tracker-status`: record sprint22 execution status in the tracker (doc hygiene).
- `sprint24-one-core-payload-ffi`: move PolyFS payload encode/decode into `polystore_core` FFI to reduce cross-runtime drift.

```

```MAINNET_ECON_PARITY_CHECKLIST.md
# Mainnet Parity + Devnet/Testnet Launch Checklist

Companion docs:
- `notes/mainnet_policy_resolution_jan2026.md` (concrete proposal for “B” + staged plan)
- `MAINNET_GAP_TRACKER.md` (canonical gap tracking + DoDs + test gates)

## Stage 0 — Policy freeze → params + interfaces (unblocks engineering)
- [ ] Extend `polystorechain/proto/polystorechain/polystorechain/v1/params.proto` to encode B1/B2/B4/B5/B6 (with validation + genesis defaults).
- [ ] Encode audit budget sizing/caps (Option A): `audit_budget_bps`, `audit_budget_cap_bps`, and bounded carryover (≤2 epochs) for unused budget.
- [ ] Document chosen defaults + rationale in `notes/mainnet_policy_resolution_jan2026.md` and reference from `MAINNET_GAP_TRACKER.md`.

## Stage 1 — Storage lock-in pricing + escrow accounting (A1)
- [ ] Implement pay-at-ingest lock-in pricing on `UpdateDealContent*` per `rfcs/rfc-pricing-and-escrow-accounting.md` (`polystorechain/`).
- [ ] Implement deterministic spend window reset + deterministic elasticity debits (`polystorechain/`).
- [ ] Add econ e2e: create deal → upload/commit → verify escrow and module account flows (`scripts/`, `tests/`).

## Stage 2 — Retrieval session economics (A2)
- [ ] Enforce session open burns base fee + locks variable fee; rejects insufficient escrow (`polystorechain/`).
- [ ] Enforce completion settlement: burn cut + provider payout; cancel/expiry refunds locked fee only (`polystorechain/`).
- [ ] Extend econ e2e: open → complete; open → cancel/expire; verify burns/payouts/refunds (`scripts/`, `tests/`).

## Stage 3 — Deterministic challenge derivation + quotas + synthetic fill (A3)
- [ ] Implement deterministic challenge derivation + quota accounting (SPECIFIED in `rfcs/rfc-challenge-derivation-and-quotas.md`) (`polystorechain/`).
- [ ] Implement enforcement outcomes: invalid proof → hard fault; quota shortfall → HealthState decay (no slash by default) (`polystorechain/`).
- [ ] Add keeper unit tests for determinism + exclusions (REPAIRING slots excluded).
- [ ] Add adversarial sim test gate for anti-grind properties (`scripts/`, `performance/`).

## Stage 4 — HealthState + eviction curve (A6)
- [ ] Implement per-(deal, provider/slot) HealthState updates from hard/soft failures (`polystorechain/`).
- [ ] Implement eviction triggers (`evict_after_missed_epochs_hot/cold`) and hook into Mode 2 repair start (`polystorechain/`).
- [ ] Add queries/events for observability; add unit tests.

## Stage 5 — Mode 2 repair + make-before-break replacement (A5)
- [ ] Implement make-before-break replacement per `rfcs/rfc-mode2-onchain-state.md` (`polystorechain/`).
- [ ] Implement deterministic candidate selection + churn controls (B4) (`polystorechain/`).
- [ ] Ensure reads avoid `REPAIRING` slots; synthetic challenges ignore `REPAIRING`; repairing slots do not earn rewards (`polystorechain/`, `polystore_gateway/`).
- [ ] Add multi-SP repair e2e: slot failure → candidate catch-up → promotion; reads succeed throughout (`scripts/`, `tests/`).

## Stage 6 — Evidence / fraud proofs pipeline (A4)
- [ ] Implement evidence taxonomy + verification + replay protection (`polystorechain/`).
- [ ] Wire penalties (slash/jail/evict) to B1 params; integrate with repair start (`polystorechain/`).
- [ ] Add unit tests per evidence type + e2e demonstrating slash on proven bad data (`scripts/`, `tests/`).

## Stage 7 — Deputy market + proxy retrieval + audit debt (P0-P2P-001)
- [ ] Implement deputy/proxy retrieval end-to-end: selection, routing, and settlement (B5) (`polystore_p2p/`, `polystorechain/`, `polystore_gateway/`).
- [ ] Implement proof-of-failure aggregation with threshold/window (B1) and anti-griefing (B5) (`polystorechain/`).
- [ ] Add ghosting-provider e2e: still retrieve via deputy and record evidence (`scripts/`).

## B) Policy decisions to encode (proposal summary)

See `notes/mainnet_policy_resolution_jan2026.md` for full details.

- [ ] **B1 Slashing/jailing ladder:** hard faults slash immediately; non-response uses threshold/window; quota shortfall decays HealthState.
- [ ] **B2 Bonding:** base provider bond + assignment collateral scaled by slot bytes and `storage_price`.
- [ ] **B3 Pricing defaults:** derive `storage_price` from GiB-month target; define retrieval base + per-blob + burn bps; define halving interval policy.
- [ ] **B4 Replacement selection:** deterministic candidate ranking seeded by epoch randomness; cooldown + attempt caps.
- [ ] **B5 Deputy incentives:** proxy premium payout + evidence bond/bounty + audit debt funding choice (Option A vs B).
- [ ] **B6 Credits phase-in:** implement accounting first; enable quota reduction caps later (devnet→testnet→mainnet).

## Test gates (launch blockers)
- [ ] Chain econ e2e with multiple parameter sets (`scripts/`, `tests/`).
- [ ] Challenge determinism + anti-grind sim (`scripts/`, `performance/`).
- [ ] Ghosting-provider deputy e2e (`scripts/`).
- [ ] Health/repair e2e (replacement without read outage) (`scripts/`).

```

```mainnet_policy_resolution_jan2026.md
# Mainnet Policy Resolution (Jan 2026, Final Defaults + Implementation Notes)

This document captures **final baseline defaults** (devnet/testnet/mainnet where applicable) for the remaining underspecified Mainnet economics + reliability policies, plus implementation notes and calibration signals.

It is intended to turn the “B) underspecified items” in `MAINNET_ECON_PARITY_CHECKLIST.md` into **explicit parameters and keeper state transitions**.

## Scope

- **Economics:** escrow accounting, lock-in pricing, retrieval fee settlement, inflation/reward schedule hooks
- **Security/evidence:** slashing/jailing/ejection policy ladder, replay protections
- **Reliability:** deterministic repair/replacement selection, health tracking, deputy/proxy market incentives

## Final Defaults (Devnet / Testnet / Mainnet)

These are the baseline parameter defaults to implement and calibrate.

| Topic | Decision | Devnet | Testnet | Mainnet |
|---|---|---:|---:|---:|
| Slashing/jailing | Quota shortfall | no slash (HealthState-only) | same | same |
| Slashing/jailing | `slash_invalid_proof_bps` | 50 (0.5%) | 50 (0.5%) | 50 (0.5%) |
| Slashing/jailing | `slash_wrong_data_bps` | 500 (5%) | 500 (5%) | 500 (5%) |
| Slashing/jailing | `slash_nonresponse_bps` | 100 (1%) | 100 (1%) | 100 (1%) |
| Slashing/jailing | jail params | `3/30/10` epochs | same | same |
| Slashing/jailing | non-response conviction | `threshold=3` in `window=6` epochs | same | same |
| Slashing/jailing | hot/cold eviction | `2` / `6` missed epochs | same | same |
| Bonding | model | base bond + assignment collateral | same | same |
| Bonding | `min_provider_bond` | 100 `stake` | 100 `stake` | 10,000 `NIL` |
| Bonding | `bond_months` | 2 | 2 | 2 |
| Bonding | unbonding | `provider_unbonding_blocks = MONTH_LEN_BLOCKS` | same | same |
| Pricing | `target_GiBMonth_price` | 0.10 | 0.10 | 1.00 |
| Pricing | `target_GiBRetrieval_price` | 0.05 | 0.05 | 0.10 |
| Pricing | `base_retrieval_fee` | 0.0001 NIL | 0.0001 NIL | 0.0002 NIL |
| Pricing | `retrieval_burn_bps` | 500 (5%) | 500 (5%) | 1000 (10%) |
| Replacement | cooldown | per-slot, 7 days | same | same |
| Replacement | attempt cap | 3 / window | same | same |
| Deputy | audit debt funding | Option A (protocol-funded audit budget) | same | same |
| Deputy | audit budget sizing | `audit_budget_bps=200`, cap `500`, carryover≤2 epochs | same | `audit_budget_bps=100`, cap `200`, carryover≤2 epochs |
| Deputy | proxy premium (`premium_bps`) | 2000 (20%) | 2000 (20%) | 1000 (10%) |
| Deputy | evidence incentives | `evidence_bond=0.01`, `failure_bounty=0.02` | same | same |
| Deputy | evidence bond burn on no conviction | burn 50% on TTL expiry | same | same |
| Credits | phase-in | accounting only; caps=0 | enabled w/ caps | disabled at launch; caps=0 |
| Credits | caps (hot/cold) | `0/0` | `2500/1000` | launch `0/0` → later `5000/2500` |

## Implementation Note: Params That Exist Today vs Proposed Additions

The current on-chain params are defined in `polystorechain/proto/polystorechain/polystorechain/v1/params.proto` and already include (non-exhaustive):
- `storage_price`, `base_retrieval_fee`, `retrieval_price_per_blob`, `retrieval_burn_bps`
- `month_len_blocks`, `epoch_len_blocks`
- `quota_bps_per_epoch_hot/cold`, `quota_min_blobs`, `quota_max_blobs`
- `credit_cap_bps`
- `evict_after_missed_epochs` (single value; proposal suggests a hot/cold split)

This proposal introduces additional parameters (slashing/jailing, bonding, replacement cooldown/attempt caps, deputy premiums, evidence incentives, and credit cap splits). These require **adding new fields** to `Params` (and wiring validation/defaults) before keeper logic can rely on them.

## B) Underspecified Items — Proposed Resolutions

### B1) Slashing + jailing policy (hard vs soft failures)

**Intent:**
- **Hard faults** (cryptographically verifiable) are slashable immediately.
- **Soft faults** (statistical / threshold-verifiable) should not slash on a single report; use a threshold within a window; otherwise decay HealthState and eventually repair/evict.
- **Quota shortfall** is a *soft* failure: default is **no slash**, only HealthState decay + repair trigger.

**Evidence classes:**
1) **Hard-fault (chain-verifiable):**
   - Invalid synthetic proof (verification fails)
   - Wrong data fraud proof (bytes/proof mismatch)
   - **Action:** immediate slash + jail + trigger slot repair
2) **Soft-fault (threshold-verifiable):**
   - Non-response proof-of-failure (deputy transcript hash + attestation)
   - **Action:** convict only after distinct failures exceed threshold within window; otherwise HealthState decay
3) **Protocol non-compliance (no evidence):**
   - Quota shortfall at epoch end
   - **Action:** HealthState decay; repair trigger after `evict_after_missed_epochs_*`

**Proposed params (defaults):**
| Param | Default | Meaning |
|---|---:|---|
| `slash_invalid_proof_bps` | 50 | 0.5% slash on invalid proof (hard-fault) |
| `slash_wrong_data_bps` | 500 | 5% slash on wrong data proof (hard-fault) |
| `slash_nonresponse_bps` | 100 | 1% slash once non-response conviction triggers |
| `jail_invalid_proof_epochs` | 3 | jail duration after invalid proof |
| `jail_wrong_data_epochs` | 30 | jail duration after wrong-data fraud proof |
| `jail_nonresponse_epochs` | 10 | jail duration after confirmed non-response |
| `nonresponse_threshold` | 3 | ≥3 distinct failures needed to convict |
| `nonresponse_window_epochs` | 6 | failures must occur within this window |
| `evict_after_missed_epochs_hot` | 2 | hot deals: start repair after 2 missed epochs |
| `evict_after_missed_epochs_cold` | 6 | cold deals: start repair after 6 missed epochs |
| `max_strikes_before_global_jail` | 10 | global jail after repeated repair triggers |
| `strike_window_epochs` | 100 | rolling window for “strikes” |

Notes:
- Splitting `evict_after_missed_epochs` by service class (“hot/cold”) is recommended so sensitivity matches quota rates.
- Values are **starting defaults**; expect calibration during testnet.
- Jail params are expressed in **epochs**, but should be enforced using **block height** (e.g., `jail_end_height = now + jail_epochs*epoch_len_blocks`) to avoid ambiguity if epoch params change later.

### B2) Provider staking / bond requirements

**Goal:** slashing must be economically material and scale with responsibility.

**Proposed model (two-layer bond):**
1) **Base provider bond** (anti-sybil, minimum skin-in-the-game)
   - `min_provider_bond` default: 10,000 NIL (mainnet), 100 stake (devnet/testnet)
2) **Assignment collateral requirement** (scales with slot-responsible bytes)
   - Define:
     - `slot_bytes(deal, slot)` from Mode 2 profile (or Mode 1 full replica bytes)
     - `MONTH_LEN_BLOCKS` protocol param
   - Require:
     - `required_bond = ceil(bond_months * storage_price * MONTH_LEN_BLOCKS * slot_bytes)`
   - `bond_months` default: 2
3) **Unbonding / lock**
   - `provider_unbonding_blocks` default: `MONTH_LEN_BLOCKS`
   - provider cannot drop below requirement while assigned to active slots (or while a pending repair candidate)
4) **Failure handling**
   - if provider bond < required: ineligible for new assignments; can trigger eviction on affected deals

Fallback (simpler, weaker): flat bond only (no assignment collateral).

### B3) Pricing parameters + equilibrium targets

**Accounting contract (frozen):** see `rfcs/rfc-pricing-and-escrow-accounting.md`.

**Deriving storage price from “GiB-month”:**
- `storage_price = target_GiBMonth_price / (GiB * MONTH_LEN_BLOCKS)`

**Proposed defaults:**
- Devnet/testnet: `target_GiBMonth_price = 0.10 NIL / GiB-month`
- Mainnet: `target_GiBMonth_price = 1.00 NIL / GiB-month`

**Retrieval fees:**
- Base fee (burned): `base_retrieval_fee`
  - Dev/test: 0.0001 NIL
  - Mainnet: 0.0002 NIL
  - Rationale: keep “base fee share” under ~20% for typical 1–10 MiB reads; monitor spam metrics closely.
- Variable fee (locked at open, settled at completion): `retrieval_price_per_blob` per 128 KiB blob
  - derive from GiB retrieval target:
    - `retrieval_price_per_blob ≈ target_GiBRetrieval_price / 8192`
  - Dev/test: `target_GiBRetrieval_price = 0.05 NIL / GiB`
  - Mainnet: `target_GiBRetrieval_price = 0.10 NIL / GiB`
- Burn cut on completion: `retrieval_burn_bps`
  - Dev/test: 500 (5%)
  - Mainnet: 1000 (10%)

**Inflation decay / halving schedule:**
- Keep `HalvingIntervalBlocks` roughly “1 year in blocks” as a sticky parameter; allow governance to adjust base reward but avoid frequent halving-interval changes.

### B4) Repair/replacement selection policy (deterministic, anti-grind)

**Trigger repair when:**
- hard-fault evidence occurs (immediate), or
- `missed_epochs > evict_after_missed_epochs_{hot,cold}` (from HealthState)

**Deterministic candidate selection:**
- seed:
  - `seed = SHA256("nilstore/replace/v1" || R_e || deal_id || slot || current_gen || replace_nonce)`
- rank provider registry by `SHA256(seed || provider_addr)` and choose first eligible.

**Eligibility filter:**
- not jailed
- sufficient capacity (if tracked)
- sufficient bond (B2)
- not already in deal (including pending provider)
- meets protocol version constraints

**Anti-churn controls (proposed params):**
| Param | Default | Meaning |
|---|---:|---|
| `replacement_cooldown_blocks` | 7 days in blocks | limit replacement churn per slot |
| `max_repair_attempts_per_slot_per_window` | 3 | cap candidate attempts |
| `repair_attempt_window_blocks` | `MONTH_LEN_BLOCKS` | rolling window for attempts |

**Repeated failure fallback (behavioral rule):**
- After a slot hits `max_repair_attempts_per_slot_per_window`, enter a **repair backoff** until the attempt window resets (avoid thrash), and emit an operator-visible alert/event.
- Optional testnet ops escape hatch: a “trusted/top-bonded allowlist” override. On mainnet this must be governance-controlled (or omitted).

### B5) Deputy market compensation + evidence incentives + audit debt funding

**Proxy retrieval payment (premium):**
- Open proxy session locks `base_fee + variable_fee + premium_fee` from deal escrow.
- `premium_fee = ceil(variable_fee * premium_bps / 10_000)`
- Proposed `premium_bps`:
  - Dev/test: 2000 (20%)
  - Mainnet: 1000 (10%)
- On success: provider paid as normal; deputy receives `premium_fee`.

**Evidence incentives (non-response):**
- require deputy to lock `evidence_bond` when submitting proof-of-failure
- if conviction triggers within window: refund bond + pay `failure_bounty`
- if not convicted within window: partially burn bond (anti-grief)
- baseline default: burn **50%** of `evidence_bond` on TTL expiry and refund 50% (discourages spam without chilling reporting).

Suggested param for implementation:
- `evidence_bond_burn_bps_on_expiry = 5000` (burn 50% when a proof-of-failure does not result in conviction within TTL).

Proposed defaults:
| Param | Default |
|---|---:|
| `evidence_bond` | 0.01 NIL |
| `failure_bounty` | 0.02 NIL |
| `proof_of_failure_ttl_epochs` | `nonresponse_window_epochs` |

**Audit debt funding options:**
- Option A (recommended): protocol-funded audit budget (minted per epoch) pays audit retrieval traffic.
- Option B: SP-funded audits, reimbursed via storage rewards (simpler, more liquidity pressure).

**Option A implementation (closed): audit budget sizing + caps**

Define an “epoch slot rent” baseline:
- `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`

Mint audit budget as a bounded fraction of `epoch_slot_rent`:
- `audit_budget_mint = ceil(audit_budget_bps / 10_000 * epoch_slot_rent)`
- hard cap: `audit_budget_mint <= ceil(audit_budget_cap_bps / 10_000 * epoch_slot_rent)`
- carryover: allow unused budget to roll forward up to `audit_budget_carryover_epochs = 2` epochs (avoid unbounded accumulation).

Proposed params:
- Devnet/testnet: `audit_budget_bps=200` (2%), `audit_budget_cap_bps=500` (5%), `audit_budget_carryover_epochs=2`
- Mainnet: `audit_budget_bps=100` (1%), `audit_budget_cap_bps=200` (2%), `audit_budget_carryover_epochs=2`

Implementation note:
- `total_active_slot_bytes` should be computed deterministically from chain state (Mode 2 slots in `ACTIVE`, plus Mode 1 assignments), and must exclude `REPAIRING` slots.

### B6) Organic retrieval credits (quota reduction) — accrual + caps + phase-in

Adopt credit accrual rules per `rfcs/rfc-challenge-derivation-and-quotas.md`.

**Proposed caps:**
- `credit_cap_bps_hot = 5000` (up to 50% quota via credits)
- `credit_cap_bps_cold = 2500` (up to 25% quota via credits)

**Phase-in plan:**
- Devnet: implement accounting, set credit caps to 0 (no quota reduction yet)
- Testnet: enable conservative caps (hot 25%, cold 10%)
- Mainnet: **launch with caps = 0**; enable after determinism + evidence gates are green; then increase to target caps (hot 50%, cold 25%)

## Calibration Signals (Testnet Monitoring)

These are recommended dashboards/alerts before changing defaults.

### Slashing + jailing
- Invalid proof rate: target <0.1%, alert >0.5%.
- Wrong-data convictions: target ~0; any non-zero is severity-1 triage.
- Non-response conviction rate: target <1% of sessions, alert >3%.
- Jailed provider share: target <5%, alert >10% sustained.
- Repair triggers/day from soft failures: hot target <0.5%/day, cold <0.2%/day.

### Provider bonding
- Participation: active providers with bond ≥ min and meeting collateral requirement (expect growth; alert on plateau).
- Candidate rejected for insufficient bond: target ~0 after initial week; alert >1% of selections.
- Bond headroom distribution: target median >25%; alert if many near ~0%.
- Assignment concentration: top-10 providers’ share of slot bytes (target <60% early; alert if increasing).

### Pricing
- Affordability: median escrow duration at creation ≥ requested duration; alert on systematic underfunding.
- Retrieval spam: sessions opened per block per address; alert if one address dominates (>5%/hour).
- Base fee share for 1–10 MiB reads: target <20%; alert if base fee dominates typical reads.
- Burn/mint ratio: track; alert if burn ≈0 (no sink) or >30% (may starve incentives).

### Replacement + churn
- Repair completion latency (start→promotion): track median/P95 by service class.
- First-candidate success rate: target >70%; alert <40%.
- Replacements per slot per month: target <0.2; alert >1.0.
- Slots hitting attempt cap: target ~0; alert on repeated caps (tooling/eligibility issues).

### Deputy + audit debt
- Proxy success rate: target >99%; track time-to-first-byte P95 vs SLA.
- Deputy-served fraction of retrievals: target <1%; alert >5%.
- Evidence quality: convictions/submissions target 30–70%; alert <10% (spam) or >90% (systemic outage).
- Audit debt backlog: target clears in <2 epochs; alert if sustained growth.
- Audit budget utilization: `spent/minted` per epoch; alert if >95% (cap binding) or <10% sustained (overmint or not used).
- Audit budget fairness: distribution of audit spend across providers; alert if top-10 consume >60% without matching slot-byte share.

### Credits
- Credit usage vs cap: monitor `credits_blobs/quota_blobs` by hot/cold; alert if many hit cap immediately.
- Synthetic coverage floor: hot ≥50%, cold ≥75% (given caps).
- Duplicate attempts rate: repeated credit ids rejected (wash indicators).
- State growth: per-epoch credit uniqueness set size; alert if pruning lags.

## A) Delivery Plan — Staged Roadmap (Test-Gated)

This aligns with the “A) well-defined steps” in `MAINNET_ECON_PARITY_CHECKLIST.md`.

0) Policy freeze → encode params + interfaces (unblocks engineering)
1) Storage lock-in pricing + escrow accounting + spend windows
2) Retrieval session fee lifecycle (burn/lock/settle/refund)
3) Deterministic challenge derivation + quotas + synthetic fill scheduling
4) HealthState + eviction curve (soft failures → repair triggers)
5) Mode 2 make-before-break repair + promotion + read routing around REPAIRING
6) Evidence / fraud proofs pipeline (verify + replay-protect + penalty wiring)
7) Deputy market + audit debt end-to-end (proxy retrieval + evidence aggregation + compensation)

Each stage should ship with its own test gate (keeper unit tests and/or e2e scripts), as specified in `MAINNET_GAP_TRACKER.md`.

## Risks if policy is deferred (top 5)

1) Slashing not economically material → “honesty is optional.”
2) Undercollateralized providers → slashing does not deter large deal cheating.
3) Replacement grinding/churn → capture or instability via repeated replacements.
4) Deputy market never clears → ghosting providers become unrecoverable outages.
5) Quota/credit instability → either no coverage (too many credits) or too strict (provider churn).

## Open items (explicitly contentious)

These are “agree on targets” items rather than “can’t implement” items:
- the exact **bps** values and jail durations (B1) vs observed fault rates
- bond sizes (B2) vs operator constraints on testnet
- pricing targets (B3) vs target UX and provider costs
- base retrieval fee level (B3): baseline is low; if spam emerges, increase carefully to preserve small-read UX
- evidence-bond burn fraction (B5): baseline is 50% but can be tuned if it chills reporting or invites spam
- credit cap phase-in schedule (B6) vs measurable determinism confidence
- “trusted allowlist override” for repeated repair failures: whether to allow on testnet, and how it is governance-gated (or omitted) on mainnet

```

```ECONOMY.md
# NilStore Economy & Tokenomics

## Overview

The NilStore economy is designed to align incentives between Storage Providers (SPs), Data Owners (Users), and the Protocol itself using a single utility token: **$NIL** ($STOR). The model enforces physical infrastructure commitment while enabling elastic, user-funded scaling.

## 1. The Performance Market (Proof-of-Useful-Data)

Unlike "Space Race" models that reward random data filling, NilStore rewards **latency**.

### 1.1 Unified Liveness
Storage proofs (`MsgProveLiveness`) serve two functions:
1.  **Storage Audit:** Proves the SP holds the data (PoUD via KZG).
2.  **Performance Check:** The block height of proof inclusion determines the reward tier.

### 1.2 Tiered Rewards
Rewards are calculated based on the delay between the **Challenge Block** and the **Proof Inclusion Block**.

**Note:** The tier windows and multipliers below are illustrative examples; the canonical tier cutoffs are protocol parameters (see `spec.md`).

| Tier | Latency (Blocks) | Reward Multiplier | Requirement |
| :--- | :--- | :--- | :--- |
| **Platinum** | 0 - 1 | 100% | NVMe / RAM |
| **Gold** | 2 - 5 | 80% | SSD |
| **Silver** | 6 - 10 | 50% | HDD |
| **Fail** | > 10 | 0% (Slash) | Offline / Glacier |

### 1.3 Inflationary Decay
The base reward per proof follows a halving schedule to cap total supply.
`Reward = BaseReward * (1 / 2 ^ (BlockHeight / HalvingInterval))`

## 2. Elasticity & Scaling

NilStore allows data to scale automatically to meet demand without manual intervention.

### 2.1 Virtual Stripes
A file is stored on a "Stripe" (12 providers). If these providers become saturated (high latency or load), they can signal saturation (`MsgSignalSaturation`).

### 2.2 The Budget Check
The protocol checks the Data Owner's `MaxMonthlySpend` limit.
*   **If Budget Allows:** The protocol spawns a new "Virtual Stripe" (12 new providers) and replicates the data "Hot".
*   **If Budget Exceeded:** The scaling request is denied to protect the user's wallet.

## 3. Token Flow

### 3.1 Inflow (Users)
Users fund deals by depositing $NIL into **Escrow**.
*   `MsgCreateDeal`: Initial deposit.
*   `MsgAddCredit`: Top-up escrow.

### 3.2 Outflow (Providers)
Providers earn tokens via:
1.  **Inflation:** Minted $NIL for valid proofs (Base Capacity Reward).
2.  **Bandwidth Fees:** Paid from User Escrow for retrieval receipts.

### 3.3 Sinks (Burning)
*   **Slashing:** Example policy: missed proofs / non-response violations trigger a slash and potential jailing. Exact windows and amounts are protocol parameters.
*   **Burner:** The `polystorechain` module has burn permissions to remove slashed assets from circulation.

## 5. Protocol Parameters (Proposal Defaults)

This section records **baseline defaults** intended to unblock implementation and testnet calibration.

Canonical accounting rules are frozen in `rfcs/rfc-pricing-and-escrow-accounting.md`. Policy defaults and open questions are tracked in `notes/mainnet_policy_resolution_jan2026.md`.

### 5.1 Storage Price (Lock-in at Ingest)

Derive `storage_price` (Dec per byte per block) from a human target “GiB-month price”:

`storage_price = target_GiBMonth_price / (GiB * MONTH_LEN_BLOCKS)`

Proposed targets:
- Devnet/testnet: `0.10 NIL / GiB-month`
- Mainnet: `1.00 NIL / GiB-month`

### 5.2 Retrieval Fees (Session Settlement)

- `base_retrieval_fee`: burned at session open (anti-spam).
  - Devnet/testnet: `0.0001 NIL`
  - Mainnet: `0.0002 NIL`
- `retrieval_price_per_blob`: locked at session open; settled at completion; per `128 KiB` blob.
  - derive from a GiB target: `retrieval_price_per_blob ≈ target_GiBRetrieval_price / 8192`
  - Devnet/testnet: `0.05 NIL / GiB`
  - Mainnet: `0.10 NIL / GiB`
- `retrieval_burn_bps`: burn cut on completion.
  - Devnet/testnet: `500` (5%)
  - Mainnet: `1000` (10%)

### 5.3 Slashing/Jailing Ladder (Hard vs Soft Failures)

Proposed intent:
- Invalid proofs / wrong-data proofs are **hard faults** (slash immediately).
- Non-response is **thresholded** (convict only after N failures within a window).
- Quota shortfall is **soft** (HealthState decay → repair/evict; no slash by default).

See `notes/mainnet_policy_resolution_jan2026.md` for the proposed parameter table.

### 5.4 Provider Bonding

Proposed model:
- a base provider bond (anti-sybil), plus
- assignment collateral scaled by slot bytes and `storage_price`.

See `notes/mainnet_policy_resolution_jan2026.md`.

### 5.5 Deputy Market + Audit Debt (Defaults)

Baseline decisions:
- Audit debt funding: Option A (protocol-funded audit budget).
- Proxy retrieval premium: 20% (devnet/testnet), 10% (mainnet).
- Non-response evidence incentives: `evidence_bond=0.01 NIL`, `failure_bounty=0.02 NIL`, burn 50% of evidence bond on TTL expiry.

Audit budget sizing (Option A):
- Define: `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`
- Mint: `audit_budget_mint = ceil(audit_budget_bps/10_000 * epoch_slot_rent)`, capped by `audit_budget_cap_bps`.
- Carryover: unused budget may roll forward up to 2 epochs (bounded).
- Defaults:
  - Devnet/testnet: `audit_budget_bps=200`, `audit_budget_cap_bps=500`, carryover≤2 epochs
  - Mainnet: `audit_budget_bps=100`, `audit_budget_cap_bps=200`, carryover≤2 epochs

See `notes/mainnet_policy_resolution_jan2026.md`.

### 5.6 Credits (Organic Retrieval → Quota Reduction)

Baseline phase-in:
- Devnet: accounting only; credits do not reduce quota (caps=0).
- Testnet: credits enabled with conservative caps (hot 25%, cold 10%).
- Mainnet: launch with caps=0; enable later after determinism + evidence gates are green.

See `notes/mainnet_policy_resolution_jan2026.md`.

## 4. S3 Adapter (Web2 Gateway)

The `polystore_gateway` adapter allows Web2 applications to write to NilStore using standard S3 APIs.
*   **PUT:** Shards file -> Computes KZG -> Creates Deal on Chain.
*   **GET:** Retrieves shards -> Verifies KZG -> Reconstructs File.

```

```retrievability-memo.md
# NilStore Retrievability Memo – Problem Statement

## 1. Purpose

Define the precise retrievability guarantee NilStore aims to provide and the conditions under which Storage Providers (SPs) must be punished when they fail to uphold it. This memo is intentionally **problem‑only**: no protocol design, only what must be true of the system’s behavior.

---

## 2. Core Invariants

For every active Deal and its assigned Storage Providers, the retrieval subsystem must enforce **both** of the following:

1. **Retrievability / Accountability**

   > **Either** the encrypted data is reliably retrievable when requested under the protocol’s rules,  
   > **or** there exists (with very high probability) a verifiable record of SP failure that leads to economic or reputational punishment.

2. **Self‑Healing Placement**

   > When an SP’s observed performance on a Deal is persistently below protocol thresholds  
   > (too many failed/slow challenges, bad proofs, or missing retrievals),  
   > that SP must be **automatically removed** from that Deal’s replica set and replaced by healthier SPs.

“Implementation detail” in this context includes *how* we probe, *who* probes (users, SPs, auditors), *how* we measure performance, and *how* we repair replication, as long as these invariants are enforced.

---

## 3. Actors and Roles (at this layer)

- **Data Owner / Payer (Client)**  
  Creates Deals, pays for storage and bandwidth. May be online frequently (hot data) or rarely (archive).

- **Storage Providers (SPs)**  
  Hold ciphertext for assigned Deals and are paid to store and serve it. Subject to rewards and slashing.

- **Auditors / Watchers (could be SPs, clients, or third parties)**  
  Perform retrievals or checks that can expose SP misbehavior. May be “declared” or “secret”.

- **Protocol / Chain**  
  Assigns Deals to SPs, defines challenge schedules, verifies proofs/receipts, and applies rewards/slashing.

---

## 4. What “Retrievable Reliably” Means (Problem-Level)

We need a minimal, protocol‑level notion of “reliably retrievable” that is testable and enforceable:

- **Liveness:**
  - There exists a defined set of conditions under which a retrieval is considered a valid test:
    - Request format, challenge parameters, allowed time window, etc.
  - Under those conditions, an honest SP:
    - Responds within the protocol’s latency bounds (accounting for network jitter),
    - Serves the correct ciphertext for the requested parts of the Deal.

- **Correctness:**
  - The data returned can be objectively checked against the Deal’s on‑chain commitments (e.g. via KZG/Merkle proofs).
  - “Close enough” is **not** acceptable: for the purposes of enforcement, data is either correct (passes cryptographic checks) or wrong.

- **Repeatability / predictability:**
  - The rules for when a retrieval test counts (what counts as a “challenge”) are known and fixed in the protocol.
  - Clients and auditors can know beforehand what kind of retrievals are admissible as evidence.

We are *not* trying to guarantee that *every* arbitrary HTTP fetch succeeds (networks fail); we’re guaranteeing that **protocol‑valid retrieval attempts** either succeed or give us punishable evidence.

---

## 5. Failure Modes We Care About

We are specifically trying to catch and punish:

1. **Non-response / unavailability**
   - SP does not respond to valid retrieval attempts within the allowed window.
   - SP is persistently offline or overloaded for assigned Deals.

2. **Wrong data**
   - SP returns ciphertext that does not match the Deal’s committed data, detectable via proofs.

3. **Selective behavior**
   - SP behaves correctly for some requests and systematically fails others (e.g., censoring particular deals or clients, or only passing obvious audits).

4. **On-demand fetching / lazy SPs**
   - SP tries to reconstruct data on the fly from elsewhere (e.g., S3) in a way that systematically violates the agreed performance profile (too slow, not actually storing).

We explicitly want a system where **sustained** versions of these behaviors are economically irrational because they get exposed and punished with high probability.

---

## 6. Evidence Requirements

For the invariant to be meaningful, the system must be able to produce **objective evidence** of failure when an SP does not make data retrievable. That implies:

- **Verifiability:**
  - Any alleged failure must come with a transcript and/or proof that:
    - A valid retrieval challenge was issued,
    - The SP’s response (or lack thereof) violated protocol rules,
    - The cryptographic checks (KZG, Merkle, signatures) support that conclusion.
  - This evidence must be checkable on‑chain or by all parties off‑chain in a consistent way.

- **Attribution:**
  - The evidence must clearly identify:
    - Which SP is at fault,
    - Which Deal (and possibly which chunk/MDU) was involved,
    - When (epoch/height) the failure occurred.

- **Non‑forgeability:**
  - SPs cannot fabricate “fake” client failures against competitors.
  - Clients/auditors cannot forge SP misbehavior; they can only record what actually happened.

Without such evidence, “punish SPs” degenerates into heuristics and reputation; the retrievability invariant is then not enforceable.

---

## 7. Coverage Requirements

To punish SPs reliably, we need sufficient **coverage** of tests over time:

- **Per SP / per Deal coverage:**
  - For each `(SP, Deal)` pair, there must be enough retrieval‑like or proof‑like challenges over the lifetime of the Deal to:
    - Detect cheating with high probability before the SP has collected most of the rewards.
- **Under client dormancy:**
  - Even if the original client goes completely offline (archive use case), the system must still:
    - Generate enough checks (via synthetic challenges, SP audits, or delegated auditors),
    - To expose SPs that have dropped data or stopped serving.

This is where ideas like “SP audit debt proportional to data stored” come in: they are mechanisms to ensure **coverage scales with storage**, but they are secondary to the requirement that coverage exists.

---

## 8. Punishment Requirements

Once evidence of failure exists, punishment must be:

- **Predictable:**
  - The rules for slashing or reward loss are fixed in the protocol.
  - SPs can compute expected penalties from cheating.

- **Material:**
  - The economic loss from being caught (slashing + lost future rewards) must outweigh the savings from not storing or serving data.
  - Repeated offenses should be more expensive (e.g., escalating penalties, jailing, or exclusion from future Deals).

- **Timely:**
  - Punishment should arrive “close enough” in time to the misbehavior that it meaningfully alters incentives; if SPs can cheat for long periods before any risk, the invariant weakens.

The exact slashing function and parameters are an implementation detail; what matters at the problem level is that **cheating SPs are measurably worse off than honest ones** over any reasonable time horizon.

---

## 9. Self‑Healing Requirements (Placement Repair)

Punishment alone is not sufficient; the system must also **heal itself** when SPs underperform. That implies:

- **Per‑(SP, Deal) health tracking:**
  - The protocol maintains some notion of health or reliability for each `(SP, Deal)` pair, derived from:
    - Failed or slow retrieval challenges,
    - Failed synthetic proofs,
    - Severe or repeated QoS violations.

- **Automatic eviction from Deals:**
  - If an SP’s health for a given Deal crosses a “bad enough” threshold (as defined by the protocol):
    - That SP must be **marked unhealthy** for that Deal,
    - Scheduled for **eviction** from the Deal’s replica set once safe.

- **Safe re‑replication:**
  - Before fully evicting a failing SP, the protocol must:
    - Recruit replacement SPs for the Deal according to the placement rules,
    - Ensure new replicas have come online and passed initial liveness checks,
    - Only then remove the failing SP from `Deal.providers[]` (or its equivalent).

- **Global consequences for chronically bad SPs:**
  - If an SP is unhealthy across many Deals, the same evidence and health metrics should escalate to:
    - Jailing or suspension (no new Deals),
    - Stronger slashing,
    - Eventual deregistration if misbehavior persists.

The exact health metric, thresholds, and replacement strategy are implementation details. At the problem level we require that:

- Deals are not left indefinitely assigned to SPs that repeatedly fail retrieval challenges.
- Over time, each Deal’s replica set tends to consist only of SPs that actually meet the retrievability guarantee.

---

## 10. Non‑Goals / Out-of-scope for this problem statement

To keep the problem focused, we’re **not** requiring that:

- Clients never free‑ride (a malicious client can always download and then refuse to admit it).
- The system perfectly hides who is a client vs auditor vs SP (full anonymity / traffic analysis resistance).
- Every occasional network glitch is punished; the goal is to punish **systematic**, protocol‑level misbehavior, not random packet loss.

We only require that:

- Honest SPs can satisfy the retrievability conditions with very low risk of punishment.
- Dishonest SPs who drop data, refuse service, or serve bad data **cannot** systematically avoid punishment.

---

## 11. Restated Goal

NilStore’s retrieval subsystem must be designed so that, for every SP and every Deal they accept:

1. There is a well‑defined notion of a **valid retrieval challenge** and response;
2. The system continuously or periodically exercises those challenges with sufficient coverage;
3. Whenever an SP fails these challenges, there is a high chance of producing **verifiable, attributable, non‑forgeable evidence**; and
4. Given that evidence, the protocol **must** inflict material economic penalty on the SP; and
5. Persistently underperforming SPs are **automatically removed and replaced** in the Deals they serve, so that replication and service quality are restored without manual intervention.

All other design choices (who issues challenges, how we hide audits, SP audit debt, onion fallback, etc.) are judged by how well they help satisfy this invariant.

```

```rfc-pricing-and-escrow-accounting.md
# RFC: Pricing & Escrow Accounting (Lock-in + Retrieval Fees + Elasticity Caps)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain economics (`polystorechain/`) + gateway/UI intent fields
**Motivation:** `spec.md` §6.1–§6.2, §7.2.1; Appendix B #5
**Depends on:** `rfcs/rfc-data-granularity-and-economics.md`

---

## 0. Executive Summary

This RFC freezes the **economic accounting contracts** required for mainnet hardening:
- **Storage lock-in pricing** at ingest (`UpdateDealContent*`) using `storage_price` (Dec per byte per block)
- **Retrieval fees** via session-based settlement (base fee burn + per-blob variable fee lock, then burn cut + provider payout)
- **User-funded elasticity caps** enforced via `Deal.max_monthly_spend` and a deterministic spend window

This RFC intentionally does **not** introduce retrieval “credits” for Gamma‑4. Credits may be introduced later once quota enforcement exists (see `rfcs/rfc-challenge-derivation-and-quotas.md`).

---

## 1. Canonical Denoms & Accounts (Frozen)

### 1.1 Denom
- All fees/deposits are in `sdk.DefaultBondDenom` (devnet: `stake`).

### 1.2 Module accounts
- `authtypes.FeeCollectorName`: receives `deal_creation_fee`.
- `types.ModuleName` (`polystorechain` module account): holds escrow and performs burns/transfers for retrieval settlement.

---

## 2. Parameters (Frozen)

From `polystorechain/polystorechain/v1/params.proto`:
- `deal_creation_fee: Coin`
- `min_duration_blocks: uint64`
- `storage_price: Dec` (per byte per block)
- `base_retrieval_fee: Coin` (burned at session open)
- `retrieval_price_per_blob: Coin` (locked at session open)
- `retrieval_burn_bps: uint64` (basis points of variable fee burned on completion)
- `base_stripe_cost: uint64` (unit cost used for elasticity budgeting; denom = bond denom)

From Deal state:
- `max_monthly_spend: Int` (cap for user-funded elasticity)
- `escrow_balance: Int` (remaining funds available to pay protocol-defined charges)

---

## 3. Deal Lifecycle Charges (Frozen)

### 3.1 CreateDeal (`MsgCreateDeal*`)
**Inputs:** `duration_blocks`, `initial_escrow_amount`, `max_monthly_spend`, `service_hint`

**Validation:**
- `duration_blocks >= min_duration_blocks`
- `initial_escrow_amount >= 0`
- `max_monthly_spend >= 0`

**Accounting:**
1. If `deal_creation_fee > 0`, transfer `deal_creation_fee` from creator → fee collector.
2. If `initial_escrow_amount > 0`, transfer `initial_escrow_amount` from creator → module account.
3. Initialize deal with:
   - `manifest_root = empty`
   - `size_bytes = 0`
   - `total_mdus = 0` (until first commit; see `rfcs/rfc-mode2-onchain-state.md`)
   - `escrow_balance = initial_escrow_amount`

### 3.2 AddCredit (`MsgAddCredit`)
Transfers `amount` from sender → module account and increments `Deal.escrow_balance += amount`.

---

## 4. Storage Lock-in Pricing (Frozen)

### 4.1 UpdateDealContent (`MsgUpdateDealContent*`)
When content is committed and `size_bytes` increases, the protocol charges a **term deposit** at the current `storage_price`.

Let:
- `old_size = Deal.size_bytes`
- `new_size = msg.size_bytes`
- `delta = max(0, new_size - old_size)`
- `duration = Deal.end_block - Deal.start_block` (fixed at deal creation for v1)

**Cost function:**
```
storage_cost = ceil(storage_price * delta * duration)
```

**Accounting:**
- If `storage_cost > 0`, transfer `storage_cost` from owner → module account.
- Update `Deal.escrow_balance += storage_cost`.

**Normative properties:**
- Only incremental bytes are charged at the new spot price.
- Previously committed bytes are not repriced.

### 4.2 Future extension (out of scope)
Extending lifetime past `end_block` requires a `MsgExtendDeal` (or equivalent) and a lock-in charge using the spot `storage_price` at extension time.

---

## 5. Retrieval Fees (Gamma‑4, Frozen)

This section is normative and matches `spec.md` §7.2.1.

### 5.1 Session open (`MsgOpenRetrievalSession`)
Let:
- `blob_count` be the requested contiguous blob-range length (128 KiB units)
- `base_fee = Params.base_retrieval_fee`
- `variable_fee = Params.retrieval_price_per_blob * blob_count`
- `total = base_fee + variable_fee`

**Must-fail conditions:**
- `Deal.escrow_balance < total` → reject
- `manifest_root` must match `Deal.manifest_root` (pin)

**Accounting at open:**
1. Burn `base_fee` from module account (non-refundable).
2. Lock `variable_fee` against the session and decrement deal escrow:
   - `Deal.escrow_balance -= (base_fee + variable_fee)`
   - `session.locked_fee = variable_fee` (store on session object)

### 5.2 Completion (`MsgConfirmRetrievalSession` + proof present)
On transition to `COMPLETED`, settle the locked variable fee:

```
burn_cut = ceil(variable_fee * retrieval_burn_bps / 10_000)
payout   = variable_fee - burn_cut
```

**Accounting:**
- Burn `burn_cut` from module account.
- Transfer `payout` from module account → provider account.

### 5.3 Expiry/cancel (refund path)
If a session expires without completion, the owner may cancel:
- `MsgCancelRetrievalSession` unlocks the remaining `session.locked_fee` and refunds it to `Deal.escrow_balance`.
- Base fee is never refunded.

---

## 6. Elasticity Spend Caps (Freeze)

Elasticity is user-funded and must be bounded by `Deal.max_monthly_spend` (a cap) and `Deal.escrow_balance` (available funds).

### 6.1 Spend window
Define:
- `MONTH_LEN_BLOCKS` (param; e.g. 30 days worth of blocks)

Add per-deal accounting fields:
- `spend_window_start_height: uint64`
- `spend_window_spent: Int`

Window logic (deterministic):
- If `height >= spend_window_start_height + MONTH_LEN_BLOCKS`, reset:
  - `spend_window_start_height = height`
  - `spend_window_spent = 0`

### 6.2 Scaling event cost
For any elasticity action that increases replication/overlays by `delta_replication`:

```
elasticity_cost = base_stripe_cost * delta_replication
```

**Must-fail:**
- `spend_window_spent + elasticity_cost > max_monthly_spend`
- `Deal.escrow_balance < elasticity_cost`

**Accounting:**
- `Deal.escrow_balance -= elasticity_cost`
- `spend_window_spent += elasticity_cost`

**Implementation note:** current devnet `MsgSignalSaturation` enforces the cap but does not debit; mainnet requires the debit.

---

## 7. Required Interface/State Changes (for implementation sprints)

1. `Deal` fields (if not already present):
   - `spend_window_start_height`
   - `spend_window_spent`
2. Ensure `UpdateDealContent*` continues to carry `size_bytes` (and, per Sprint‑0 naming freeze, also carries `total_mdus` + `witness_mdus`; see `rfcs/rfc-mode2-onchain-state.md`).
3. Ensure retrieval session settlement burns/transfers use module account funds and update `Deal.escrow_balance` deterministically.

---

## 8. Test Gates (for later sprints)

- Storage lock-in: update content with increasing size charges `delta*duration*price` and rejects if insufficient funds.
- Retrieval fees: open burns base fee, locks variable, completion burns cut + pays provider, cancel refunds variable.
- Elasticity: scaling denied when exceeding `max_monthly_spend` or `escrow_balance`.


```

```rfc-challenge-derivation-and-quotas.md
# RFC: Challenge Derivation & Proof Quota Policy (Unified Liveness v1)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain protocol policy (`polystorechain/`)
**Motivation:** `spec.md` §7.6; Appendix B #3 (challenge derivation), #4 (quota + penalty curve)
**Depends on:** `spec.md`, `rfcs/rfc-mode2-onchain-state.md`, `rfcs/rfc-blob-alignment-and-striping.md`

---

## 0. Executive Summary

NilStore’s “Unified Liveness” requires the chain to deterministically answer:
1. **What** positions a provider must prove for a given epoch (synthetic challenges)
2. **How many** proofs are required (quota)
3. **How organic retrieval** reduces synthetic demand (credits)
4. **What happens** when a provider is invalid vs merely non-compliant (penalty curve)

This RFC freezes:
- a deterministic, anti-grind challenge derivation function
- a quota computation function with explicit parameters
- an accounting model for credits and synthetic fills
- enforcement + penalty outcomes (invalid proof slashing vs quota failure health decay)

---

## 1. Definitions

### 1.1 Epoch
NilStore defines a **liveness epoch** with fixed length:
- `EPOCH_LEN_BLOCKS` (param; e.g. 100 blocks)
- `epoch_id = floor(block_height / EPOCH_LEN_BLOCKS)`

### 1.2 Assignment
An **assignment** is:
- Mode 1: `(deal_id, provider)` where `provider ∈ Deal.providers[]`
- Mode 2: `(deal_id, slot)` where `slot ∈ [0..K+M-1]` and `slot.provider` is the accountable provider

### 1.3 Challenge position
A synthetic challenge position is a pair:
- `(mdu_index, blob_index)`
  - Mode 1: `blob_index ∈ [0..63]` (Blob within MDU)
  - Mode 2: `blob_index` MUST be interpreted as `leaf_index` per slot-major ordering (§8.1.3); `blob_index ∈ [0..leafCount-1]`

### 1.4 Credit
A **credit** is a unit of evidence earned via organic retrieval that reduces synthetic demand.
This RFC accounts credits in **blob-proofs** (not bytes) to avoid ambiguity across Mode 1 vs Mode 2.

---

## 2. Required Chain Inputs (Frozen)

Challenge derivation and quota computation MUST be computable from:
- current block height (for epoch)
- `Deal`: `redundancy_mode`, `service_hint` (legacy), `providers[]`
- **Frozen additions:** `Deal.total_mdus`, `Deal.witness_mdus`, and for Mode 2 the explicit `(K,M)` and slot order (see `rfcs/rfc-mode2-onchain-state.md`)
- epoch randomness `R_e` (see §3.1)
- per-epoch counters for credits + satisfied synthetic challenges (new state; see §5)

---

## 3. Deterministic Challenge Derivation (Anti-grind)

### 3.0 Canonical encoding (must be deterministic)
Unless otherwise stated, hashes are computed over byte concatenation using:
- `U64BE(x)`: 8-byte big-endian unsigned integer
- `U32BE(x)`: 4-byte big-endian unsigned integer
- `ADDR20(provider)`: 20-byte account address obtained by bech32-decoding the provider string (reject invalid)

`SHA256(tag || …)` means SHA-256 over the concatenated byte slices, where `tag` is ASCII bytes.

### 3.1 Epoch randomness
Define the epoch seed as:

```
epoch_start_height = epoch_id * EPOCH_LEN_BLOCKS
R_e = SHA256("nilstore/epoch/v1" || chain_id || epoch_id || block_hash(epoch_start_height))
```

Rationale:
- deterministic and locally computable by all nodes
- unpredictable prior to the epoch boundary (assuming honest majority of validators)
- does not rely on any off-chain RNG or trusted beacon

### 3.2 Challenge set size
For each assignment, the chain derives a target challenge count:

```
quota_blobs = required_blobs(deal, assignment, epoch_id)        // §4
credits_blobs = credits_applied(deal, assignment, epoch_id)      // §5
synthetic_needed = max(0, quota_blobs - credits_blobs)
```

The synthetic challenge set for the assignment is:
- `S_e(deal, assignment) = { C_i | i ∈ [0..synthetic_needed-1] }`

### 3.3 Mode 2: slot-major derivation

Let:
- `K,M` be the deal’s Mode 2 profile
- `N = K+M`
- `rows = 64 / K`
- `leafCount = N * rows`
- `meta_mdus = 1 + witness_mdus`
- `user_mdus = total_mdus - meta_mdus` (must be > 0 for challenges)

For slot `s ∈ [0..N-1]` and challenge ordinal `i`:

```
seed = SHA256("nilstore/chal/v1" || R_e || U64BE(deal_id) || U64BE(current_gen) || U64BE(slot) || U64BE(i))
mdu_ordinal = U64BE(seed[0..8]) % user_mdus
row        = U64BE(seed[8..16]) % rows

mdu_index  = meta_mdus + mdu_ordinal
leaf_index = slot*rows + row
```

The challenge position is `(mdu_index, blob_index=leaf_index)`.

**Exclusions (frozen):**
- Synthetic challenges MUST NOT target metadata MDUs (`mdu_index < meta_mdus`).
- Synthetic challenges MUST NOT target Mode 2 slots with `status != ACTIVE` (repairing slots are excluded).

### 3.4 Mode 1: replica derivation

Let:
- `meta_mdus = 1 + witness_mdus`
- `user_mdus = total_mdus - meta_mdus`

For provider `P` and challenge ordinal `i`:

```
seed = SHA256("nilstore/chal/v1" || R_e || U64BE(deal_id) || U64BE(current_gen) || ADDR20(provider) || U64BE(i))
mdu_ordinal = U64BE(seed[0..8]) % user_mdus
blob_index  = U64BE(seed[8..16]) % 64
mdu_index   = meta_mdus + mdu_ordinal
```

The challenge position is `(mdu_index, blob_index)`.

---

## 4. Required Proof Quota (Policy Freeze)

### 4.1 Parameters
All of the following are chain params:
- `quota_bps_per_epoch_hot` (basis points of stored bytes proved per epoch)
- `quota_bps_per_epoch_cold`
- `quota_min_blobs` (floor)
- `quota_max_blobs` (cap)
- `credit_cap_bps` (max fraction of quota satisfiable via credits)

### 4.2 Normalized “slot bytes”
Quota targets are computed over **slot-responsible bytes** (not entire deal bytes):
- Mode 2: each slot stores `rows * BLOB_SIZE` per user MDU.
  - `slot_bytes = user_mdus * rows * BLOB_SIZE`
- Mode 1: each provider stores full MDUs.
  - `slot_bytes = user_mdus * MDU_SIZE`

### 4.3 Required blobs function

```
quota_bps = (service_hint_base == Hot) ? quota_bps_per_epoch_hot : quota_bps_per_epoch_cold
target_bytes = ceil(slot_bytes * quota_bps / 10_000)
target_blobs = ceil(target_bytes / BLOB_SIZE)
quota_blobs  = clamp(quota_min_blobs, target_blobs, quota_max_blobs)
```

Notes:
- using `BLOB_SIZE` as the unit makes Mode 1 and Mode 2 comparable
- caps ensure quotas remain operationally feasible on low-end nodes

---

## 5. Credit Accounting (Organic Retrieval → Quota Reduction)

### 5.1 What counts as credit
Credits accrue from **completed user retrieval** evidence paths that include valid blob proofs:
- `MsgSubmitRetrievalSessionProof` (preferred)
- `MsgProveLiveness` receipt paths (`user_receipt`, `user_receipt_batch`) while in transition

### 5.2 Credit unit
Each *unique proved blob* counts as **1 credit blob**.
- A session proof covering `blob_count` blobs yields `blob_count` credits, subject to caps.

### 5.3 Credit caps (anti-wash + determinism)
To prevent a single large download from satisfying all synthetic demand indefinitely:
- credits applied per `(deal, assignment, epoch)` are capped:

```
credit_cap = ceil(quota_blobs * credit_cap_bps / 10_000)
credits_blobs = min(credit_cap, unique_proved_blobs_in_epoch)
```

Uniqueness is enforced by storing a per-epoch set keyed by:
`credit_id = SHA256("nilstore/credit/v1" || epoch_id || deal_id || assignment || mdu_index || blob_index)`.

---

## 6. Enforcement & Penalty Curve (Freeze)

### 6.0 Proof acceptance rules (must-fail)
- `system_proof` MUST match one derived synthetic challenge for that assignment and epoch.
  - The chain checks membership by recomputing `C_i` for `i ∈ [0..synthetic_needed-1]` and comparing `(mdu_index, blob_index)`.
  - Duplicate synthetic proofs for the same `(epoch, assignment, mdu_index, blob_index)` MUST NOT be double-counted.
- `session_proof` and receipt paths MAY be outside the synthetic challenge set; they still accrue credits (§5).

### 6.1 Invalid proofs (hard failures)
- A proof that fails verification MUST be slashable immediately (existing devnet behavior).
- Invalid proofs also increment an assignment health failure counter (see `CHAIN-103`).

### 6.2 Quota shortfall (soft failures)
- If, at epoch end, `credits_blobs + satisfied_synthetic_blobs < quota_blobs`, the assignment is **non-compliant**.
- Non-compliance is NOT immediately slashable by default; it:
  - decays the assignment’s `HealthState`
  - reduces placement priority
  - increments a rolling `missed_epochs` counter

### 6.3 Eviction trigger (policy hook)
When `missed_epochs` exceeds `evict_after_missed_epochs` (param), the chain SHOULD:
- mark the slot as `REPAIRING`
- select and attach a `pending_provider` candidate (see `rfcs/rfc-mode2-onchain-state.md`)

---

## 7. Required State Additions (for implementation sprints)

To implement the above without storing per-proof raw history, add collections:

- `QuotaState(deal_id, assignment, epoch_id)`:
  - `quota_blobs`
  - `credits_blobs`
  - `synthetic_satisfied_blobs`
  - `missed_epochs` (rolling)

- `CreditSeen(credit_id)` with TTL to prevent replay/double-counting.
- `SyntheticSeen(challenge_id)` to prevent counting the same synthetic proof twice.

All keys are deterministic hashes to keep store keys bounded.

---

## 8. Test Gates (for later sprints)

- Determinism tests: same chain state + epoch → identical challenge set across nodes.
- Anti-grind tests: challenge set changes with epoch; cannot be precomputed far in advance.
- E2E: no organic traffic → synthetic proofs required; with organic traffic → synthetic needed drops.

```

```rfc-mode2-onchain-state.md
# RFC: Mode 2 On-Chain State (Slots, Generations, Repairs)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain protocol state (`polystorechain/`)
**Depends on:** `spec.md` §6.2, §8.3–§8.4; `rfcs/rfc-blob-alignment-and-striping.md`
**Motivation:** Appendix B #2 (Mode 2 encoding), #6 (write semantics beyond append-only; near-term constraints)

---

## 0. Executive Summary

Devnet Mode 2 currently relies on **implicit encoding**:
- `(K,M)` is derived by parsing `Deal.service_hint` (`rs=K+M`)
- `Deal.providers[]` is treated as the slot order (by convention)

Mainnet requires **explicit typed state** so the chain can:
- enforce invariants (slot ordering, RS profile consistency)
- coordinate **repairs and make‑before‑break replacement**
- derive deterministic per-slot policy (synthetic challenges, quotas, health)

This RFC freezes a **concrete on-chain representation** for Mode 2 and a minimal lifecycle state machine that is forward-compatible with “pending generation” writes later.

---

## 1. Definitions / Invariants

### 1.1 Slot / Profile
- **Profile:** RS(`K`, `K+M`) with `N = K+M`
- **Slot:** integer `slot ∈ [0..N-1]`
- **Base slots:** the canonical `N` providers currently responsible for the deal’s stripe shards
- **Overlay slots:** additional providers per slot (elasticity or replacement candidates); not required for Sprint 3/4, but state is reserved here

### 1.2 Generations
- **Generation:** a monotonically increasing counter `current_gen`
- Every on-chain content commit that changes `Deal.manifest_root` MUST increment `current_gen`.
- Reads are always defined against the **current generation**.

### 1.3 Slab accounting fields (naming freeze)
For chain policy and bounds checks we freeze:
- `size_bytes`: total logical bytes of file contents in PolyFS (sum of non-tombstone file lengths)
- `total_mdus`: total number of committed MDU roots in the Manifest commitment (includes metadata + witness + user MDUs)
- `witness_mdus`: number of witness MDUs committed after MDU #0 (metadata region size)
- `user_mdus = total_mdus - 1 - witness_mdus` (derived; must be non-negative)

Notes:
- This RFC intentionally avoids `allocated_length` in protocol state. Gateway/UI MAY keep `allocated_length` as a legacy alias for `total_mdus` (count), per `polystore_gateway/polystore-gateway-spec.md`.

---

## 2. Proposed On-Chain Schema (Protobuf Freeze)

### 2.1 New messages

```proto
// StripeReplica profile parameters for Mode 2.
message StripeReplicaProfile {
  uint32 k = 1; // data slots
  uint32 m = 2; // parity slots
}

enum SlotStatus {
  SLOT_STATUS_UNSPECIFIED = 0;
  SLOT_STATUS_ACTIVE = 1;
  SLOT_STATUS_REPAIRING = 2; // slot is being replaced/catching up; excluded from quota + rewards
}

// Slot state for Mode 2 (base slot + optional replacement candidate).
message DealSlot {
  uint32 slot = 1; // 0..N-1
  string provider = 2; // current accountable provider (bech32)
  SlotStatus status = 3;

  // Make-before-break: replacement candidate for this slot (optional).
  // While set, the old provider remains accountable; the candidate proves readiness, then is promoted.
  string pending_provider = 4; // bech32 or empty

  int64 status_since_height = 5;
  uint64 repair_target_gen = 6; // == Deal.current_gen when repair starts
}
```

### 2.2 Deal additions (non-breaking)

We keep existing fields for devnet compatibility (notably `providers[]` and `service_hint`), but freeze the new canonical fields:

```proto
message Deal {
  // existing fields...

  // --- Mode 2 explicit encoding (new canonical state) ---
  StripeReplicaProfile mode2_profile = 15; // set iff redundancy_mode == 2
  repeated DealSlot mode2_slots = 16;      // length N, slot-ordered

  // --- Generation / write coordination ---
  uint64 current_gen = 17; // increments on every manifest_root change

  // --- Slab accounting (bounds + policy) ---
  uint64 total_mdus = 14;     // already exists; MUST be set on first content commit
  uint64 witness_mdus = 18;   // NEW; set on first content commit
}
```

**Canonical source of truth:**
- If `redundancy_mode != 2`, `mode2_profile` and `mode2_slots` MUST be unset/empty.
- If `redundancy_mode == 2`, `mode2_profile.k+m == len(mode2_slots)` MUST hold and `mode2_slots[i].slot == i`.

**Legacy fields during migration window:**
- `providers[]` remains populated for LCD/UI convenience and backwards compatibility.
- For Mode 2, `providers[]` MUST equal `[slot.provider for slot in mode2_slots]` until `providers[]` can be deprecated.
- `service_hint` may still include `rs=K+M`, but once `mode2_profile` exists, it is treated as **intent only**, not canonical state.

---

## 3. Lifecycle State Machine (Freeze)

### 3.1 CreateDeal (Mode 2)
At `MsgCreateDeal*` time:
- `mode2_profile` and `mode2_slots` are derived from the request (legacy: parsed from `service_hint`)
- `current_gen = 0`
- `manifest_root = empty`, `size_bytes = 0`, `total_mdus = 0`, `witness_mdus = 0`

### 3.2 UpdateDealContent (commit new manifest)
At `MsgUpdateDealContent*` time:
- Validate `manifest_root` format (already implemented)
- Require `size_bytes > 0`
- Require `total_mdus > 0` and `witness_mdus >= 0` (new fields in message; see §4)
- Set:
  - `Deal.manifest_root = new`
  - `Deal.size_bytes = new`
  - `Deal.total_mdus = new_total_mdus`
  - `Deal.witness_mdus = new_witness_mdus`
  - `Deal.current_gen += 1`

### 3.3 Repair / replacement (make-before-break)

**Start repair:** mark a slot as repairing and set a candidate.
- `slot.status = REPAIRING`
- `slot.pending_provider = candidate`
- `slot.repair_target_gen = Deal.current_gen`

**Candidate catch-up:** performed off-chain (gateway/SP tooling) by reconstructing and storing the required shards up to `repair_target_gen` (or `current_gen` if it advanced).

**Complete repair:** promote candidate and return slot to active.
- `slot.provider = slot.pending_provider`
- `slot.pending_provider = ""`
- `slot.status = ACTIVE`
- `slot.repair_target_gen = 0`

**Policy note:** While a slot is `REPAIRING`:
- clients SHOULD route around that slot for Mode 2 reads (fetch any `K` ACTIVE slots per MDU)
- synthetic challenges and quota accounting MUST ignore repairing slots
- repairing slots MUST NOT earn rewards for liveness proofs (they may still submit a “readiness proof” message; not defined here)

---

## 4. Required Message / Interface Changes (Freeze for Sprint 3+)

### 4.1 UpdateDealContent must carry slab accounting

To make `Deal.total_mdus` and `Deal.witness_mdus` enforceable, the update intent must include them:

```proto
message MsgUpdateDealContent {
  // existing fields...
  uint64 size = 4;         // logical bytes
  uint64 total_mdus = 5;   // NEW: manifest root count
  uint64 witness_mdus = 6; // NEW: metadata witness count
}

message EvmUpdateContentIntent {
  // existing fields...
  uint64 size_bytes = 4;
  uint64 total_mdus = 7;   // NEW
  uint64 witness_mdus = 8; // NEW
}
```

**Gateway/UI contract:** the upload/ingest pipeline already knows these values by inspecting `mdu_0.bin` / slab layout. The gateway response SHOULD include `total_mdus` and `witness_mdus` explicitly; `allocated_length` MAY remain as a legacy alias for `total_mdus`.

---

## 5. Upgrade / Migration Strategy (Devnet → Typed State)

### 5.1 Store migration
Add a one-time migration that:
- For each Deal with `redundancy_mode == 2`:
  - parse `(K,M)` from `service_hint` (legacy)
  - set `mode2_profile`
  - set `mode2_slots` from existing `providers[]` (slot order = list order)
  - initialize `slot.status = ACTIVE`, `pending_provider = ""`, `current_gen = 0` if unset
- Ensure `providers[]` and `mode2_slots[].provider` remain identical.

### 5.2 Post-migration behavior
- New deals write both legacy (`service_hint`, `providers[]`) and canonical (`mode2_*`) fields.
- Chain logic MUST prefer canonical typed fields when present.

---

## 6. Test Gates (for later sprints)

- **Migration test:** legacy Mode 2 deals survive upgrade with identical slot ordering and `(K,M)` values.
- **Invariants tests:** reject inconsistent `(K,M)` vs slot length; reject invalid slot indices.
- **Repair e2e:** multi-SP: mark slot repairing → candidate catch-up → promote → reads stay available (fetch any `K`).

---

## 7. Implementation Checklist (Sprint 3/4)

1. Protobuf + codegen:
   - `polystorechain/proto/polystorechain/polystorechain/v1/types.proto`: add `StripeReplicaProfile`, `DealSlot`, `SlotStatus`, `Deal.current_gen`, `Deal.witness_mdus`, `Deal.mode2_*`.
   - `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto`: extend `MsgUpdateDealContent` + `EvmUpdateContentIntent`.
2. Keeper logic:
   - Populate typed fields at `CreateDeal`.
   - Persist `total_mdus/witness_mdus/current_gen` at `UpdateDealContent*`.
3. Read path constraints:
   - Update `stripeParamsForDeal()` and `providerSlotIndex()` to use typed fields when present.
4. Gateway/UI:
   - Ensure `/gateway/upload` returns `total_mdus` and `witness_mdus` (keep legacy alias fields for transition).
5. Store migration:
   - Add an upgrade handler to backfill typed Mode 2 state for existing deals.


```

```rfc-retrieval-validation.md
# RFC: Retrieval Validation & The Deputy System

**Status:** Draft / Normative Candidate
**Scope:** Retrieval Markets, Proof of Delivery, Dispute Resolution
**Key Concepts:** Proxy Relay, Audit Debt, Ephemeral Identity

---

## 1. The Core Problem: "He Said, She Said"

In a trustless retrieval market, we must distinguish between:
1.  **Service Failure:** The SP is offline or malicious.
2.  **Griefing:** The User claims the SP is offline, but the SP is actually fine.

We solve this not by "Judging" the dispute, but by **Routing Around It**.

---

## 2. The Solution: The Deputy (Proxy) System

Instead of a complex "Court System," we implement a **"CDN of Last Resort."**

### 2.1 The "Proxy" Workflow (UX-First)
When a Data User (DU) fails to retrieve a file from their assigned Storage Provider (SP):

1.  **Escalation:** The DU broadcasts a P2P request: *"I need Chunk X from SP Y. I will pay MarketRate + Premium."*
2.  **The Deputy:** A random third-party Node (The Deputy) accepts the job.
3.  **The Relay:**
    *   The Deputy connects to the SP using a fresh, **Ephemeral Keypair** (acting as a new customer).
    *   The Deputy retrieves the chunk and pays the SP.
    *   The Deputy forwards the chunk to the DU and collects the `MarketRate + Premium`.
4.  **Outcome:**
    *   **Success:** The DU gets their file. The SP gets paid (unknowingly serving a proxy). The Deputy earns a fee.
    *   **Failure:** If the SP refuses/fails to serve the Deputy, the Deputy signs a `ProofOfFailure`.

### 2.2 Why This Works (Indistinguishability)
We do **not** need complex privacy mixers or ZK-Vouchers.
*   **Rationality Assumption:** A Rational SP wants to earn money.
*   **The Trap:** When the Deputy connects with an ephemeral key, the SP sees a **New Paying Customer**.
    *   If SP serves: They avoid slashing, but the DU gets the data (Goal achieved).
    *   If SP refuses: They lose revenue AND generate a `ProofOfFailure` (Slashing Risk).

---

## 3. "Audit Debt": The Engine of Honesty

How do we ensure there are enough Deputies? We **Conscript** them.

### 3.1 The Rule
**"To earn Storage Rewards, you must prove you are checking your neighbors."**

### 3.2 The Mechanism
1.  **Assignment:** The Protocol deterministically assigns `AuditTargets` to every SP based on the Random Beacon (DRB).
2.  **The Job:** The SP must act as a Deputy/Mystery Shopper for these targets.
3.  **The Reward Gate:**
    *   `ClaimableReward = min(BaseInflationReward, AuditWorkDone * Multiplier)`
    *   If an SP stores 1PB of data but performs 0 audits, their **Effective Reward** is 0.
4.  **Proof of Audit:** The SP submits the `RetrievalReceipt` they obtained from the Target SP.
    *   *Side Effect:* This generates a constant hum of "Organic Traffic" that proves the network is live, even when real users are asleep.

---

## 4. The Sad Path: Verified Failure

If a Deputy attempts to retrieve a chunk (for a User or for Audit Debt) and fails:

1.  **Evidence:** Deputy creates a `ProofOfFailure` (signed attestation + transcript hash).
2.  **Accumulation:** The Chain tracks `FailureCount(SP)`.
3.  **Slashing:**
    *   If `FailureCount > Threshold` within `Window`, the SP is jailed/slashed.
    *   *Safety:* A single malicious Deputy cannot slash an SP. It requires a consensus of failures from distinct, randomly selected Deputies.

---

## 5. Implementation Strategy (MVP)

**Phase 1: The Proxy (Client-Side Only)**
*   Implement the P2P `AskForProxy` message.
*   No consensus changes. Just networking logic.

**Phase 2: Audit Debt (Consensus)**
*   Add `AuditDebt` tracking to the `StorageProvider` struct.
*   Update `BeginBlocker` to check Audit compliance before minting rewards.

**Phase 3: Slashing**
*   Implement `MsgSubmitFailureEvidence`.

---

## 6. Summary

This RFC moves the protocol from a "Legal System" (Disputes) to a "Logistics System" (Relays).
*   **User Problem:** "I can't get my file." -> **Solution:** "A Deputy gets it for you."
*   **Network Problem:** "Are nodes online?" -> **Solution:** "Nodes must audit each other to get paid."
```

```rfc-retrieval-security.md
# RFC: Retrieval Security & Economic Griefing Analysis

**Status:** Informational / Security Analysis
**Scope:** Retrieval Market, Game Theory
**Related:** `whitepaper.md`, `rfcs/rfc-blob-alignment-and-striping.md`

This document analyzes the security model of the NilStore Retrieval Market, specifically focusing on the "Fair Exchange" problem between Storage Providers (SPs) and Data Users.

---

## 1. The Happy Path (Unified Liveness)

In the standard flow, the **Retrieval Receipt** serves as the atomic settlement unit.

1.  **Request:** User requests data (MDU/Shard) from SP.
2.  **Delivery:** SP delivers Data + Triple Proof.
3.  **Verification:** User verifies `Proof` against on-chain `ManifestRoot`.
4.  **Settlement:** User signs `RetrievalReceipt`. SP submits to Chain.
5.  **Outcome:** SP gets paid/rewarded; User Escrow is debited.

---

## 2. Attack Vectors: The Malicious Provider

### A. The "Garbage Data" Attack
*   **Action:** SP sends random noise to save on disk reads.
*   **Defense:** **Triple Proof (Hybrid Merkle-KZG).**
    *   The User verifies the data against the `ManifestRoot`.
    *   Forgery is cryptographically impossible.
*   **Outcome:** User detects invalid data immediately and **DOES NOT** sign. SP wastes bandwidth for zero reward. **(Risk: None)**

### B. The "Ransom" Attack
*   **Action:** SP withholds data, demanding off-chain extortion.
*   **Defense:** **Erasure Coding (RS 12,8).**
    *   No single SP has a monopoly on the data.
    *   User simply downloads from the 11 other shards and reconstructs.
*   **Outcome:** SP loses business. System heals via parity. **(Risk: Low)**

---

## 3. Attack Vectors: The Malicious User (Economic Griefing)

The primary economic vulnerability in optimistic retrieval markets is the "Free Rider" problem.

### The "Free Rider" Attack (Dine and Dash)
*   **Mechanism:**
    1.  User requests 1 GB of data.
    2.  SP delivers 1 GB. (Bandwidth Cost Incurred).
    3.  User verifies data but **Refuses to Sign** the receipt.
*   **Impact:**
    *   **User:** Gets data for free (Escrow is never triggered).
    *   **SP:** Loses bandwidth costs. Earns no Liveness Reward.
*   **Vulnerability Root:** The **Atomic Gap** between delivery (Step 2) and settlement (Step 4).

### Mitigation: Incremental Signing (Tit-for-Tat)
To neutralize this risk, client SDKs and SPs MUST implement **Incremental Signing** (Chunked Delivery).

*   **Protocol:**
    1.  User requests 1 GB.
    2.  SP sends **Chunk 1** (e.g., 100 MB).
    3.  SP **Pauses**.
    4.  User must sign/send receipt for Chunk 1.
    5.  SP verifies signature -> Sends **Chunk 2**.
*   **Result:**
    *   The "At-Risk" capital is reduced from 100% of the file to `< 10%` (or smaller, depending on chunk size).
    *   A malicious user can only steal one small chunk before being cut off.

---

## 4. Conclusion

| Scenario | Defense Mechanism | Residual Risk |
| :--- | :--- | :--- |
| **Lying SP** | Cryptographic Verification (Triple Proof) | **Zero** |
| **Withholding SP** | Redundancy (Reed-Solomon) | **Low** |
| **Free Rider User** | **Incremental Signing** (Tit-for-Tat) | **Low** |
| **Wash Trading** | System-Defined Placement (Randomness) | **Low** |

The system relies on **Cryptography** for Integrity and **Incremental Settlement** for Fair Exchange.

---

## 5. The Escape Hatch: Voluntary Rotation

While the system uses **System-Defined Placement** to prevent Sybil attacks, we acknowledge that legitimate users may need to fire a specifically abusive Provider (e.g., one engaging in "Selective Service" or extortion).

### 5.1 The Mechanism: `MsgRequestRotation`
*   **Action:** The Deal Owner submits a transaction requesting the removal of `SP_Bad` from `Deal_ID`.
*   **Protocol Response:**
    1.  The Protocol removes `SP_Bad`.
    2.  The Protocol recruits a replacement `SP_New` using the standard **Random Placement Algorithm** (User cannot choose).
    3.  `SP_New` replicates the missing shard from neighbors.

### 5.2 The Risk: Sybil Grinding
A malicious user might repeatedly fire `SP_Random` until the protocol assigns `SP_Friend` (a node they control), eventually capturing the entire deal.

### 5.3 The Defense: Cost & Cooldowns
To prevent grinding, the protocol enforces strict friction:

1.  **Replication Cost:** The User must pay the full bandwidth cost to replicate the shard to the new provider.
2.  **Cooldown (Rate Limit):** A specific Deal Slot (e.g., Shard #5) can only be voluntarily rotated once per **Cooldown Period** (e.g., 7 days).
    *   *Effect:* Even if an attacker is willing to pay infinite fees, the time required to grind a specific set of providers becomes measured in years, neutralizing the attack.

```

```rfc-heat-and-dynamic-placement.md
# RFC: Heat & Dynamic Placement for Mode 1

**Status:** Draft / Non‑normative
**Target:** NilStore Mode 1 (FullReplica)
**Scope:** Research / experimental design, _not_ part of the core retrievability spec yet

---

## 1. Summary

This RFC proposes a small, additive “heat layer” on top of the existing Mode 1 retrievability and self‑healing design.

The aim is to:

- Measure **per‑deal demand** (`heat H(D)`) from already‑available on‑chain signals (bytes served, failures),
- Expose that as a simple, cheap per‑deal state (`DealHeatState`),
- Eventually (optionally) allow small, bounded **tilts in storage rewards per deal** to make hot deals slightly more lucrative for Storage Providers (SPs),
- Bias SP audit‑debt sampling toward hot deals.

The core Mode 1 invariants and mechanics are **not changed**:

- Synthetic KZG challenges and retrieval receipts remain the source of storage proofs.
- Fraud proofs and explicit challenges remain the only basis for slashing.
- HealthState and eviction remain the primary self‑healing mechanism.
- Bandwidth pricing and escrow accounting remain as currently specified.

This document is explicitly **non‑normative**. It is a research and implementation guide for experiments on devnet/testnet. No behavior described here should be treated as part of the mainline spec until we explicitly promote a subset.

---

## 2. Background & Constraints

The existing Mode 1 spec (and `retrievability-memo.md`) already defines:

- **Retrievability / accountability:** For each `(Deal, Provider)`, either the data is retrievable under protocol rules, or there is verifiable evidence of failure leading to punishment.
- **Self‑healing placement:** Persistently bad SPs are evicted and replaced.
- **Mechanics:**
  - Deals with on‑chain commitments (root CID, MDU/KZG roots),
  - Retrieval protocol with deterministic KZG checkpoints via `DeriveCheckPoint`,
  - Synthetic storage challenges `S_e(D,P)`,
  - `RetrievalReceipt`–based proofs,
  - Fraud proofs and panic‑mode challenges,
  - SP audit debt, HealthState per `(Deal, Provider)`.

This RFC must satisfy:

- **No change** to the correctness layer:
  - What counts as a valid retrieval challenge,
  - What counts as valid evidence,
  - How slashing and eviction work.
- **No change** to bandwidth semantics for the first iteration:
  - `PricePerByte(D)` and escrow debits remain fixed as in Mode 1.
- **Minimal on‑chain complexity:**
  - No per‑MDU state in consensus,
  - Per‑deal metrics only,
  - Simple arithmetic and bounded state updates.

---

## 3. Design Overview

### 3.1 Data Unit and Heat

- For this RFC, a **Data Unit (DU)** is a single **Deal**:

  ```text
  DU(D) := DealId D
  ```

- For each deal `D` we maintain a small `DealHeatState` with:
  - A smoothed notion of **utilization**: “file‑equivalents served per epoch,”
  - Optional **failure rate** (synthetic challenge failures),
  - A scalar **heat score** `H(D)`,
  - Optional **storage multiplier** `m_storage(D)` (bounded tilt around 1.0),
  - Advisory **target replication** `r_target(D)`.

Heat is **derived** from already‑existing events:

- Bytes served per deal (observed at bandwidth settlement),
- Synthetic challenge failures and fraud proofs (already recorded for slashing).

### 3.2 Strict non‑goals for this RFC

The following are explicitly out of scope for the initial heat design:

- Per‑MDU heat, stripe‑level overlays, or CDN‑style per‑segment placement.
- Any change to:
  - Retrieval semantics,
  - Evidence formats,
  - Synthetic challenge schedules,
  - Bandwidth pricing (no `m_bw(D) ≠ 1`).
- Diversity constraints / anti‑concentration enforced in consensus.
- Using heat as a **direct** slashing or eviction signal.

All of those remain separate research tracks and must be evaluated independently.

---

## 4. DealHeatState and Metrics (Measurement Layer)

### 4.1 On‑chain state (measurement only)

For each deal `D`, we introduce a non‑normative state struct:

```text
struct DealHeatState {
    // Smoothed metrics
    ewma_util;      // fixed-point EWMA of utilization U(D)
    ewma_fail;      // fixed-point EWMA of failure rate F(D) (optional)

    // Derived heat score
    H;              // fixed-point heat in [0, H_max]

    // Optional economic hints (may remain =1 in early phases)
    m_storage;      // storage reward tilt multiplier, ≈1.0
    m_bw;           // bandwidth multiplier, kept at 1.0 in v1

    // Redundancy advisory (not enforced in consensus)
    r_min;          // copy of deal's minimum redundancy
    r_max;          // protocol-bound maximum redundancy
    r_target;       // advisory target redundancy from H(D)

    // Per-epoch accumulators
    bytes_served_epoch;
    failed_challenges_epoch;
    epoch_last_updated;
}
```

Notes:

- `DealHeatState` is **additive**: no existing state or logic needs to change to add it.
- For a v1 experiment we can:
  - Set `ewma_fail = 0`, `m_bw = 1`,
  - Use `m_storage = 1` initially (no economic effect).

### 4.2 Metric collection

Per epoch `e`, for each `deal_id = D`:

- **Bytes served**
  - When any Provider settles a payment channel for D (`claimPayment` succeeds):
    - Compute `delta_bytes` from cumulative counters,
    - Increment `DealHeat[D].bytes_served_epoch += delta_bytes`.
- **Failures** (optional in v1)
  - When a synthetic storage challenge for `(D,P)` is not satisfied in time,
    or when a fraud proof for `(D,P)` is accepted:
    - Increment `DealHeat[D].failed_challenges_epoch += 1`.

No new evidence is introduced; we just count events that already exist.

### 4.3 Heat computation (simple, linear v1)

At the end of epoch `e`, for each deal with non‑zero activity
(`bytes_served_epoch > 0` or `failed_challenges_epoch > 0`):

1. Utilization:

   ```text
   u_e(D)   = bytes_served_epoch / file_size(D)
   U_e(D)   = (1 - α_U) * U_{e-1}(D) + α_U * u_e(D)
   ewma_util = U_e(D)
   ```

2. Failures (optional; can set α_F = 0 in early tests):

   ```text
   f_e(D)   = min(1.0, failed_challenges_epoch / k_storage_base)
   F_e(D)   = (1 - α_F) * F_{e-1}(D) + α_F * f_e(D)
   ewma_fail = F_e(D)
   ```

3. Heat (v1: saturating linear, no log to keep math cheap):

   ```text
   H_raw(D)   = U_e(D) * (1 + β_F * F_e(D))
   H_capped   = min(H_raw(D), H_max)
   H_new      = clamp(H_capped,
                      H_prev * (1 - δ_H),
                      H_prev * (1 + δ_H))
   H          = H_new
   ```

4. Reset per‑epoch counters and set `epoch_last_updated = e`.

Recommended starting parameters (for experiments, not yet normative):

- `α_U ≈ 0.1` (heat reacts over ~10 epochs),
- `α_F = 0` (ignore failures in H(D) initially),
- `β_F = 0` (no failure amplification until we’re comfortable),
- `H_max` small (e.g. 10),
- `δ_H ≈ 0.2` to limit per‑epoch swings.

---

## 5. Optional Economic Hooks (Tilted Storage Rewards)

This section describes a **candidate** way to use `H(D)` to slightly tilt storage rewards. It is deliberately conservative and should be considered **Phase C** in a longer rollout.

### 5.1 Storage multiplier m_storage(D)

Define a squashing function:

```text
g(D) = H(D) / (H(D) + H0)      // H0 > 0
```

Then the raw storage multiplier:

```text
m_raw(D) = 1 + s_max * g(D)
```

To avoid jitter:

```text
m_new(D) = clamp(m_raw(D),
                 m_prev(D) * (1 - δ_m),
                 m_prev(D) * (1 + δ_m))

m_new(D) = clamp(m_new(D), m_min_global, m_max_global)
```

And we store:

```text
DealHeat[D].m_storage = m_new(D)
```

Suggested bounds for experiments:

- `s_max` ≈ 0.25–0.5 (max +25–50% uplift),
- `δ_m` ≈ 0.1 (max ±10% change per epoch),
- `m_min_global` ≈ 0.75, `m_max_global` ≈ 1.25.

### 5.2 Plugging into existing storage rewards

Let:

- `R_base(D,P,e,T)` = storage reward for `(D,P)` in epoch `e` with tier `T` **under current Mode 1 logic**, before any heat tilt.

Candidate new reward:

```text
R_new(P,e) = Σ_D ( R_base(D,P,e,T(D,P,e)) * m_storage(D,e) )
```

Notes:

- We do **not** change:
  - global inflation schedule,
  - latency tier multipliers,
  - proof mechanics.
- We accept that total minted storage reward may deviate slightly from the current target, bounded by `m_min_global`/`m_max_global`.
- A future refinement could add a global re‑normalization factor to keep total inflation exactly constant, but that is **out of scope** for this RFC.

### 5.3 Bandwidth pricing (deliberately unchanged)

For this RFC:

- Bandwidth price per byte remains `PricePerByte(D)` from the deal.
- Escrow debits when settling retrieval receipts remain:

  ```text
  escrow_debit = delta_bytes * PricePerByte(D)
  ```

- `m_bw(D)` is kept equal to 1 and is not applied to real payments in v1.

Dynamic bandwidth pricing is a separate research track.

---

## 6. Advisory Target Replication & Audit Bias (Optional)

### 6.1 Advisory target replication r_target(D)

We can derive an **advisory** target replication:

```text
g_r(D)       = H(D) / (H(D) + H0_r)
r_target(D)  = r_min(D) + floor((r_max(D) - r_min(D)) * g_r(D))
```

Where:

- `r_min(D)` is the deal’s minimum redundancy (already in spec),
- `r_max(D)` is a protocol‑bounded maximum (e.g. `r_min + ΔR_LOCAL_MAX`).

In this RFC:

- `r_target(D)` is **informational**:
  - Dashboards,
  - Off‑chain placement heuristics,
  - SP operator tooling.
- Consensus logic **does not**:
  - block exits based on r_target (only on r_min),
  - auto‑adjust rewards beyond `m_storage(D)`.

### 6.2 Audit sampling bias

SP audit debt today:

- For each SP P:
  - `audit_debt(P) = α_base * stored_bytes(P)` per epoch (fixed).

We can change **only** how we select deals/assignments to satisfy that debt:

- Sample deals D for audits with probability proportional to:

  ```text
  weight(D) ∝ max(ε_H, H(D)) * file_size(D)
  ```

Where:

- `ε_H` is a small baseline so cold deals still get some attention.

This bias:

- Does not change total audit volume,
- Keeps audit mechanics unchanged,
- Focuses more cross‑SP audits on hot deals where impact of cheating is highest.

---

## 7. Phased Adoption Plan (Non‑binding)

This RFC recommends a three‑phase path, all explicitly opt‑in and reversible.

### Phase A – Measurement only (devnet/testnet)

Implement:

- `DealHeatState` with:
  - `ewma_util`, `ewma_fail`, `H`,
  - per‑epoch accumulators.
- Metric collection and H(D) update at epoch boundaries.
- Queries that expose:
  - `H(D)`, `U(D)`, maybe `r_target(D)` (computed but advisory).

No economic behavior changes:

- `m_storage = 1`, `m_bw = 1`,
- existing reward and bandwidth logic untouched.

### Phase B – Soft influence (testnet)

Add:

- Advisory `r_target(D)` computation (if not already computed).
- Audit sampling bias:
  - SP audit‑debt scheduler chooses deals with probability proportional to `max(ε_H, H(D)) * file_size(D)`.
- Off‑chain use:
  - Dashboards visualize heat,
  - SPs optionally incorporate H(D) into local decision heuristics.

Still no direct economic changes:

- `m_storage = 1`, `m_bw = 1`.

### Phase C – Economic tilting (candidate mainnet feature)

Only after Phase A/B have run long enough to validate:

- Stability of H(D),
- No obvious gaming or pathologies,

we consider turning on:

- `m_storage(D)` as defined in § 5.1, with conservative bounds.
- Storage rewards multiplied per deal:

  ```text
  R_new(P,e) = Σ_D R_base(D,P,e,T) * m_storage(D,e)
  ```

Bandwidth and retrievability logic remain unchanged.

If any issues arise:

- We can set `s_max = 0` or `m_storage = 1` network‑wide, effectively disabling the tilt while keeping metric collection for analysis.

---

## 8. Risks & Open Questions

This RFC is **not** a final decision to ship dynamic heat; it’s a framework for experiments. Key questions to answer before promoting any part of it to the main spec:

1. **Economic calibration**
   - Do small tilts (±20–25%) meaningfully improve SP incentives or deal distribution?
   - How sensitive are results to `α_U`, `H0`, `s_max`, and bounds on `m_storage`?
2. **Gaming**
   - In practice, can SPs or clients cheaply farm H(D) enough to materially distort rewards?
   - Does the protocol tax on bandwidth + bounds on `m_storage` make self‑dealing clearly negative‑EV?
3. **State and performance**
   - For realistic numbers of deals (10k–100k+), what is the impact on:
     - state size,
     - per‑epoch update time,
     - block gas?
4. **UX and predictability**
   - Are small, slow storage tilts acceptable for users who think in terms of “static” storage pricing?
   - Does this complicate mental models or pricing too much for early mainnet?
5. **Value vs complexity**
   - Does a measurement‑only heat layer (Phase A/B) already provide enough insight and audit targeting benefits?
   - Is turning on `m_storage` worth the added complexity, or should it remain a lab feature until after mainnet?

Until these are answered via simulation and real testnet data, this RFC should be treated as an **experimental design**, not a commit to change the live protocol.


```

