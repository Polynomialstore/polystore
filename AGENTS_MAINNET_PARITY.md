# AGENTS_MAINNET_PARITY.md

## 0) Header

This file is the **Codex-executable** execution punch list for completing remaining **Mainnet econ/security parity** work (plus the devnet/testnet launch-critical pieces) across `nilchain/`, `nil_gateway/`, and `nil_p2p/`. It is derived from the staged checklist and the frozen/approved economic and repair policies; tasks are written to be **low ambiguity**, **test-gated**, and small enough to land in **1–3 commits** each.

### How to run locally

```bash
# (1) Start the multi-SP devnet stack (router + multiple providers)
./scripts/run_devnet_alpha_multi_sp.sh start

# (2) Run the CI-style multi-SP gateway retrieval regression (start → test → stop)
./scripts/ci_e2e_gateway_retrieval_multi_sp.sh

# (3) Run the econ lifecycle E2E (create deal → upload/commit → retrieve)
./scripts/e2e_lifecycle.sh

# (4) Run chain unit tests (params/keeper logic)
go test ./nilchain/...
```

---

## 1) Progress Log

Append-only. Do not edit prior entries.

**Template:**

* `YYYY-MM-DD | TASK <ID> | <status> | <notes> | <commit> | <PR link (optional)>`

---

## 2) Working Rules

* **One task at a time:** do not start a new task until the current task’s **Test gate** has been run.
* **No aggressive git commands:** do not run `git clean`, `git reset --hard`, or similar destructive commands.
* **Run test gate before marking done:** a task cannot be marked **done** without running its specified test gate(s).
* **Update this file as you go:**

  * When you begin a task, set **Status → in progress** and add a Progress Log entry.
  * When you finish a task, set **Status → done** and add a Progress Log entry with the commit hash.
  * Keep the progress log append-only. Never delete tasks; only add new tasks if required (use `TASK P0-...` / `TASK P1-...`).
* If this repo uses multiple git remotes, follow the repo’s agent protocol (see `AGENTS.md`).

---

## 3) Task Board

Organized by Stage 0–7 (per `MAINNET_ECON_PARITY_CHECKLIST.md`). Each task must meet its DoD and pass its test gate before being marked done.

---

### Stage 0 — Policy freeze → params + interfaces

