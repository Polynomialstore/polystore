# Mainnet Parity Execution Backlog (Codex-Ready Issues)

This file translates `MAINNET_ECON_PARITY_CHECKLIST.md` + `notes/mainnet_policy_resolution_jan2026.md` into **atomic, test-gated issues** that a Codex agent can execute end-to-end.

How to use:
1) Pick the next **P0** issue with no unmet dependencies.
2) Follow the “Codex Prompt” and “DoD/Test Gate”.
3) Ship as a small PR/commit; keep issues narrowly scoped.

Legend:
- **P0**: mainnet/testnet blocking
- **P1**: important but can ship after P0

---

## Stage 0 — Policy Freeze → Params + Genesis Defaults

### ISSUE P0-PARAMS-001 — Expand `Params` to encode finalized policy defaults
**Area:** `nilchain/` (proto + keeper params)  
**Why:** Stage 0 unblocker; keeper logic can’t rely on policy until params exist.  
**Depends on:** none  
**Spec/Refs:** `notes/mainnet_policy_resolution_jan2026.md`, `nilchain/proto/nilchain/nilchain/v1/params.proto`

**Work:**
- Add new fields to `nilchain/proto/nilchain/nilchain/v1/params.proto` for:
  - slashing/jailing ladder params (bps + jail epochs + nonresponse threshold/window)
  - hot/cold splits: `evict_after_missed_epochs_hot/cold`, `credit_cap_bps_hot/cold`
  - bonding params: `min_provider_bond`, `bond_months`, `provider_unbonding_blocks`
  - replacement churn controls: `replacement_cooldown_blocks`, `max_repair_attempts_per_slot_per_window`, `repair_attempt_window_blocks`
  - deputy economics: `premium_bps_{dev/test/mainnet}` (or a single param if network config is by genesis), `evidence_bond`, `failure_bounty`, `evidence_bond_burn_bps_on_expiry`
  - audit budget (Option A): `audit_budget_bps`, `audit_budget_cap_bps`, `audit_budget_carryover_epochs`
- Wire validation + defaults in params keeper (and genesis defaults).
- Update `scripts/run_devnet_alpha_multi_sp.sh` env override wiring for any new params that should be tunable in CI/testnet.

**DoD:**
- `go test ./nilchain/...` passes.
- New params have validation (non-zero where required; bps bounds; sane caps).
- Devnet genesis defaults match `notes/mainnet_policy_resolution_jan2026.md`.

**Codex Prompt:**
“Implement ISSUE P0-PARAMS-001: add all missing on-chain Params fields per `notes/mainnet_policy_resolution_jan2026.md`, wire validation/defaults, and update devnet param override script.”

---

## Stage 1 — Storage Lock-in Pricing + Escrow Accounting

### ISSUE P0-ECON-LOCKIN-001 — Enforce pay-at-ingest lock-in pricing on `UpdateDealContent*`
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001 (for stable price params)  
**Spec/Refs:** `rfcs/rfc-pricing-and-escrow-accounting.md`, `MAINNET_GAP_TRACKER.md` (P0-ECON-001)

**Work:**
- Implement the lock-in debit on `UpdateDealContent*`:
  - compute `storage_cost = ceil(storage_price * delta_bytes * duration_blocks)`
  - enforce escrow/module transfers and deterministic `Deal.escrow_balance` updates
- Ensure replay-safety / determinism (no dependence on wall-clock, ordering stable).
- Add keeper unit tests for accounting correctness.

**DoD/Test Gate:**
- Keeper unit tests validate exact debits for multiple deltas and durations.
- E2E path exists or is extended in ISSUE P0-ECON-E2E-001.

**Codex Prompt:**
“Implement lock-in storage pricing per RFC on `UpdateDealContent*` with deterministic debits and tests.”

### ISSUE P0-ECON-SPEND-002 — Deterministic spend window reset + elasticity debits
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001  
**Spec/Refs:** `rfcs/rfc-pricing-and-escrow-accounting.md` (elasticity), `MAINNET_GAP_TRACKER.md` (P0-ECON-001)

**Work:**
- Implement deterministic monthly spend windows:
  - reset `spend_window_spent` when height exceeds `spend_window_start_height + month_len_blocks`
- Ensure elasticity actions debit escrow and increment spend in-window deterministically.
- Add unit tests for window rollover and cap enforcement.

**DoD/Test Gate:**
- Unit tests cover rollover boundary conditions.

---

## Stage 2 — Retrieval Session Economics (Fees + Settlement)

### ISSUE P0-RETRIEVAL-FEES-001 — Enforce session open burn + variable lock
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001  
**Spec/Refs:** `rfcs/rfc-pricing-and-escrow-accounting.md` §5

**Work:**
- `MsgOpenRetrievalSession` burns `base_retrieval_fee`, locks `retrieval_price_per_blob * blob_count`, debits escrow.
- Reject insufficient escrow and stale manifest roots deterministically.

**DoD/Test Gate:**
- Unit tests confirm base burn and locked fee accounting.

### ISSUE P0-RETRIEVAL-SETTLE-002 — Complete/cancel settlement correctness
**Area:** `nilchain/`  
**Depends on:** P0-RETRIEVAL-FEES-001  
**Spec/Refs:** RFC §5.2–§5.3

**Work:**
- On completion: burn cut (`retrieval_burn_bps`), pay provider, mark session completed.
- On cancel/expiry: refund remaining locked fee to escrow; base fee never refunded.
- Ensure idempotency and replay protection.

**DoD/Test Gate:**
- Unit tests cover open→complete, open→cancel, open→expire flows.

---

## Stage 3 — Deterministic Challenges + Quotas + Credits

