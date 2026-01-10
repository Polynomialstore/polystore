```AGENTS.md (excerpt: git protocol)
# NilStore Network Development Roadmap

## Protocol for Agents
**CRITICAL:** When pushing changes to the repository, you **MUST** push to both remotes to ensure synchronization.
*   `git push origin main` (Primary)
*   `git push nil-store main` (Mirror)

### Git Best Practices for Agents
*   **Commit Regularly:** Always commit your work frequently, in small, logical chunks.
*   **Prohibited Commands:** Agents are strictly forbidden from running aggressive Git commands like `git clean` or `git reset --hard` as these can lead to irreversible data loss of uncommitted work. If such commands are necessary, confirm with the user first.
*   **Tests Before Push:** For every non-trivial change, run the most relevant unit/e2e tests before committing. Do not push code that you haven't at least smoke-tested locally.
*   **Commit & Push Cadence:** Treat this file as the canonical TODO list. As you complete tasks, update the checklist, commit your work with a descriptive message, and push to both remotes (`origin` and `nil-store`) in small, verified increments.
*   **Default Autonomy:** Unless the user explicitly says “don’t commit/push yet,” agents should **automatically** commit completed work (after relevant tests pass) and push to both remotes. Keep commits small and descriptive, and avoid batching unrelated changes.

This document outlines a strategic "Go-to-Market" Engineering Roadmap for the NilStore Network, designed to iteratively validate, market, and refine the project from "Paperware" to "Software." It recognizes the need to align Technology, Community, and Economy.

## Phase 1: The "Localhost" Prototype (Months 1-3)
**Goal:** Prove the math works on a single machine. Don't worry about the network yet.

*   **Build (Tech):**

```

```MAINNET_ECON_PARITY_CHECKLIST.md
# Mainnet Parity + Devnet/Testnet Launch Checklist

Companion docs:
- `notes/mainnet_policy_resolution_jan2026.md` (concrete proposal for “B” + staged plan)
- `MAINNET_GAP_TRACKER.md` (canonical gap tracking + DoDs + test gates)

## Stage 0 — Policy freeze → params + interfaces (unblocks engineering)
- [ ] Extend `nilchain/proto/nilchain/nilchain/v1/params.proto` to encode B1/B2/B4/B5/B6 (with validation + genesis defaults).
- [ ] Encode audit budget sizing/caps (Option A): `audit_budget_bps`, `audit_budget_cap_bps`, and bounded carryover (≤2 epochs) for unused budget.
- [ ] Document chosen defaults + rationale in `notes/mainnet_policy_resolution_jan2026.md` and reference from `MAINNET_GAP_TRACKER.md`.

## Stage 1 — Storage lock-in pricing + escrow accounting (A1)
- [ ] Implement pay-at-ingest lock-in pricing on `UpdateDealContent*` per `rfcs/rfc-pricing-and-escrow-accounting.md` (`nilchain/`).
- [ ] Implement deterministic spend window reset + deterministic elasticity debits (`nilchain/`).
- [ ] Add econ e2e: create deal → upload/commit → verify escrow and module account flows (`scripts/`, `tests/`).

## Stage 2 — Retrieval session economics (A2)
- [ ] Enforce session open burns base fee + locks variable fee; rejects insufficient escrow (`nilchain/`).
- [ ] Enforce completion settlement: burn cut + provider payout; cancel/expiry refunds locked fee only (`nilchain/`).
- [ ] Extend econ e2e: open → complete; open → cancel/expire; verify burns/payouts/refunds (`scripts/`, `tests/`).

## Stage 3 — Deterministic challenge derivation + quotas + synthetic fill (A3)
- [ ] Implement deterministic challenge derivation + quota accounting (SPECIFIED in `rfcs/rfc-challenge-derivation-and-quotas.md`) (`nilchain/`).
- [ ] Implement enforcement outcomes: invalid proof → hard fault; quota shortfall → HealthState decay (no slash by default) (`nilchain/`).
- [ ] Add keeper unit tests for determinism + exclusions (REPAIRING slots excluded).
- [ ] Add adversarial sim test gate for anti-grind properties (`scripts/`, `performance/`).

## Stage 4 — HealthState + eviction curve (A6)
- [ ] Implement per-(deal, provider/slot) HealthState updates from hard/soft failures (`nilchain/`).
- [ ] Implement eviction triggers (`evict_after_missed_epochs_hot/cold`) and hook into Mode 2 repair start (`nilchain/`).
- [ ] Add queries/events for observability; add unit tests.

## Stage 5 — Mode 2 repair + make-before-break replacement (A5)
- [ ] Implement make-before-break replacement per `rfcs/rfc-mode2-onchain-state.md` (`nilchain/`).
- [ ] Implement deterministic candidate selection + churn controls (B4) (`nilchain/`).
- [ ] Ensure reads avoid `REPAIRING` slots; synthetic challenges ignore `REPAIRING`; repairing slots do not earn rewards (`nilchain/`, `nil_gateway/`).
- [ ] Add multi-SP repair e2e: slot failure → candidate catch-up → promotion; reads succeed throughout (`scripts/`, `tests/`).

## Stage 6 — Evidence / fraud proofs pipeline (A4)
- [ ] Implement evidence taxonomy + verification + replay protection (`nilchain/`).
- [ ] Wire penalties (slash/jail/evict) to B1 params; integrate with repair start (`nilchain/`).
- [ ] Add unit tests per evidence type + e2e demonstrating slash on proven bad data (`scripts/`, `tests/`).

## Stage 7 — Deputy market + proxy retrieval + audit debt (P0-P2P-001)
- [ ] Implement deputy/proxy retrieval end-to-end: selection, routing, and settlement (B5) (`nil_p2p/`, `nilchain/`, `nil_gateway/`).
- [ ] Implement proof-of-failure aggregation with threshold/window (B1) and anti-griefing (B5) (`nilchain/`).
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

```MAINNET_GAP_TRACKER.md
# Mainnet Gap Tracker (NilStore)