#### TASK P0-PARAMS-001 — Encode final policy params (B1/B2/B4/B5/B6) + validation + devnet override plumbing

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/proto/nilchain/nilchain/v1/params.proto`, `nilchain/x/nilchain/types/`, `nilchain/x/nilchain/keeper/`, `scripts/run_devnet_alpha_multi_sp.sh`
* **Depends on:** (none)
* **Context:**

  * `notes/mainnet_policy_resolution_jan2026.md` — **Final defaults** to encode, including:

    * `base_retrieval_fee`: dev/test `0.0001 NIL`, mainnet `0.0002 NIL`
    * Audit budget Option A: `audit_budget_bps`, `audit_budget_cap_bps`, carryover ≤2 epochs, and `epoch_slot_rent` formula
    * Credits phase-in: devnet caps = 0; testnet hot/cold caps 25%/10%; mainnet caps = 0 at launch → later enable
    * Trusted override posture: dev/test enabled **if implemented**; mainnet disabled by default (governance-emergency only)
  * `nilchain/proto/nilchain/nilchain/v1/params.proto` currently ends at field `evict_after_missed_epochs = 17;` (see existing file).
  * `scripts/run_devnet_alpha_multi_sp.sh` has a python `overrides = {...}` block that currently overrides: `month_len_blocks`, `epoch_len_blocks`, `quota_*`, `credit_cap_bps`, `evict_after_missed_epochs`.
  * `rfcs/rfc-challenge-derivation-and-quotas.md` §4–§5 (quota + credits), §7 (state additions).
* **Work plan:**

  1. Extend `Params` in `nilchain/proto/nilchain/nilchain/v1/params.proto` by adding new fields **after** the existing ones (use new field numbers ≥ 18). Do not renumber existing fields.
  2. Add params required to encode the approved policy surfaces:

     * **B1 Slashing/jailing ladder + non-response windowing**

       * `slash_invalid_proof_bps`, `slash_wrong_data_bps`, `slash_nonresponse_bps`
       * `jail_invalid_proof_epochs`, `jail_wrong_data_epochs`, `jail_nonresponse_epochs`
       * `nonresponse_threshold`, `nonresponse_window_epochs`
       * `max_strikes_before_global_jail`, `strike_window_epochs`
       * `evict_after_missed_epochs_hot`, `evict_after_missed_epochs_cold`
     * **B2 Bonding**

       * `min_provider_bond` (Coin), `bond_months` (uint64), `provider_unbonding_blocks` (uint64)
     * **B4 Replacement**

       * `replacement_cooldown_blocks`, `repair_attempts_cap`, `repair_attempt_window_blocks`
     * **B5 Deputy + audit budget**

       * `premium_bps`
       * `evidence_bond`, `failure_bounty`
       * `evidence_bond_burn_bps_on_expiry`
       * `proof_of_failure_ttl_epochs` (default = `nonresponse_window_epochs` unless explicitly set)
       * `audit_budget_bps`, `audit_budget_cap_bps`, `audit_budget_carryover_epochs`
     * **B6 Credits phase-in**

       * `credit_cap_bps_hot`, `credit_cap_bps_cold`
  3. Maintain backwards compatibility where needed:

     * Keep `credit_cap_bps` and `evict_after_missed_epochs` as legacy defaults, but update keeper code to **prefer hot/cold split** if present.
  4. Regenerate protobuf bindings using the repo’s existing proto generation workflow (do not invent new tooling).
  5. Update `Params` defaults and validation (`nilchain/x/nilchain/types/`):

     * Enforce all `*_bps <= 10_000`
     * Enforce epoch/month lengths > 0
     * Enforce `nonresponse_threshold >= 1`, `nonresponse_window_epochs >= 1`
     * Enforce coin denoms match `sdk.DefaultBondDenom` and are non-negative
     * Encode **approved defaults** (per `notes/mainnet_policy_resolution_jan2026.md`), especially:

       * `base_retrieval_fee` defaults (dev/test `0.0001`, mainnet `0.0002` in NIL units; expressed in base denom units)
       * Audit budget defaults: dev/test `audit_budget_bps=200`, `audit_budget_cap_bps=500`, carryover `2`; mainnet `100/200/2`
       * Credit cap defaults: devnet hot/cold = `0/0`; testnet `2500/1000`; mainnet launch `0/0`
  6. Update `scripts/run_devnet_alpha_multi_sp.sh` to support overriding the new params via env vars (follow existing `NIL_*` pattern). Ensure overrides write **stringified** values for uint64 fields (Cosmos JSON convention).
  7. Add/extend unit tests that:

     * parse default params
     * validate params
     * confirm the presence of new fields and that validation rejects obvious invalid values (bps > 10_000, negative coins, etc.).
* **Artifacts:**

  * `nilchain/proto/nilchain/nilchain/v1/params.proto`
  * generated proto outputs under `nilchain/` (wherever this repo keeps `*.pb.go`)
  * `nilchain/x/nilchain/types/` (params defaults + validation)
  * `nilchain/x/nilchain/keeper/` (param accessors, if required)
  * `scripts/run_devnet_alpha_multi_sp.sh`
  * `nilchain/` unit tests for params validation
* **DoD:**

  * New params are present in proto and in generated Go bindings.
  * `Params.Validate()` (or equivalent) enforces the new constraints deterministically.
  * `DefaultParams()` (or equivalent) includes the new fields with values consistent with `notes/mainnet_policy_resolution_jan2026.md` (network-specific differences are documented/handled via genesis/script overrides).
  * Devnet script can override the new params through environment variables without breaking existing overrides.
  * Unit tests cover (at minimum) `base_retrieval_fee`, audit budget bps/cap/carryover, hot/cold eviction thresholds, and nonresponse threshold/window validation.
* **Test gate:**

  * `go test ./nilchain/...`
  * (Optional smoke) `./scripts/run_devnet_alpha_multi_sp.sh start` and ensure chain boots with updated genesis overrides.
* **Notes / gotchas:**

  * Coin params are integers in base denom units; represent `0.0001 NIL` / `0.0002 NIL` consistently with existing denom precision in this repo.
  * Jail durations should be **epoch-based in policy** but stored/enforced as `jail_end_height` (block height) to avoid ambiguity if epoch length changes later.
  * Avoid non-deterministic map iteration when serializing or hashing params/state.

---

### Stage 1 — Storage lock-in pricing + escrow accounting

#### TASK P0-ECON-LOCKIN-001 — Implement pay-at-ingest lock-in pricing on UpdateDealContent* (storage cost deposit)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, (Deal update message handlers), `rfcs/rfc-pricing-and-escrow-accounting.md`
* **Depends on:** `P0-PARAMS-001`
* **Context:**

  * `rfcs/rfc-pricing-and-escrow-accounting.md` §4.1 “Storage lock-in pricing”
  * Deal fields used by the RFC: `size_bytes`, `start_block`, `end_block`, `escrow_balance`
* **Work plan:**

  1. Locate the chain handler(s) that finalize content ingestion (`UpdateDealContent*` variants, including any EVM intent path) and route them through **one shared accounting function**.
  2. Implement **delta-only** charging:

     * `delta_bytes = max(0, new_size_bytes - old_size_bytes)`
     * no repricing and no refunds on shrink.
  3. Compute storage lock-in deposit:

     * `duration_blocks = deal.end_block - deal.start_block`
     * `storage_cost = ceil(storage_price * delta_bytes * duration_blocks)`
  4. Transfer `storage_cost` from deal owner → `nilchain` module account.
  5. Update bookkeeping:

     * `deal.escrow_balance += storage_cost`
  6. Emit an event with `deal_id`, `delta_bytes`, `storage_cost`, `duration_blocks`.
  7. Add unit tests covering:

     * increasing size charges once and is deterministic
     * shrinking size charges 0 (no refund)
     * same size charges 0 (idempotency)
     * ceil rounding behavior on boundary cases
* **Artifacts:**

  * `nilchain/x/nilchain/keeper/` (deal update handlers + shared accounting)
  * `nilchain/x/nilchain/types/` (if deal fields/helpers need updates)
  * new/updated keeper unit tests
* **DoD:**

  * Storage lock-in deposit is charged **only on growth** and is deterministic across runs.
  * The module account receives the deposited funds and `deal.escrow_balance` increases by the same amount.
  * Unit tests validate correct arithmetic and idempotency.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Use deterministic rounding (`ceil`) for `Dec * uint64 * uint64`; avoid float conversions.
  * Protect against overflow by using the repo’s canonical math types for large multiplications.

#### TASK P0-ECON-SPEND-002 — Deterministic spend window reset + deterministic elasticity debits

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-pricing-and-escrow-accounting.md`
* **Depends on:** `P0-PARAMS-001`, `P0-ECON-LOCKIN-001`
* **Context:**

  * `rfcs/rfc-pricing-and-escrow-accounting.md` §6.1–§6.2 “Elasticity caps” and spend windows
  * `params.proto` includes `base_stripe_cost` and `month_len_blocks`
* **Work plan:**

  1. Identify the elasticity trigger path (e.g., `MsgSignalSaturation` or equivalent) that currently enforces `max_monthly_spend` but does not do deterministic debits.
  2. Ensure deal state includes spend window fields:

     * `spend_window_start_height`
     * `spend_window_spent`
     * If missing, add them to the deal type (and wire migrations if needed).
  3. Implement deterministic window reset:

     * If `height >= spend_window_start_height + month_len_blocks`, set `spend_window_start_height = height` and `spend_window_spent = 0`.
  4. Compute elasticity cost deterministically (RFC): `cost = base_stripe_cost * delta_replication` (or the repo’s equivalent unit).
  5. Enforce caps and available escrow:

     * fail if `spend_window_spent + cost > max_monthly_spend`
     * fail if `escrow_balance < cost`
  6. Apply deterministic debit:

     * `escrow_balance -= cost`
     * `spend_window_spent += cost`
  7. Emit an event with `deal_id`, `delta_replication`, `cost`, and window fields.
  8. Add unit tests for:

     * reset boundary correctness
     * cap enforcement
     * escrow debit correctness
* **Artifacts:**

  * `nilchain/x/nilchain/keeper/` (elasticity handler)
  * `nilchain/x/nilchain/types/` (deal state)
  * new/updated unit tests
* **DoD:**

  * Elasticity actions deterministically debit escrow and track window spend.
  * Window reset is height-based and deterministic.
  * Unit tests cover debit, reset, and cap failure cases.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Ensure the debit is replay-safe (same tx cannot be applied twice).
  * Avoid any time-based logic; use heights only.

---

### Stage 2 — Retrieval session economics

