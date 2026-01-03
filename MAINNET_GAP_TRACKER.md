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
- **Current state:** `nil_p2p` has an `AskForProxy` message stub, but no end-to-end deputy selection, relay, compensation, or evidence.
- **DoD:** proxy retrieval works when an SP “ghosts”; failure evidence is produced and aggregated; audit debt tasks are assignable/trackable; griefing mitigations.
- **Test gate:** e2e “ghosting provider” scenario that still retrieves via deputy and records evidence.

### P0-PERF-001 — High-throughput KZG (GPU) + parallel ingest pipeline
- **Status:** PARTIAL (DEVNET)
- **Spec/Notes:** `notes/kzg_upload_bottleneck_report.md`, `notes/kzg_gpu_design.md`, `notes/roadmap_milestones_strategic.md` (Milestone 2)
- **Current state:** CPU KZG works and the gateway ingest pipeline is parallelized by default; GPU-class acceleration is still missing for mainnet target throughput.
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

### Chain / Protocol (`nilchain/`)

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

### Sprint 1 — “One core” foundation (NilFS + commitments unified)
- **Targets:** **P0-CORE-001**, **CORE-402** (partial), plus the “Divergences” naming decision groundwork.
- **Goal:** eliminate browser/gateway drift risk by centralizing NilFS layout + commitment computation in `nil_core`.
- **Delivers:**
  - Port NilFS layout/builder primitives from `nil_gateway/pkg/*` into `nil_core` (Rust) with a stable API surface.
  - WASM bindings used by `nil-website` AND CGO/FFI bindings used by `nil_gateway` point to the same implementation.
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