This document tracks **what is missing** between the current implementation in this repo and the **long‑term Mainnet plan** described by `spec.md` (canonical), `rfcs/`, and `notes/`.

**Sources (ordered):**
- `spec.md` (canonical protocol spec; v2.4 at time of writing)
- `rfcs/` (design proposals / deep dives; check header status)
- `notes/roadmap_milestones_strategic.md` (milestone sequencing)
- `notes/mainnet_policy_resolution_jan2026.md` (proposal: concrete defaults for remaining econ/repair/deputy policies)
- `AGENTS_MAINNET_PARITY.md` (codex-ready agents punch list derived from checklist + policy defaults)

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
- `sprint23-gap-tracker-status`: record sprint22 execution status in the tracker (doc hygiene).
- `sprint24-one-core-payload-ffi`: move NilFS payload encode/decode into `nil_core` FFI to reduce cross-runtime drift.

```

```notes/mainnet_policy_resolution_jan2026.md
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

The current on-chain params are defined in `nilchain/proto/nilchain/nilchain/v1/params.proto` and already include (non-exhaustive):
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

```rfcs/rfc-pricing-and-escrow-accounting.md
# RFC: Pricing & Escrow Accounting (Lock-in + Retrieval Fees + Elasticity Caps)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain economics (`nilchain/`) + gateway/UI intent fields
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
- `types.ModuleName` (`nilchain` module account): holds escrow and performs burns/transfers for retrieval settlement.

---

## 2. Parameters (Frozen)

From `nilchain/nilchain/v1/params.proto`:
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

```rfcs/rfc-challenge-derivation-and-quotas.md
# RFC: Challenge Derivation & Proof Quota Policy (Unified Liveness v1)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain protocol policy (`nilchain/`)
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