#### TASK P0-RETRIEVAL-FEES-001 — Enforce session open: burn base fee + lock variable fee; reject insufficient escrow

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-pricing-and-escrow-accounting.md`
* **Depends on:** `P0-PARAMS-001`, `P0-ECON-LOCKIN-001`
* **Context:**

  * `rfcs/rfc-pricing-and-escrow-accounting.md` §5.1 “Open session”
  * Approved defaults include **lower** `base_retrieval_fee` (dev/test `0.0001 NIL`, mainnet `0.0002 NIL`)
* **Work plan:**

  1. Locate `MsgOpenRetrievalSession` (and any equivalent path) and ensure it has access to: `deal_id`, `manifest_root`, `start_blob`, `blob_count`, `provider`.
  2. Compute fees deterministically:

     * `base_fee = params.base_retrieval_fee`
     * `variable_fee = params.retrieval_price_per_blob * blob_count`
     * `total = base_fee + variable_fee`
  3. Validate:

     * `manifest_root` matches pinned `deal.manifest_root`
     * `deal.escrow_balance >= total`
  4. Accounting at open (RFC):

     * Burn `base_fee` from the **module account** (non-refundable).
     * Decrement `deal.escrow_balance -= (base_fee + variable_fee)`.
     * Store `session.locked_fee = variable_fee`.
  5. Add events for session open with fee breakdown.
  6. Add unit tests:

     * insufficient escrow fails
     * base fee is burned at open (and not refunded later)
     * locked_fee equals computed variable_fee and is stored once
* **Artifacts:**

  * `nilchain/x/nilchain/keeper/` (session open handler)
  * `nilchain/x/nilchain/types/` (session state)
  * unit tests for retrieval open
* **DoD:**

  * Session open burns the base fee and locks the variable fee per RFC.
  * Insufficient escrow prevents session creation.
  * Unit tests confirm burn/lock behavior and determinism.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Burning must reduce actual supply / module balance (not just bookkeeping).
  * Ensure denom consistency for base and variable fees.

#### TASK P0-RETRIEVAL-SETTLE-002 — Enforce settlement: burn cut + provider payout; cancel/expiry refunds locked fee only

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-pricing-and-escrow-accounting.md`
* **Depends on:** `P0-RETRIEVAL-FEES-001`
* **Context:**

  * `rfcs/rfc-pricing-and-escrow-accounting.md` §5.2 “Completion” and §5.3 “Cancel/expire”
  * `retrieval_burn_bps` defines the burn cut on completion (dev/test lower than mainnet, per policy defaults)
* **Work plan:**

  1. Implement completion path (`MsgConfirmRetrievalSession` or equivalent):

     * verify session is OPEN and proof is valid
  2. Compute settlement:

     * `burn_cut = ceil(locked_fee * retrieval_burn_bps / 10_000)`
     * `payout = locked_fee - burn_cut`
  3. Apply settlement:

     * burn `burn_cut` from module account
     * transfer `payout` from module → provider
     * mark session COMPLETED and zero out locked amount (or mark “settled”)
  4. Implement cancel/expiry path:

     * refund only `locked_fee` back into `deal.escrow_balance`
     * base fee remains burned and is never refunded
     * mark session CANCELLED/EXPIRED and zero out locked amount
  5. Add unit tests:

     * open→complete burn/payout math
     * open→cancel refunds locked only
     * expiry path is deterministic and idempotent
* **Artifacts:**

  * `nilchain/x/nilchain/keeper/` (settlement handlers)
  * `nilchain/x/nilchain/types/` (session state)
  * unit tests for settlement/cancel/expiry
* **DoD:**

  * Completion burns the configured cut and pays provider the remainder.
  * Cancel/expiry refunds only the locked variable portion.
  * Unit tests validate accounting and idempotency.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Avoid double-settlement; enforce a strict session state machine.
  * Use deterministic rounding (`ceil`) for burn cut.

#### TASK P0-ECON-E2E-001 — End-to-end econ accounting regression suite (escrow + burns + payouts + refunds)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `scripts/`, `tests/` (if present), chain queries/CLI flows
* **Depends on:** `P0-ECON-LOCKIN-001`, `P0-ECON-SPEND-002`, `P0-RETRIEVAL-FEES-001`, `P0-RETRIEVAL-SETTLE-002`
* **Context:**

  * `scripts/e2e_lifecycle.sh` is the baseline lifecycle E2E.
  * `scripts/ci_e2e_gateway_retrieval_multi_sp.sh` is the CI-style script pattern (start/stop stack, deterministic asserts).
  * `MAINNET_GAP_TRACKER.md` P0-ECON-001 requires E2E coverage for escrow and session economics.
* **Work plan:**

  1. Extend `scripts/e2e_lifecycle.sh` **or** add a new econ-specific script in `scripts/` that:

     * creates a deal
     * uploads/commits (triggers lock-in deposit)
     * opens a retrieval session and completes it
     * opens another session and cancels/expires it
  2. Add deterministic assertions by querying chain state:

     * `deal.escrow_balance` changes as expected:

       * increases on ingest by `storage_cost`
       * decreases on open by `base_fee + variable_fee`
       * increases on cancel by `locked_fee` refund
     * module account balance reflects burns/payouts
  3. Support at least two param regimes via existing env overrides (fast blocks / cheap fees for CI).
  4. Make failures actionable: print before/after values and computed expected deltas.
* **Artifacts:**

  * `scripts/e2e_lifecycle.sh` and/or a new `scripts/e2e_econ_parity.sh`
  * optionally a `scripts/ci_*` wrapper matching existing CI style
* **DoD:**

  * Script exits non-zero on mismatch.
  * Script validates escrow delta, base fee burn, burn cut, provider payout, and cancel refund.
  * Script is stable (bounded retries/timeouts; no infinite waits).
* **Test gate:**

  * `./scripts/e2e_lifecycle.sh` (or the new econ script)
  * (If added) the new `./scripts/ci_*` wrapper
* **Notes / gotchas:**

  * Prefer polling for state transitions over fixed sleeps.
  * Ensure the script uses the same denom expected by the chain (devnet uses `sdk.DefaultBondDenom`, typically `stake`).

---

### Stage 3 — Deterministic challenge derivation + quotas + synthetic fill

