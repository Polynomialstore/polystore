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
  - `seed = SHA256("polystore/replace/v1" || R_e || deal_id || slot || current_gen || replace_nonce)`
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
