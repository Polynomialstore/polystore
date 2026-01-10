# Mainnet Policy Resolution (Jan 2026, Proposal)

This document captures a **concrete, implementable proposal** for the remaining underspecified Mainnet economics + reliability policies, and a staged delivery plan to reach devnet/testnet launch readiness.

It is intended to turn the “B) underspecified items” in `MAINNET_ECON_PARITY_CHECKLIST.md` into **explicit parameters and keeper state transitions**.

## Scope

- **Economics:** escrow accounting, lock-in pricing, retrieval fee settlement, inflation/reward schedule hooks
- **Security/evidence:** slashing/jailing/ejection policy ladder, replay protections
- **Reliability:** deterministic repair/replacement selection, health tracking, deputy/proxy market incentives

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
  - Dev/test: 0.001 NIL
  - Mainnet: 0.01 NIL
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

Proposed defaults:
| Param | Default |
|---|---:|
| `evidence_bond` | 0.01 NIL |
| `failure_bounty` | 0.02 NIL |
| `proof_of_failure_ttl_epochs` | `nonresponse_window_epochs` |

**Audit debt funding options:**
- Option A (recommended): protocol-funded audit budget (minted per epoch) pays audit retrieval traffic.
- Option B: SP-funded audits, reimbursed via storage rewards (simpler, more liquidity pressure).

### B6) Organic retrieval credits (quota reduction) — accrual + caps + phase-in

Adopt credit accrual rules per `rfcs/rfc-challenge-derivation-and-quotas.md`.

**Proposed caps:**
- `credit_cap_bps_hot = 5000` (up to 50% quota via credits)
- `credit_cap_bps_cold = 2500` (up to 25% quota via credits)

**Phase-in plan:**
- Devnet: implement accounting, set credit caps to 0 (no quota reduction yet)
- Testnet: enable conservative caps (hot 25%, cold 10%)
- Mainnet: increase to target caps once determinism/evidence gates are green

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
- audit debt funding (B5): Option A vs Option B (inflation vs liquidity pressure)
- credit cap phase-in schedule (B6) vs measurable determinism confidence