#### TASK P0-QUOTAS-001 — Deterministic challenge derivation (Mode1 + Mode2) with REPAIRING exclusions

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-challenge-derivation-and-quotas.md`
* **Depends on:** `P0-PARAMS-001`
* **Context:**

  * `rfcs/rfc-challenge-derivation-and-quotas.md` §3.1–§3.4 (epoch randomness and derivation)
  * Policy requirement: **REPAIRING slots excluded** from synthetic challenges
* **Work plan:**

  1. Implement epoch randomness `R_e` derivation exactly per RFC:

     * `R_e = SHA256("nilstore/epoch/v1" || chain_id || epoch_id || block_hash(epoch_start_height))`
     * store `block_hash(epoch_start_height)` deterministically at epoch boundary if required.
  2. Implement derivation functions for:

     * Mode1: `(provider, deal_id, i) → mdu_index, blob_index`
     * Mode2: `(slot, current_gen, deal_id, i) → leaf_index → (row, mdu_ordinal) → mdu_index, blob_index`
  3. Enforce exclusions:

     * do not target metadata MDUs: `mdu_index >= meta_mdus` where `meta_mdus = 1 + witness_mdus`
     * skip Mode2 slots with status != ACTIVE (REPAIRING excluded)
  4. Add membership-check helper for “is this proof one of the derived synthetic challenges for epoch e?”
  5. Add unit tests for determinism and exclusions.
* **Artifacts:**

  * `nilchain/x/nilchain/keeper/` derivation helpers
  * `nilchain/x/nilchain/types/` helper funcs/constants
  * unit tests for determinism/exclusion
* **DoD:**

  * Challenge derivation matches RFC structure and is deterministic.
  * Unit tests prove metadata is never targeted and REPAIRING slots are excluded.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Avoid iterating over maps to build challenge sets; use sorted lists for any provider/slot enumeration.
  * Keep derivation code pure and easily testable.

#### TASK P0-QUOTAS-002 — Quota accounting + synthetic fill tracking + end-of-epoch evaluation (quota shortfall is HealthState-only)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-challenge-derivation-and-quotas.md`
* **Depends on:** `P0-QUOTAS-001`
* **Context:**

  * `rfcs/rfc-challenge-derivation-and-quotas.md` §4.1–§4.2 (quota computation), §6.2–§6.3 (enforcement)
  * Policy decision: **quota shortfall does not slash**; it drives HealthState only
* **Work plan:**

  1. Implement quota computation per RFC:

     * compute `slot_bytes` for each assignment
     * compute `quota_blobs` using `quota_bps_per_epoch_*`, min/max clamps
  2. Track synthetic satisfaction deterministically:

     * maintain a `SyntheticSeen` uniqueness set (challenge-id keyed) to prevent double-counting
     * increment `synthetic_satisfied_blobs` only for valid, in-set proofs
  3. At epoch end, evaluate:

     * if `synthetic_satisfied_blobs < quota_blobs` → record quota miss (soft failure) and emit event
     * do not slash for quota shortfall
  4. Provide a hook or callout for Stage 4 HealthState updates (soft failure path).
  5. Add unit tests for quota calc, clamps, dedup, and epoch evaluation.
* **Artifacts:**

  * keeper quota accounting + storage keys
  * unit tests for quota accounting
* **DoD:**

  * Quota miss results in recorded soft failure and event emission.
  * No slashing occurs from quota shortfall.
  * Uniqueness set prevents double counting.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Ensure `SyntheticSeen` state is pruned/TTL’d to prevent unbounded growth.
  * Avoid heavy per-epoch O(N * quota_blobs) loops; respect `quota_max_blobs`.

#### TASK P1-CREDITS-001 — Organic retrieval credits: accrual rules, caps, and phase-in defaults (devnet off, testnet limited, mainnet off at launch)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-challenge-derivation-and-quotas.md`
* **Depends on:** `P0-QUOTAS-002`, `P0-RETRIEVAL-SETTLE-002`, `P0-PARAMS-001`
* **Context:**

  * `rfcs/rfc-challenge-derivation-and-quotas.md` §5 (organic credits)
  * Phase-in (policy): devnet caps = 0; testnet caps hot/cold = 25%/10%; mainnet launch caps = 0
* **Work plan:**

  1. Implement credit-id derivation and uniqueness set (`CreditSeen`) per RFC §5.1–§5.2 with TTL pruning.
  2. Accrue credits on successful “organic” retrieval proofs/receipts.
  3. Apply caps using hot/cold split params:

     * `credit_cap_hot = ceil(quota_blobs * credit_cap_bps_hot / 10_000)`
     * `credit_cap_cold = ceil(quota_blobs * credit_cap_bps_cold / 10_000)`
  4. Integrate into synthetic fill:

     * `synthetic_needed = max(0, quota_blobs - min(credits_unique, credit_cap))`
  5. Add unit tests for uniqueness, caps, and synthetic reduction.
* **Artifacts:**

  * keeper credit accounting
  * credit uniqueness TTL/pruning
  * unit tests
* **DoD:**

  * Credits accrue only once per credit-id (uniqueness enforced).
  * Caps apply correctly for hot/cold deals.
  * Devnet defaults yield no quota reduction (caps = 0), but accounting code exists.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Credit state growth must be bounded; TTL pruning is mandatory.
  * Ensure credits cannot reduce quota beyond policy caps in any mode.

#### TASK P0-QUOTAS-SIM-003 — Adversarial sim / determinism gate for anti-grind properties

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `scripts/`, `performance/` (if present), or `nilchain/` property tests
* **Depends on:** `P0-QUOTAS-001`
* **Context:**

  * `MAINNET_ECON_PARITY_CHECKLIST.md` Stage 3 requires an adversarial sim test gate.
* **Work plan:**

  1. Add a deterministic property test (or a small sim harness) that generates:

     * multiple epochs
     * multiple deals (Mode1 + Mode2)
     * multiple assignments and slot statuses (including REPAIRING)
       and asserts invariants (bounds, exclusions, determinism).
  2. Provide a single command to run it (either `go test ...` or a wrapper script in `scripts/`).
  3. Keep runtime short and deterministic (fixed RNG seed).
* **Artifacts:**

  * sim test code (under `nilchain/` or a script wrapper)
  * documentation comment in the sim explaining invariants
* **DoD:**

  * Sim gate exists, runs deterministically, and fails on invariant violation.
* **Test gate:**

  * The command you add (e.g., `go test ./nilchain/... -run TestChallengeDerivationSim` or `./scripts/...`)
* **Notes / gotchas:**

  * Do not assert probabilistic distribution properties with tight thresholds; focus on correctness invariants.

---

### Stage 4 — HealthState + eviction curve

