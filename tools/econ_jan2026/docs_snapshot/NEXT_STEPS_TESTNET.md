# NilStore testnet launch next steps (engineering + policy)

Last updated: 2026-01-22

This is a practical checklist that turns the current drafts into code + test gates.

## A. Policy decisions to finalize (minimum set)

1) **Base reward pool (protocol issuance)**
   - Adopt `rfcs/rfc-base-reward-pool-and-emissions.md` (draft) with an initial parameter set:
     - start bps / tail bps / halving interval / start height
   - Decide remainder handling: burn vs community pool.

2) **Provider exit / draining**
   - Adopt `rfcs/rfc-provider-exit-and-draining.md` (draft) at least for “no new assignments while draining”.
   - Set churn caps:
     - max drain bytes per epoch
     - max repairing bytes ratio

3) **Quota enforcement posture**
   - Confirm devnet/testnet values for:
     - quota_bps_hot/cold
     - quota_min_blobs / quota_max_blobs
     - credit_cap_bps
   - Confirm eviction thresholds (hot/cold) and non-response conviction ladder.

4) **Escrow end-of-life semantics**
   - The frozen RFC defines how escrow is charged at ingest and settled for retrieval.
   - A mainnet decision is still needed for **what happens to remaining escrow at deal expiry** (refund vs burn vs other).
     This materially affects long-term token sinks and emission farming risk.

## B. Code implementation items (polystorechain module)

### B1) Emissions engine (base reward pool)

- Add params (proto + keeper):
  - `base_reward_bps_start`
  - `base_reward_bps_tail`
  - `base_reward_halving_interval_blocks`
  - `emission_start_height`
- Add state:
  - `TotalActiveSlotBytes` accumulator (updated whenever:
    - a deal is committed/expanded,
    - a slot changes ACTIVE ↔ REPAIRING,
    - a deal expires/cancels)
- Add epoch hook:
  - compute `epoch_slot_rent = storage_price * TotalActiveSlotBytes * epoch_len_blocks`
  - mint `base_reward_pool = ceil(bps/10_000 * epoch_slot_rent)`
  - compute per-slot compliance weights
  - distribute payouts, burn remainder

Test gates:
  - determinism across nodes
  - exact rounding parity in Go tests
  - property tests: mint ≥ payouts; remainder burned

### B2) Draining & controlled exit

- Add provider field: `draining bool`
- Implement:
  - `MsgSetProviderDraining(draining=true)`
  - placement filter: draining providers are ineligible for new slots
- Implement deterministic drain scheduler (epoch hook):
  - mark selected slots REPAIRING (bounded by churn caps)
  - attach pending_provider candidate per existing repair policy

Test gates:
  - draining provider stops receiving assignments immediately
  - drain scheduler respects caps
  - provider is not slashed as long as it stays compliant until replaced

### B3) Reward exclusion correctness

- Ensure:
  - REPAIRING slots do not receive synthetic challenges
  - REPAIRING slots do not receive base rewards
  - jailed providers do not receive base rewards

## C. Integration / end-to-end test plan

1) Bring up a local multi-node testnet.
2) Create deals (hot and cold), commit data, verify:
   - escrow lock-in charges at ingest
   - synthetic challenges appear
   - proofs satisfy quota and produce rewards
3) Trigger non-response and ensure:
   - conviction threshold logic behaves
   - repair triggers and replacement completes
4) Mark a provider draining and ensure:
   - it stops getting new assignments
   - it is rotated out without punitive slashing (unless it stops serving early)
5) Run a stress test:
   - high churn + high retrieval load + quota compliance

## D. Documentation updates in repo

- Promote the following drafts into the repository:
  - `docs/ECONOMY_UPDATED.md` → `docs/ECONOMY.md` (after review)
  - `docs/spec_UPDATED.md` → `docs/spec.md` (after review)
  - `docs/rfcs/rfc-base-reward-pool-and-emissions.md`
  - `docs/rfcs/rfc-provider-exit-and-draining.md`