```rfcs/rfc-mode2-onchain-state.md
# RFC: Mode 2 On-Chain State (Slots, Generations, Repairs)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain protocol state (`nilchain/`)
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
- `size_bytes`: total logical bytes of file contents in NilFS (sum of non-tombstone file lengths)
- `total_mdus`: total number of committed MDU roots in the Manifest commitment (includes metadata + witness + user MDUs)
- `witness_mdus`: number of witness MDUs committed after MDU #0 (metadata region size)
- `user_mdus = total_mdus - 1 - witness_mdus` (derived; must be non-negative)

Notes:
- This RFC intentionally avoids `allocated_length` in protocol state. Gateway/UI MAY keep `allocated_length` as a legacy alias for `total_mdus` (count), per `nil_gateway/nil-gateway-spec.md`.

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
   - `nilchain/proto/nilchain/nilchain/v1/types.proto`: add `StripeReplicaProfile`, `DealSlot`, `SlotStatus`, `Deal.current_gen`, `Deal.witness_mdus`, `Deal.mode2_*`.
   - `nilchain/proto/nilchain/nilchain/v1/tx.proto`: extend `MsgUpdateDealContent` + `EvmUpdateContentIntent`.
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

```nilchain/proto/nilchain/nilchain/v1/params.proto
syntax = "proto3";
package nilchain.nilchain.v1;

import "amino/amino.proto";
import "gogoproto/gogo.proto";
import "cosmos/base/v1beta1/coin.proto";

option go_package = "nilchain/x/nilchain/types";

// Params defines the parameters for the module.
message Params {
  option (amino.name) = "nilchain/x/nilchain/Params";
  option (gogoproto.equal) = true;

  uint64 base_stripe_cost = 1; // NIL per epoch
  uint64 halving_interval = 2; // Blocks
  uint64 eip712_chain_id = 3; // Numeric EIP-712 domain chainId (default 31337 for localhost devnet)

  string storage_price = 4 [
    (gogoproto.customtype) = "cosmossdk.io/math.LegacyDec",
    (gogoproto.nullable) = false
  ]; // Price per byte per block in base denom (devnet: stake)

  cosmos.base.v1beta1.Coin deal_creation_fee = 5 [
    (gogoproto.nullable) = false
  ];

  uint64 min_duration_blocks = 6;

  cosmos.base.v1beta1.Coin base_retrieval_fee = 7 [
    (gogoproto.nullable) = false
  ]; // Fixed fee charged on retrieval session open (burned).

  cosmos.base.v1beta1.Coin retrieval_price_per_blob = 8 [
    (gogoproto.nullable) = false
  ]; // Variable retrieval price per 128KiB blob (locked on session open).

  uint64 retrieval_burn_bps = 9; // Burn cut in basis points (e.g., 500 = 5%).

  // Length of the elasticity spend window ("month") in blocks.
  // When the chain height exceeds spend_window_start_height + month_len_blocks,
  // the window resets and spend_window_spent returns to 0.
  uint64 month_len_blocks = 10;

  // --- Unified Liveness / Quotas (Mode 1 + Mode 2) ---
  // Length of a liveness epoch in blocks. Used for deterministic challenge derivation.
  uint64 epoch_len_blocks = 11;

  // Proof quota per epoch, in basis points of slot-responsible bytes.
  // See `rfcs/rfc-challenge-derivation-and-quotas.md`.
  uint64 quota_bps_per_epoch_hot = 12;
  uint64 quota_bps_per_epoch_cold = 13;

  // Minimum/maximum number of blobs required per epoch per assignment.
  uint64 quota_min_blobs = 14;
  uint64 quota_max_blobs = 15;

  // Cap on how much of the quota can be satisfied via organic retrieval credits.
  uint64 credit_cap_bps = 16;

  // Evict (trigger repair) after this many consecutive missed epochs.
  uint64 evict_after_missed_epochs = 17;
}

```

```scripts/run_devnet_alpha_multi_sp.sh (usage excerpt)
#!/usr/bin/env bash
# Devnet Alpha multi-provider stack runner.
# Starts:
# - nilchaind (CometBFT + LCD + JSON-RPC)
# - nil_faucet
# - N provider daemons (nil_gateway, provider mode) on ports 8091+
# - 1 gateway router (nil_gateway, router mode) on :8080
# - nil-website (optional, default on)
#
# Usage:
#   ./scripts/run_devnet_alpha_multi_sp.sh start
#   ./scripts/run_devnet_alpha_multi_sp.sh stop
#
# Hub-only mode (no local providers):
#   PROVIDER_COUNT=0 ./scripts/run_devnet_alpha_multi_sp.sh start
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/_artifacts/devnet_alpha_multi_sp"
PID_DIR="$LOG_DIR/pids"