#### TASK P0-HEALTH-001 — HealthState per (deal, provider/slot): updates from hard/soft failures + hot/cold eviction thresholds

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-QUOTAS-002`, `P0-PARAMS-001`
* **Context:**

  * `MAINNET_ECON_PARITY_CHECKLIST.md` Stage 4
  * Policy: eviction thresholds differ by service class: hot vs cold (params `evict_after_missed_epochs_hot/cold`)
* **Work plan:**

  1. Define/store HealthState keyed by `(deal_id, assignment)` where assignment is:

     * Mode1: provider address
     * Mode2: `(slot_index)` or `(provider, slot_index)` as required by existing schema
  2. Implement soft failure update hook from quota evaluation:

     * increment missed epochs
     * emit event
  3. Implement hard failure update hook (fed by Stage 6 evidence outcomes):

     * mark as hard-failed
     * emit event
  4. Implement eviction trigger:

     * on soft failure, compare against hot/cold threshold and trigger repair start (Stage 5) once
     * on hard failure, trigger immediate repair start (Stage 5)
  5. Unit tests for:

     * hot/cold threshold differences (recommended: hot=2, cold=6 per policy)
     * single-trigger behavior (no repeated starts)
* **Artifacts:**

  * health state structs + store keys
  * keeper hooks from quota/evidence paths
  * unit tests
* **DoD:**

  * HealthState updates occur for both soft and hard failures.
  * Eviction triggers follow hot/cold thresholds and do not spam-trigger.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Ensure HealthState updates are idempotent; the same epoch’s miss should not be counted twice.
  * Avoid “repair thrash” by recording last repair-trigger epoch/height.

#### TASK P0-HEALTH-002 — Health observability: queries + events suitable for testnet monitoring

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, query layer
* **Depends on:** `P0-HEALTH-001`
* **Context:**

  * `notes/mainnet_policy_resolution_jan2026.md` includes testnet monitoring signals for slashing/jailing, repair rates, etc.
* **Work plan:**

  1. Emit explicit events for:

     * soft miss recorded
     * eviction threshold crossed
     * repair started (include reason: soft vs hard)
  2. Add query endpoints to fetch HealthState:

     * by deal+assignment
     * list for a deal (paginated)
  3. Add unit tests for query correctness and event emission.
* **Artifacts:**

  * query proto/service updates (existing query files)
  * keeper query handlers
  * unit tests
* **DoD:**

  * HealthState is queryable and events are emitted with stable fields.
  * Query pagination prevents unbounded responses.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Do not embed large binary blobs in events; keep events indexable and lightweight.

---

### Stage 5 — Mode 2 repair + make-before-break replacement

#### TASK P0-MODE2-MBB-001 — Make-before-break replacement state machine (slot status, catch-up, promotion)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, `rfcs/rfc-mode2-onchain-state.md`
* **Depends on:** `P0-PARAMS-001`, `P0-HEALTH-001`
* **Context:**

  * `rfcs/rfc-mode2-onchain-state.md` §3.3 (repair workflow) and slot fields (`pending_provider`, `repair_target_gen`, `status_since_height`)
* **Work plan:**

  1. Locate existing Mode2 slot state and confirm it matches RFC concepts (`ACTIVE`, `REPAIRING`, `pending_provider`, `repair_target_gen`).
  2. Implement `StartRepair` transition:

     * only from `ACTIVE`
     * set `status=REPAIRING`, `pending_provider=candidate`, `repair_target_gen=current_gen`, `status_since_height=height`
  3. Implement `Promote` transition:

     * only from `REPAIRING`
     * require a deterministic readiness proof that candidate caught up to `repair_target_gen`
     * on success, swap provider, clear pending fields, return to `ACTIVE`
  4. Ensure legacy compatibility: if `deal.providers[]` exists, keep it synced with slot providers.
  5. Add unit tests for correct state transitions and invalid-state rejection.
* **Artifacts:**

  * Mode2 slot keeper logic
  * state transition tests
* **DoD:**

  * State transitions implement make-before-break semantics (no “break-before-make” window).
  * Promotion requires an objective readiness condition.
  * Unit tests cover start/promotion and failure cases.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Promotion must be replay-safe; no double swaps.
  * Read routing must not depend on pending provider until promotion.

#### TASK P0-BOND-001 — Provider bonding baseline: provider bond state + min_provider_bond enforcement

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, provider registry/activation path
* **Depends on:** `P0-PARAMS-001`
* **Context:**

  * `notes/mainnet_policy_resolution_jan2026.md` B2 “Bonding: base bond + assignment collateral”
* **Work plan:**

  1. Identify how storage providers are represented/registered in this repo (and where eligibility is checked).
  2. Implement or extend provider bond state:

     * `bonded_amount`
     * `locked_amount` (reserved for assignments)
     * `unbonding_end_height` (if unbonding exists)
  3. Enforce `min_provider_bond`:

     * providers below min are ineligible for new assignments and deputy duties.
  4. Add query for provider bond state (required for operator UX and debugging).
  5. Unit tests for min bond enforcement.
* **Artifacts:**

  * provider bond keeper/types
  * query support
  * unit tests
* **DoD:**

  * Providers below `min_provider_bond` are deterministically rejected by assignment selection.
  * Provider bond state is queryable.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * If the repo already uses staking for provider collateral, do not duplicate; map “bond” to the existing stake source and document it.

#### TASK P0-BOND-002 — Assignment collateral: bond_months * storage_price * month_len_blocks * slot_bytes (locked) + unbonding lock

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-BOND-001`, `P0-ECON-LOCKIN-001`, `P0-MODE2-MBB-001`
* **Context:**

  * Policy formula (B2): `required_bond = ceil(bond_months * storage_price * month_len_blocks * slot_bytes)`
* **Work plan:**

  1. Implement deterministic `slot_bytes` computation (reuse quota slot_bytes logic if possible).
  2. Implement required collateral calculation and locking:

     * lock additional bond when provider is assigned a slot (or becomes pending_provider in REPAIRING)
     * unlock when provider is removed/unassigned (including replacement/promotion)
  3. Enforce unbonding lock:

     * prevent unbonding/withdrawal that would drop provider below `bonded_amount - locked_amount`
     * enforce `provider_unbonding_blocks` if unbonding workflow exists
  4. Unit tests for lock/unlock and rejection of insufficient collateral.
* **Artifacts:**

  * keeper bond locking logic
  * unit tests
* **DoD:**

  * Assignment collateral is locked deterministically and scales with `slot_bytes`.
  * Providers cannot escape required collateral via unbonding while assigned.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Use ceil rounding for required bond to avoid under-collateralization.

#### TASK P0-REPAIR-001 — Deterministic replacement selection + churn/griefing controls (cooldown + attempt caps)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-MODE2-MBB-001`, `P0-BOND-001`, `P0-BOND-002`, `P0-HEALTH-001`
* **Context:**

  * `notes/mainnet_policy_resolution_jan2026.md` B4 “Replacement selection”
  * Required controls: `replacement_cooldown_blocks`, `repair_attempts_cap`, `repair_attempt_window_blocks`