### ISSUE P0-QUOTAS-001 — Deterministic challenge derivation + quota state machine
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001  
**Spec/Refs:** `rfcs/rfc-challenge-derivation-and-quotas.md`, `MAINNET_GAP_TRACKER.md` (P0-CHAIN-002)

**Work:**
- Implement deterministic derivation from epoch randomness and chain state.
- Implement quota accounting + enforcement outcomes:
  - invalid proofs → hard faults
  - quota shortfall → HealthState decay (no slash)
- Exclude `REPAIRING` slots from challenges.

**DoD/Test Gate:**
- Keeper unit tests prove determinism (same inputs → same challenges).
- Add adversarial sim harness or extend existing scripts per `MAINNET_GAP_TRACKER.md`.

### ISSUE P1-CREDITS-001 — Credit accounting + phase-in gating
**Area:** `nilchain/`  
**Depends on:** P0-QUOTAS-001, P0-PARAMS-001  
**Spec/Refs:** `rfcs/rfc-challenge-derivation-and-quotas.md`, `notes/mainnet_policy_resolution_jan2026.md`

**Work:**
- Implement credit accrual and uniqueness.
- Implement hot/cold caps:
  - devnet: caps=0
  - testnet: 25%/10%
  - mainnet launch: caps=0; later enable 50%/25%

**DoD/Test Gate:**
- Unit tests show credits do not exceed cap and reduce synthetic demand only when enabled.

---

## Stage 4 — HealthState + Eviction Curve

### ISSUE P0-HEALTH-001 — HealthState per (deal, slot/provider) + eviction triggers
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001, P0-QUOTAS-001  
**Spec/Refs:** `MAINNET_GAP_TRACKER.md` (CHAIN-103), `retrievability-memo.md`

**Work:**
- Define/update HealthState on:
  - quota shortfall
  - invalid proofs
  - thresholded non-response convictions
- Trigger repair when missed epochs exceed `evict_after_missed_epochs_hot/cold`.

**DoD/Test Gate:**
- Unit tests validate decay + triggers.

---

## Stage 5 — Mode 2 Repair + Make-Before-Break Replacement

### ISSUE P0-REPAIR-001 — Deterministic replacement selection + churn controls
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001, P0-HEALTH-001  
**Spec/Refs:** `rfcs/rfc-mode2-onchain-state.md`, `notes/mainnet_policy_resolution_jan2026.md`

**Work:**
- Implement deterministic candidate selection seeded by epoch randomness.
- Enforce cooldown and attempt caps.
- Emit events on backoff; optionally support testnet trusted override (governance/ops gated).

**DoD/Test Gate:**
- Unit tests show deterministic selection and enforcement of cooldown/caps.

### ISSUE P0-REPAIR-E2E-002 — Multi-SP repair e2e: failure → catch-up → promote
**Area:** `scripts/`, `nil_gateway/`, `nilchain/`  
**Depends on:** P0-REPAIR-001, existing repair messages  
**Spec/Refs:** `MAINNET_GAP_TRACKER.md` (P0-CHAIN-001 test gate)

**Work:**
- Extend or add an e2e script:
  - simulate slot failure (kill provider)
  - trigger repair
  - ensure reads succeed throughout (route around REPAIRING)
  - promote candidate and verify reads still succeed

**Test Gate:**
- A CI-invokable script (like `scripts/ci_e2e_gateway_retrieval_multi_sp.sh`) runs reliably.

---

## Stage 6 — Evidence / Fraud Proofs + Penalty Wiring

### ISSUE P0-EVIDENCE-001 — Evidence taxonomy verification + replay protection
**Area:** `nilchain/`  
**Depends on:** P0-PARAMS-001  
**Spec/Refs:** `MAINNET_GAP_TRACKER.md` (P0-CHAIN-003), `retrievability-memo.md`

**Work:**
- Implement evidence verification for:
  - wrong data
  - invalid proof
  - thresholded non-response evidence aggregation
- Add replay protection + TTL behavior.

**DoD/Test Gate:**
- Unit tests per evidence type; e2e demonstrates a slash on proven bad data.

---

## Stage 7 — Deputy Market + Audit Debt (Proxy Retrieval)

### ISSUE P0-DEPUTY-001 — Proxy retrieval settlement + premium payout
**Area:** `nilchain/`, `nil_gateway/`, `nil_p2p/`  
**Depends on:** P0-PARAMS-001, retrieval session settlement  
**Spec/Refs:** `rfcs/rfc-retrieval-validation.md`, `rfcs/rfc-retrieval-security.md`, `notes/mainnet_policy_resolution_jan2026.md`

**Work:**
- Implement proxy retrieval session economics:
  - lock base + variable + premium
  - pay provider + pay deputy premium on success
- Implement evidence bond/bounty and 50% burn on TTL expiry.

**DoD/Test Gate:**
- E2E “ghosting provider” scenario succeeds via deputy and records evidence:
  - base candidate fails
  - deputy serves
  - settlement and premium payout occur

---

## Cross-cutting E2E

### ISSUE P0-ECON-E2E-001 — End-to-end econ accounting regression suite
**Area:** `scripts/`  
**Depends on:** Stage 1–2 issues  
**Spec/Refs:** `MAINNET_GAP_TRACKER.md` (P0-ECON-001 test gate), `scripts/e2e_lifecycle.sh`

**Work:**
- Create or extend an e2e script that:
  - creates a deal
  - uploads/commits
  - opens retrieval session and completes it
  - asserts escrow balance deltas, burns, and provider payouts
- Run under multiple param sets (at least 2).

**DoD/Test Gate:**
- Script is stable in CI and exits non-zero on mismatch.