CHAIN_HOME="${NIL_HOME:-$ROOT_DIR/_artifacts/nilchain_data_devnet_alpha}"
CHAIN_ID="${CHAIN_ID:-31337}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
GAS_PRICE="${NIL_GAS_PRICES:-0.001aatom}"
DENOM="${NIL_DENOM:-stake}"

NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"
NIL_CLI_BIN="$ROOT_DIR/nil_cli/target/release/nil_cli"
NIL_GATEWAY_BIN="$ROOT_DIR/nil_gateway/nil_gateway"
TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt"
GO_BIN="${GO_BIN:-$(command -v go)}"

PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
PROVIDER_PORT_BASE="${PROVIDER_PORT_BASE:-8091}"

START_WEB="${START_WEB:-1}"

# Shared secret between the gateway router and all providers.
NIL_GATEWAY_SP_AUTH="${NIL_GATEWAY_SP_AUTH:-}"

FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"

mkdir -p "$LOG_DIR" "$PID_DIR"

banner() { printf '\n=== %s ===\n' "$*"; }

ensure_nil_core() {
  local lib_dir="$ROOT_DIR/nil_core/target/release"

  nil_core_has_symbols() {
    local sym
    local file=""

    # Prefer dynamic libraries because `nm` on archive `.a` can return non-zero
    # (causing false negatives under `set -o pipefail`).
    if [ -f "$lib_dir/libnil_core.so" ]; then
      file="$lib_dir/libnil_core.so"

```

```scripts/run_devnet_alpha_multi_sp.sh (param override excerpt)
data["app_state"]["bank"] = bank

# Enable NilStore EVM precompile for MetaMask tx UX.
evm = data.get("app_state", {}).get("evm", {})
params = evm.get("params", {})
pre = params.get("active_static_precompiles", []) or []
addr = "0x0000000000000000000000000000000000000900"
if addr not in pre:
    pre.append(addr)
pre = sorted(set(pre))
params["active_static_precompiles"] = pre
evm["params"] = params
data["app_state"]["evm"] = evm

# Optional devnet overrides for nilchain params (useful for fast CI/E2E loops).
nilchain = data.get("app_state", {}).get("nilchain", {})
params = nilchain.get("params", {}) if isinstance(nilchain, dict) else {}
overrides = {
    "month_len_blocks": os.getenv("NIL_MONTH_LEN_BLOCKS"),
    "epoch_len_blocks": os.getenv("NIL_EPOCH_LEN_BLOCKS"),
    "quota_bps_per_epoch_hot": os.getenv("NIL_QUOTA_BPS_PER_EPOCH_HOT"),
    "quota_bps_per_epoch_cold": os.getenv("NIL_QUOTA_BPS_PER_EPOCH_COLD"),
    "quota_min_blobs": os.getenv("NIL_QUOTA_MIN_BLOBS"),
    "quota_max_blobs": os.getenv("NIL_QUOTA_MAX_BLOBS"),
    "credit_cap_bps": os.getenv("NIL_CREDIT_CAP_BPS"),
    "evict_after_missed_epochs": os.getenv("NIL_EVICT_AFTER_MISSED_EPOCHS"),
}
for key, raw in overrides.items():
    if raw is None:
        continue
    raw = raw.strip()
    if raw == "":
        continue
    try:
        val = int(raw, 10)
    except Exception:
        continue
    if val < 0:
        continue
    params[key] = str(val)
if isinstance(nilchain, dict):
    nilchain["params"] = params
    data["app_state"]["nilchain"] = nilchain

json.dump(data, open(path, "w"), indent=1)
PY
}

gen_provider_key() {
  local name="$1"
  "$NILCHAIND_BIN" keys add "$name" --home "$CHAIN_HOME" --keyring-backend test --output json >/dev/null 2>&1 || true
  "$NILCHAIND_BIN" keys show "$name" -a --home "$CHAIN_HOME" --keyring-backend test
}

init_chain() {
  rm -rf "$CHAIN_HOME"
  banner "Initializing chain at $CHAIN_HOME"
  "$NILCHAIND_BIN" init devnet-alpha --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

  printf '%s\n' "$FAUCET_MNEMONIC" | "$NILCHAIND_BIN" keys add faucet --home "$CHAIN_HOME" --keyring-backend test --recover --output json >/dev/null


```

```scripts/ci_e2e_gateway_retrieval_multi_sp.sh
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh"

cleanup() {
  echo "==> Stopping devnet alpha multi-SP stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

echo "==> Starting devnet alpha multi-SP stack (providers=12)..."
# We need enough providers to ensure cross-provider routing happens.
export PROVIDER_COUNT=12
"$STACK_SCRIPT" start

echo "==> Waiting for stack health..."
# Wait for router
timeout 60s bash -c "until curl -s http://localhost:8080/health >/dev/null; do sleep 1; done" || { echo "Router failed to start"; exit 1; }
# Wait for provider 12 (last one)
timeout 60s bash -c "until curl -s http://localhost:8102/health >/dev/null; do sleep 1; done" || { echo "Provider 12 failed to start"; exit 1; }

echo "==> Running Regression Test..."
"$ROOT_DIR/scripts/e2e_gateway_retrieval_multi_sp.sh"

```

```scripts/e2e_gateway_retrieval_multi_sp.sh
#!/bin/bash
set -euo pipefail

# E2E Regression Test: Multi-SP Retrieval Proofs
# Tests that a Gateway can submit a retrieval proof for a deal owned by a DIFFERENT
# account (e.g. Provider A owns deal, Provider B hosts data).
#
# Requires: run_devnet_alpha_multi_sp.sh stack to be running.

GATEWAY_ROUTER="http://localhost:8080"
NILCHAIND="nilchain/nilchaind"
CHAIN_HOME="_artifacts/nilchain_data_devnet_alpha"
TMP_DIR="_artifacts/e2e_multi_sp_tmp"
mkdir -p "$TMP_DIR"

banner() { printf '\n>>> %s\n' "$*"; }
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# 1. Setup
banner "Generating Test Data"
dd if=/dev/urandom of="$TMP_DIR/payload.bin" bs=1024 count=1024 2>/dev/null # 1MB

# 2. Identify Test Accounts (Provider1 = Owner)
banner "Resolving Accounts"
OWNER_ADDR=$($NILCHAIND keys show provider1 -a --home "$CHAIN_HOME" --keyring-backend test)
echo "Owner (Provider1): $OWNER_ADDR"

# 3. Create Deal
banner "Creating Deal"
CREATE_OUT=$($NILCHAIND tx nilchain create-deal 1000 1000000 1000000 --service-hint General --chain-id 31337 --from provider1 --yes --keyring-backend test --home "$CHAIN_HOME" --gas-prices 0.001aatom --output json)
TX_HASH=$(echo "$CREATE_OUT" | jq -r '.txhash')
echo "Create Deal Tx: $TX_HASH"

banner "Waiting for Deal on Chain..."
sleep 6
TX_QUERY=$($NILCHAIND query tx "$TX_HASH" --output json 2>/dev/null || echo "")
DEAL_ID=$(echo "$TX_QUERY" | jq -r '
  .events? // []
  | map(select(.type == "nilchain.nilchain.v1.EventCreateDeal" or .type == "create_deal"))
  | map(.attributes // [])
  | add
  | map(select(.key == "deal_id" or .key == "id"))
  | .[0].value // empty
')
if [ -z "$DEAL_ID" ]; then
  DEAL_LIST=$($NILCHAIND query nilchain list-deals --output json)
  DEAL_ID=$(echo "$DEAL_LIST" | jq -r '.deals[-1].id')
fi
echo "Deal ID: $DEAL_ID"
if [ -z "$DEAL_ID" ] || [ "$DEAL_ID" == "null" ]; then
    echo "Create deal failed: deal_id not found"
    exit 1
fi

# 4. Upload Content (via Router)
banner "Uploading Content"
UPLOAD_RESP=$(curl -s -X POST -F "file=@$TMP_DIR/payload.bin;filename=payload.bin" "$GATEWAY_ROUTER/gateway/upload?deal_id=$DEAL_ID")
CID=$(echo "$UPLOAD_RESP" | jq -r '.cid')
SIZE=$(echo "$UPLOAD_RESP" | jq -r '.size_bytes')
TOTAL_MDUS=$(echo "$UPLOAD_RESP" | jq -r '.total_mdus')
WITNESS_MDUS=$(echo "$UPLOAD_RESP" | jq -r '.witness_mdus')

if [ "$CID" == "null" ]; then
    echo "Upload failed: $UPLOAD_RESP"
    exit 1
fi
echo "CID: $CID"

# 5. Commit Content
banner "Committing Content"
COMMIT_OUT=$($NILCHAIND tx nilchain update-deal-content --deal-id "$DEAL_ID" --cid "$CID" --size "$SIZE" --total-mdus "$TOTAL_MDUS" --witness-mdus "$WITNESS_MDUS" --chain-id 31337 --from provider1 --yes --keyring-backend test --home "$CHAIN_HOME" --gas-prices 0.001aatom --output json)
echo "Commit Tx: $(echo "$COMMIT_OUT" | jq -r '.txhash')"
sleep 6

# 6. Resolve Assigned Provider
banner "Resolving Assigned Provider"
DEAL_INFO=$($NILCHAIND query nilchain get-deal --id "$DEAL_ID" --output json)
ASSIGNED_ADDR=$(echo "$DEAL_INFO" | jq -r '.deal.providers[0]')
echo "Assigned Provider: $ASSIGNED_ADDR"

if [ "$ASSIGNED_ADDR" == "$OWNER_ADDR" ]; then
    echo "WARNING: Assigned provider IS the owner. This test works best when they differ."
    echo "Continuing anyway, as signature mismatch could still occur if code is wrong."
else
    echo "Confirmed: Assigned provider != Owner. Testing cross-account signing."
fi

PROVIDER_INFO=$($NILCHAIND query nilchain get-provider --address "$ASSIGNED_ADDR" --output json)
ENDPOINT=$(echo "$PROVIDER_INFO" | jq -r '.provider.endpoints[0]')
# Extract port from /ip4/127.0.0.1/tcp/PORT/http
PORT=$(echo "$ENDPOINT" | awk -F/ '{print $5}')
echo "Provider Port: $PORT"

# 7. Prove Retrieval (The Regression Test)
banner "Proving Retrieval (via Provider :$PORT)"
# This call triggers 'submitRetrievalProofNew' on the provider.
# BEFORE FIX: It would sign with the Provider's key -> Fail "unauthorized" on chain.
# AFTER FIX: It should look up Owner's key in shared keyring -> Sign with Owner key -> Success.
PROVE_RESP=$(curl -s -X POST -H "Content-Type: application/json" -d '{
    "deal_id": '$DEAL_ID',
    "manifest_root": "'$CID'",
    "file_path": "payload.bin",
    "owner": "'$OWNER_ADDR'",
    "epoch_id": 1
}' "http://localhost:$PORT/gateway/prove-retrieval")

echo "Prove Response: $PROVE_RESP"

ERR=$(echo "$PROVE_RESP" | jq -r '.error // empty')
if [ -n "$ERR" ]; then
    echo "❌ TEST FAILED: $ERR"
    exit 1
fi

TX_HASH_PROOF=$(echo "$PROVE_RESP" | jq -r '.tx_hash')
if [ "$TX_HASH_PROOF" == "null" ]; then
    echo "❌ TEST FAILED: No tx_hash in response"
    exit 1
fi

echo "✅ TEST PASSED: Retrieval proof submitted successfully."

```

```scripts/run_local_stack.sh (usage excerpt)
#!/usr/bin/env bash
# Spin up a local NilChain stack: chain (CometBFT+EVM), faucet, and web UI.
# Usage:
#   ./scripts/run_local_stack.sh start   # default
#   ./scripts/run_local_stack.sh stop    # kill background processes started by this script
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/_artifacts/localnet"
PID_DIR="$LOG_DIR/pids"
CHAIN_HOME="${NIL_HOME:-$ROOT_DIR/_artifacts/nilchain_data}"
CHAIN_ID="${CHAIN_ID:-31337}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
EVM_RPC_PORT="${EVM_RPC_PORT:-8545}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26657}"
GAS_PRICE="${NIL_GAS_PRICES:-0.001aatom}"
DENOM="${NIL_DENOM:-stake}"
export NIL_AMOUNT="1000000000000000000aatom,100000000stake" # 1 aatom, 100 stake
FAUCET_MNEMONIC="${FAUCET_MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"
NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"
GO_BIN="${GO_BIN:-/Users/michaelseiler/.gvm/gos/go1.25.5/bin/go}"
GATEWAY_BIN="$LOG_DIR/nil_gateway"
BRIDGE_ADDR_FILE="$ROOT_DIR/_artifacts/bridge_address.txt"
BRIDGE_ADDRESS=""
BRIDGE_STATUS="not deployed"
# Default: attempt to deploy the bridge when the stack starts (set to 0 to skip).
NIL_DEPLOY_BRIDGE="${NIL_DEPLOY_BRIDGE:-1}"
NIL_EVM_DEV_PRIVKEY="${NIL_EVM_DEV_PRIVKEY:-0xa6694e2fb21957d26c442f80f14954fd84f491a79a7e5f1133495403c0244c1d}"
export NIL_EVM_DEV_PRIVKEY
# Shared auth between router and provider for /sp/session-proof forwarding.
NIL_GATEWAY_SP_AUTH="${NIL_GATEWAY_SP_AUTH:-}"
# Enable the EVM mempool by default so JSON-RPC / MetaMask works out of the box.
NIL_DISABLE_EVM_MEMPOOL="${NIL_DISABLE_EVM_MEMPOOL:-0}"
export NIL_DISABLE_EVM_MEMPOOL
# Auto-fund the default demo EVM account by calling the faucet once on startup.
NIL_AUTO_FAUCET_EVM="${NIL_AUTO_FAUCET_EVM:-1}"
NIL_AUTO_FAUCET_EVM_ADDR="${NIL_AUTO_FAUCET_EVM_ADDR:-0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2}"
if [ ! -x "$GO_BIN" ]; then
  GO_BIN="$(command -v go)"
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

if [ -z "$NIL_GATEWAY_SP_AUTH" ]; then
  if command -v openssl >/dev/null 2>&1; then
    NIL_GATEWAY_SP_AUTH="$(openssl rand -hex 32)"
  else
    NIL_GATEWAY_SP_AUTH="$(date +%s%N)"
  fi
fi
export NIL_GATEWAY_SP_AUTH
echo "$NIL_GATEWAY_SP_AUTH" >"$LOG_DIR/sp_auth.txt"

banner() { printf '\n=== %s ===\n' "$*"; }

ensure_nil_core() {
  local lib_dir="$ROOT_DIR/nil_core/target/release"
  nil_core_has_symbols() {
    local sym
    local file=""

```

```scripts/e2e_lifecycle.sh (header excerpt)
#!/usr/bin/env bash
# End-to-end lifecycle test for NilStore:
# 1. Upload a file via Gateway -> get Manifest Root & Size.
# 2. Create a Deal via Gateway (EVM signed) -> get Deal ID.
# 3. Commit Content via Gateway (EVM signed) -> update Deal with Manifest Root.
# 4. Verify Deal state on Chain (LCD).
# 5. Fetch file via Gateway -> verify content.

set -euo pipefail
set -x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"

LCD_BASE="${LCD_BASE:-http://localhost:1317}"
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
FAUCET_BASE="${FAUCET_BASE:-http://localhost:8081}"

CHAIN_ID="${CHAIN_ID:-test-1}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
VERIFYING_CONTRACT="0x0000000000000000000000000000000000000000"
# Deterministic dev key (Foundry default #0).
EVM_PRIVKEY="${EVM_PRIVKEY:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
UPLOAD_FILE="${UPLOAD_FILE:-$ROOT_DIR/README.md}"

export EVM_PRIVKEY EVM_CHAIN_ID CHAIN_ID VERIFYING_CONTRACT

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl required" >&2; exit 1; fi
if ! command -v python3 >/dev/null 2>&1; then echo "ERROR: python3 required" >&2; exit 1; fi

# --- Helper Functions ---

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-30}"
  local delay_secs="${4:-2}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    # curl prints "000" when it cannot connect; don't treat that as reachable.
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done
  echo "ERROR: $name at $url not reachable" >&2
  return 1
}

cleanup() {
  echo "==> Stopping local stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

get_account_sequence() {
  local addr="$1"
  local lcd_base="$2"
  local max_attempts="${3:-10}"
  local delay_secs="${4:-2}"

  echo "==> Getting account sequence for $addr ..." >&2
  for attempt in $(seq 1 "$max_attempts"); do
    resp=$(timeout 10s curl -sS "$lcd_base/cosmos/auth/v1beta1/accounts/$addr")
    seq=$(echo "$resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('account', {}).get('sequence', ''))")
    if [ -n "$seq" ]; then
      echo "$seq"
      return 0
    fi
    echo "    Account sequence not found (attempt $attempt/$max_attempts); sleeping ${delay_secs}s..." >&2
    sleep "$delay_secs"
  done
  echo "ERROR: Failed to get account sequence for $addr" >&2
  return 1
}

fund_account() {
  local addr="$1"
  local faucet_base="$2"
  echo "==> Funding account $addr ..."
  # Allow failure in case already funded or faucet flake, subsequent steps will catch it
  timeout 10s curl -sS -X POST -H "Content-Type: application/json" -d "{\"address\":\"$addr\"}" "$faucet_base/faucet" || true
  echo ""
}

# --- Main Script ---

echo "==> Starting local stack..."
"$STACK_SCRIPT" start

wait_for_http "LCD" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" 40 3
wait_for_http "Gateway" "$GATEWAY_BASE/gateway/create-deal-evm" 40 3
if [ "${CHECK_GATEWAY_STATUS:-0}" = "1" ]; then
  wait_for_http "Gateway status" "$GATEWAY_BASE/status" 40 3
fi

# 1. Derive Addresses
echo "==> Deriving addresses..."
ADDR_JSON=$(python3 - <<PY
from eth_account import Account
import bech32, os
priv = os.environ["EVM_PRIVKEY"]
acct = Account.from_key(priv)
hex_addr = acct.address
data = bytes.fromhex(hex_addr[2:])
five = bech32.convertbits(data, 8, 5)
nil_addr = bech32.bech32_encode("nil", five)
print(hex_addr)
print(nil_addr)
PY
)
EVM_ADDRESS=$(echo "$ADDR_JSON" | sed -n '1p')
NIL_ADDRESS=$(echo "$ADDR_JSON" | sed -n '2p')
echo "    EVM: $EVM_ADDRESS"
echo "    NIL: $NIL_ADDRESS"

fund_account "$NIL_ADDRESS" "$FAUCET_BASE"
sleep 5 # Give chain time to process funding transaction
echo "==> Verifying balance for $NIL_ADDRESS..."
BAL_JSON=$(timeout 10s curl -sS "$LCD_BASE/cosmos/bank/v1beta1/balances/$NIL_ADDRESS" || echo "{}")
echo "$BAL_JSON" | python3 -c "import sys, json; print(json.dumps(json.load(sys.stdin), indent=2))"

# 2. Create Deal (EVM)
echo "==> Creating Deal (EVM-signed)..."

EVM_NONCE=1

CREATE_RESP=""
for i in $(seq 1 5); do
  CREATE_PAYLOAD=$(
    NONCE="$EVM_NONCE" \
    DURATION_BLOCKS=100 \
    SERVICE_HINT="General" \
    INITIAL_ESCROW="1000000" \
    MAX_MONTHLY_SPEND="500000" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" create-deal

```