* **Work plan:**

  1. Implement deterministic candidate ranking seeded by epoch randomness (B4):

     * seed includes `R_e`, `deal_id`, `slot`, `current_gen`, and an attempt nonce
  2. Define eligibility:

     * not jailed
     * meets min bond + assignment collateral availability
     * not the current slot provider
  3. Implement cooldown enforcement:

     * do not start a new repair for the same slot if the last start was within `replacement_cooldown_blocks`
  4. Implement attempt caps:

     * track attempts per slot in a rolling window of `repair_attempt_window_blocks`
     * after `repair_attempts_cap`, enter backoff state (document exact behavior)
  5. Emit events for selection decisions and reasons for rejection.
  6. Add unit tests for determinism, cooldown, and cap behavior.
* **Artifacts:**

  * keeper candidate selection + state counters
  * unit tests
* **DoD:**

  * Candidate selection is deterministic and repeatable given the same inputs.
  * Cooldown and attempt caps prevent repair churn/grief.
  * Eligibility checks include bond and jail status.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Never iterate over an unsorted provider set when ranking; sort before hashing.
  * Keep attempt counters bounded; prune by window.

#### TASK P0-MODE2-ROUTING-002 — Ensure reads avoid REPAIRING slots (gateway/router)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nil_gateway/`
* **Depends on:** `P0-MODE2-MBB-001`, `P0-REPAIR-001`
* **Context:**

  * Stage 5 requirement: reads succeed throughout repair (router must avoid `REPAIRING`)
* **Work plan:**

  1. Locate the Mode2 provider selection logic in `nil_gateway/`.
  2. Ensure gateway fetches slot **status** (not just provider addresses). If the existing chain query does not include status, extend it or add a new query.
  3. Update routing:

     * choose `K` slots among those with `status=ACTIVE`
     * retry using other ACTIVE slots if a provider fails
  4. Add a regression test hook in the repair E2E that asserts retrieval succeeds while one slot is REPAIRING.
* **Artifacts:**

  * gateway routing code changes
  * any chain query usage updates needed by gateway
* **DoD:**

  * Gateway never routes reads to REPAIRING slots unless there are insufficient ACTIVE slots (then it fails fast with an explicit error).
  * Repair E2E confirms no outage during repair.
* **Test gate:**

  * `./scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
  * (After Stage 5 E2E exists) run `P0-REPAIR-E2E-002` gate
* **Notes / gotchas:**

  * Avoid infinite retry loops; cap retries and log tried providers.

#### TASK P0-MODE2-REWARD-003 — Repairing slots earn no rewards and are ignored by synthetic challenges

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-QUOTAS-001`, `P0-QUOTAS-002`, `P0-MODE2-MBB-001`
* **Context:**

  * Stage 5 requirement: synthetic challenges ignore REPAIRING; repairing slots do not earn rewards
* **Work plan:**

  1. Verify/ensure challenge derivation excludes non-ACTIVE slots (from `P0-QUOTAS-001`).
  2. Ensure quota accounting does not require proofs for REPAIRING slots.
  3. If the chain pays any liveness/retrieval rewards, ensure REPAIRING slots are rejected or paid 0.
  4. Add unit tests that:

     * derived challenges never target repairing slots
     * quota for repairing slots is effectively 0 / excluded
* **Artifacts:**

  * keeper logic updates
  * unit tests
* **DoD:**

  * Repairing slots are excluded from challenges, quotas, and rewards.
  * Unit tests validate exclusion end-to-end at the keeper level.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Separate “repair readiness proofs” from “liveness proofs” so you don’t accidentally pay for repair traffic.

#### TASK P0-REPAIR-E2E-002 — Multi-SP repair e2e: slot failure → catch-up → promotion; reads succeed throughout

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `scripts/`, `nil_gateway/`, (devnet stack)
* **Depends on:** `P0-MODE2-MBB-001`, `P0-REPAIR-001`, `P0-MODE2-ROUTING-002`
* **Context:**

  * `scripts/ci_e2e_gateway_retrieval_multi_sp.sh` demonstrates the preferred CI gate shape.
  * Stage 5 requires an E2E gate validating “replacement without read outage”.
* **Work plan:**

  1. Add a CI-friendly script (new or extension) that:

     * starts multi-SP stack
     * creates a Mode2 deal + uploads data
     * kills/ghosts one provider process corresponding to a slot
     * waits for repair start (or triggers it through chain state if already exposed)
     * verifies gateway retrieval succeeds during repair
     * completes catch-up + triggers promotion
     * verifies on-chain slot provider changed and slot returns ACTIVE
  2. Add assertions (exit non-zero on failure) and bounded polling loops.
  3. If needed, add a `scripts/ci_e2e_mode2_repair_multi_sp.sh` wrapper mirroring the existing `ci_` script style.
* **Artifacts:**

  * new or updated script(s) under `scripts/`
* **DoD:**

  * E2E demonstrates make-before-break repair with no read outage.
  * Script is stable (timeouts, logs, deterministic).
* **Test gate:**

  * the new/updated repair E2E script command
* **Notes / gotchas:**

  * Avoid flakiness by polling chain state and gateway health endpoints rather than sleeping.

#### TASK P1-REPAIR-OVERRIDE-001 — Trusted repair override posture (dev/test enabled if implemented; mainnet disabled by default)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-MODE2-MBB-001`, `P0-REPAIR-001`
* **Context:**

  * Policy posture requirement (explicit): dev/test enabled **if implemented**; mainnet disabled by default, governance-emergency only.
* **Work plan:**

  1. If implementing the override, do it as an **authority-only** (governance) message, not a user tx.
  2. Gate functionality behind a boolean param (default: enabled in dev/test genesis; disabled in mainnet genesis).
  3. Ensure override actions emit explicit events and are auditable.
  4. Unit tests verifying:

     * unauthorized cannot call
     * mainnet default disables
* **Artifacts:**

  * optional new msg + keeper handler
  * unit tests
* **DoD:**

  * Override cannot be invoked by non-authority.
  * Mainnet default is disabled; dev/test default is enabled (if feature exists).
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Keep this as an emergency tool only; do not allow silent bypass of bonding/slashing unless explicitly authorized.

---

### Stage 6 — Evidence / fraud proofs pipeline

#### TASK P0-EVIDENCE-001 — Evidence taxonomy + verification + replay protection + slash/jail/evict wiring (B1)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`, evidence/proof proto handlers
* **Depends on:** `P0-PARAMS-001`, `P0-HEALTH-001`, `P0-MODE2-MBB-001`, `P0-REPAIR-001`
* **Context:**

  * `MAINNET_ECON_PARITY_CHECKLIST.md` Stage 6
  * Policy ladder (B1):

    * invalid proof: slash 0.5% (50 bps), jail 3 epochs
    * wrong data: slash 5% (500 bps), jail 30 epochs
    * non-response: handled in Stage 7 aggregation; this task handles hard-fault proofs
* **Work plan:**

  1. Enumerate evidence types required for hard faults:

     * invalid proof (cryptographic verification fails)
     * wrong data (provable mismatch against commitment/manifest)
  2. Implement verification paths for both:

     * accept only if verifiable on-chain
     * compute stable `evidence_id` hash and enforce replay protection
  3. Wire penalties using B1 params:

     * slash provider bond by bps (deterministic rounding)
     * jail provider for configured epochs (store/enforce as end-height)
  4. Integrate with repair start:

     * on conviction, immediately trigger Mode2 repair start (hard failure)
  5. Add unit tests per evidence type:

     * verify acceptance, replay rejection
     * verify slash/jail/repair triggered exactly once
* **Artifacts:**

  * evidence message/handler implementation
  * keeper slashing/jailing primitives
  * unit tests
* **DoD:**

  * Evidence is verified on-chain, replay-protected, and applies the configured slash/jail.
  * Hard-fault evidence triggers repair start for Mode2.
  * Unit tests cover correctness and idempotency.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Do not allow multiple evidence submissions to cause repeated slashes; store a “penalized” marker keyed by `evidence_id` or `(deal, slot, epoch)`.
  * Jail duration should be policy epoch-based but enforced at height granularity.

#### TASK P0-EVIDENCE-E2E-002 — E2E evidence gate: proven wrong data → slash + jail + repair start

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `scripts/`, provider/gateway test hooks
* **Depends on:** `P0-EVIDENCE-001`, `P0-REPAIR-E2E-002` (or at least `P0-REPAIR-001`)
* **Context:**

  * Stage 6 requires an E2E demonstrating slash on proven bad data.
* **Work plan:**

  1. Add a script that:

     * sets up a deal and uploads content
     * causes a provider to return provably wrong data for a known shard (test hook or controlled corruption)
     * submits wrong-data evidence tx
     * asserts: provider slashed, jailed, and slot enters REPAIRING
  2. Keep it gated and deterministic (explicit provider index, bounded polling).
* **Artifacts:**

  * new script under `scripts/`
  * (if needed) provider test hook guarded by env var
* **DoD:**

  * The script deterministically demonstrates slash/jail/repair transition from wrong-data evidence.
* **Test gate:**

  * the new evidence E2E script command
* **Notes / gotchas:**

  * Corruption should be opt-in test mode only; never default-enable in normal runs.

---

### Stage 7 — Deputy market + proxy retrieval + audit debt

#### TASK P0-DEPUTY-001 — Proxy retrieval economics (chain): premium lock + premium payout on success

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-PARAMS-001`, `P0-RETRIEVAL-SETTLE-002`
* **Context:**

  * Policy (B5): proxy premium defaults: dev/test 20% (`premium_bps=2000`), mainnet 10% (`premium_bps=1000`)
  * Proxy semantics: user pays market rate + premium; provider paid as normal; deputy gets premium on success
* **Work plan:**

  1. Extend retrieval session accounting to represent proxy sessions (reuse existing session type if possible; otherwise add a dedicated proxy session type).
  2. On proxy session open:

     * burn base fee (same as normal)
     * lock variable fee and lock premium fee
     * decrement escrow by `base + variable + premium`
  3. On completion:

     * settle variable fee (burn cut + provider payout) as normal
     * pay premium to deputy (no burn unless explicitly specified elsewhere)
  4. Add unit tests for:

     * premium calculation and payout
     * premium paid only on success and only to the deputy
* **Artifacts:**

  * chain session logic updates
  * unit tests
* **DoD:**

  * Proxy sessions correctly lock/payout premium.
  * Premium is not paid without a successful proof-based completion.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Ensure deputy cannot be the same entity as the failing provider for the same session (or document/guard if allowed).

#### TASK P0-DEPUTY-002 — Proof-of-failure aggregation + evidence incentives (bond/bounty + partial burn on TTL expiry)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-DEPUTY-001`, `P0-PARAMS-001`, `P0-EVIDENCE-001`
* **Context:**

  * Policy (B1): `nonresponse_threshold=3`, `nonresponse_window_epochs=6`, `slash_nonresponse_bps=100`, `jail_nonresponse_epochs=10`
  * Policy (B5): `evidence_bond=0.01 NIL`, `failure_bounty=0.02 NIL`, burn 50% on TTL expiry (`evidence_bond_burn_bps_on_expiry=5000`)
* **Work plan:**

  1. Add a proof-of-failure submission message and store:

     * replay-protect proof-of-failure ids
     * lock `evidence_bond` on submission (module holds funds)
     * set expiry epoch = now + `proof_of_failure_ttl_epochs` (default = `nonresponse_window_epochs`)
  2. Maintain an aggregation window keyed by target provider (and optionally deal/slot):

     * count distinct deputies within `nonresponse_window_epochs`
     * convict when count >= `nonresponse_threshold`
  3. On conviction:

     * apply slash/jail for non-response
     * refund evidence bonds for proofs contributing to conviction
     * pay `failure_bounty` to deputies (define funding source; prefer audit budget module once implemented)
  4. On expiry without conviction:

     * burn `evidence_bond_burn_bps_on_expiry` portion
     * refund remainder
  5. Unit tests for windowing, distinct deputy counting, conviction idempotency, and bond burn/refund.
* **Artifacts:**

  * on-chain proof-of-failure storage + handlers
  * bond/bounty settlement logic
  * unit tests
* **DoD:**

  * Non-response conviction triggers at the configured threshold/window.
  * Evidence bond is locked and either refunded+bountied (on conviction) or partially burned (on expiry).
  * Unit tests cover all state transitions deterministically.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Defend against Sybil reporters via the bond and by ensuring deputies are selected by the gateway/p2p layer (not arbitrary self-assigned).

#### TASK P0-AUDIT-001 — Audit budget minting (Option A): audit_budget_bps/cap + carryover ≤2 epochs + epoch_slot_rent formula

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-PARAMS-001`, `P0-MODE2-MBB-001`, `P0-MODE2-REWARD-003`
* **Context:**

  * Policy (Option A, closed):

    * `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`
    * `audit_budget_mint = ceil(audit_budget_bps/10_000 * epoch_slot_rent)` capped by `audit_budget_cap_bps`
    * carryover unused budget for ≤2 epochs
* **Work plan:**

  1. Implement deterministic computation of `total_active_slot_bytes`:

     * include ACTIVE Mode2 slots only
     * include Mode1 assignments (if applicable)
     * exclude REPAIRING slots
  2. At epoch boundary, compute `epoch_slot_rent` and `audit_budget_mint` with cap.
  3. Mint budget into the designated module account and track spendable budget with bounded carryover (≤2 epochs).
  4. Emit events for rent, mint, cap binding, carryover, and expirations/burns.
  5. Unit tests:

     * mint math correctness (ceil + cap)
     * carryover expiry after 2 epochs
* **Artifacts:**

  * epoch boundary keeper logic
  * audit budget state storage
  * unit tests
* **DoD:**

  * Audit budget mints deterministically per epoch and honors cap + carryover ≤2 epochs.
  * REPAIRING slots are excluded from rent computation.
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Avoid full chain scans each epoch if it’s too costly; prefer maintaining an incrementally updated aggregate, but correctness comes first.

#### TASK P0-AUDIT-002 — Audit debt tracking + budget spend path (MVP)

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nilchain/x/nilchain/keeper/`, `nilchain/x/nilchain/types/`
* **Depends on:** `P0-AUDIT-001`, `P0-DEPUTY-002`
* **Context:**

  * `MAINNET_GAP_TRACKER.md` P0-P2P-001 expects “audit debt tasks assignable/trackable” and budget utilization monitoring.
* **Work plan:**

  1. Implement minimal audit debt state:

     * per-provider counters for “audit required” and “audit completed”
     * query endpoints for outstanding debt
  2. Define a minimal “spend from audit budget” primitive used by:

     * paying `failure_bounty` on conviction
     * paying for audit retrieval traffic (if/when integrated)
  3. Unit tests for deterministic debt updates and budget spend accounting.
* **Artifacts:**

  * audit debt state + query
  * budget spend helper
  * unit tests
* **DoD:**

  * Audit debt is stored and queryable.
  * Audit budget can be debited deterministically for bounties (and later audits).
* **Test gate:**

  * `go test ./nilchain/...`
* **Notes / gotchas:**

  * Keep MVP tight: trackability first; full audit task scheduling can iterate later.

#### TASK P0-DEPUTY-003 — Deputy routing (gateway + p2p): AskForProxy → deputy serves → chain settlement

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `nil_p2p/`, `nil_gateway/`
* **Depends on:** `P0-DEPUTY-001`, `P0-DEPUTY-002`, `P0-AUDIT-001`
* **Context:**

  * `MAINNET_GAP_TRACKER.md` P0-P2P-001: `nil_p2p` has an `AskForProxy` stub that must be implemented.
  * Stage 7 requires end-to-end proxy retrieval (selection, routing, settlement).
* **Work plan:**

  1. Implement `AskForProxy` request/response flow in `nil_p2p/`:

     * request identifies deal/range/provider and premium offer
     * response provides a deputy endpoint/identity
  2. Gateway integrates fallback logic:

     * on primary failure, call `AskForProxy` and fetch from deputy
     * on success, submit proxy settlement to chain
     * on failure, submit proof-of-failure to chain (locks bond)
  3. Add logging/metrics hooks aligned with monitoring signals (proxy success rate, deputy fraction).
* **Artifacts:**

  * `nil_p2p/` AskForProxy implementation
  * `nil_gateway/` fallback routing integration
* **DoD:**

  * Gateway can retrieve via deputy when primary fails and settle premium correctly on chain.
  * Gateway can submit proof-of-failure when appropriate.
* **Test gate:**

  * Run the ghosting-provider E2E (next task).
* **Notes / gotchas:**

  * Protect against deputy spam: rate-limit and require deputy eligibility (min bond) if available.

#### TASK P0-DEPUTY-E2E-002 — Ghosting-provider E2E: proxy retrieval succeeds + evidence recorded

* **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
* **Owner:**
* **Area:** `scripts/`
* **Depends on:** `P0-DEPUTY-003`, `P0-DEPUTY-001`, `P0-DEPUTY-002`
* **Context:**

  * `MAINNET_ECON_PARITY_CHECKLIST.md` Stage 7 requires “ghosting-provider deputy e2e”.
* **Work plan:**

  1. Add a CI-style script (mirroring `scripts/ci_e2e_gateway_retrieval_multi_sp.sh`) that:

     * starts multi-SP stack
     * creates a deal + uploads content
     * forces the primary provider to ghost
     * performs retrieval and validates it succeeds via deputy
     * asserts proxy premium paid to deputy
  2. (Optional extension) Trigger multiple proof-of-failure submissions and verify:

     * bond locked
     * conviction triggers at threshold
     * bond refund/burn works on conviction/expiry
  3. Ensure stable polling, explicit timeouts, and clear logs.
* **Artifacts:**

  * new `scripts/ci_e2e_deputy_ghosting.sh` (or similar, if you add it)
* **DoD:**

  * Script deterministically validates deputy fallback retrieval and on-chain settlement.
  * Script exits non-zero on failure.
* **Test gate:**

  * run the new CI-style ghosting script locally
* **Notes / gotchas:**

  * Keep the test deterministic by selecting a specific provider index to kill/ghost.

---

## 4) Global Test Gates

These are the canonical “stop-the-line” gates used to claim parity. Tasks should reference one or more of these.

* **Stage 0 (params/interfaces):**

  * `go test ./nilchain/...`
  * (Optional) `./scripts/run_devnet_alpha_multi_sp.sh start` (boot smoke)
* **Stage 1–2 (econ + retrieval session lifecycle):**

  * `./scripts/e2e_lifecycle.sh`
  * `go test ./nilchain/...`
* **Stage 3 (challenges/quotas):**

  * `go test ./nilchain/...`
  * Challenge sim gate from `TASK P0-QUOTAS-SIM-003`
* **Stage 5 (repair + no outage):**

  * `./scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
  * Repair E2E from `TASK P0-REPAIR-E2E-002`
* **Stage 6 (evidence):**

  * `go test ./nilchain/...`
  * Evidence E2E from `TASK P0-EVIDENCE-E2E-002`
* **Stage 7 (deputy + audit debt):**

  * Ghosting-provider E2E from `TASK P0-DEPUTY-E2E-002`

---

## 5) Open Decisions

(Empty — add here only if a decision is truly unresolved and blocks implementation.)

