# Policy Simulator Implementation Tickets

Last updated: 2026-04-24

This document converts the committed policy-simulator evidence into the first
keeper, gateway, provider-daemon, and e2e implementation tickets.

It is intentionally ticket-shaped. The graduation map remains the evidence
source of truth:

- [Graduation map](../simulation-reports/policy-sim/graduation_map.md)
- [Sweep index](../simulation-reports/policy-sim/sweeps/README.md)
- [Policing roadmap](POLICING_AND_FAILURE_SIMULATION_ROADMAP.md)

## Ticket Contract

Every implementation PR derived from these tickets should include:

1. The simulator scenario or sweep that justifies the implementation work.
2. The policy mode: measure-only, repair-only, reward exclusion, jail
   simulated, slash simulated, or live punitive behavior.
3. The exact state transition or runtime behavior being added.
4. The keeper, gateway/provider, or e2e test that proves it.
5. The event or query surface an operator can use to explain the outcome.
6. A note if the PR is not enabling live enforcement.

Default posture: keeper/runtime tests may implement detection, repair, reward
exclusion, and accounting. They must not enable live punitive slashing unless a
later PR explicitly changes enforcement parameters after human review.

## Priority Order

| Priority | Theme | Why first |
|---|---|---|
| P0 | Healthy control, soft-fault health, repair lifecycle, and reward exclusion | These are the minimum safe building blocks for all later policing. |
| P1 | Setup failure, repair candidate exhaustion, hard evidence, and invalid proof paths | These cover critical degraded and malicious behavior without broad economic complexity. |
| P2 | Gateway/provider fault injection and small e2e confirmation | The real stack needs deterministic failure hooks before e2e can be reliable. |
| P3 | Storage/retrieval accounting and sponsored sessions | Economic enforcement should follow basic state-machine reliability. |
| P4 | High-bandwidth promotion, performance market, and elasticity overlays | These need telemetry and routing surfaces, so they should follow core health/accounting. |
| P5 | Evidence market, operator concentration, bonding, and punitive rollout | These require more governance, collateral, or identity decisions. |

## Current Implementation Status

This table tracks the implementation-ticket bridge at the time this document
was refreshed. It is intentionally conservative: a keeper test or one state
surface can advance a ticket without completing the full runtime/e2e goal.

| Ticket | Current status | Notes |
|---|---|---|
| T0. Keeper No-Op Control | Landed | Healthy-control, repair, and reward no-op invariants are covered by the keeper graduation stack. |
| T1. Slot Health and Soft-Fault Accumulator | Landed, first pass | Soft-fault counters and repair-trigger behavior are covered; richer query/UX state remains later observability work. |
| T2. Automatic Repair and Promotion Readiness | Landed, first pass | Repair readiness guards now prevent promotion without pending-provider proof activity; full data-plane catch-up proofs remain future runtime work. |
| T3. Reward Exclusion for Soft Non-Compliance | Landed, first pass | Keeper coverage distinguishes reward exclusion from slash/jail for soft non-compliance. |
| T4. Setup Failure Bump Before First Commit | Landed, first pass | Setup bump replacement, deterministic selection, and no-punitive-evidence behavior are covered at keeper level. |
| T5. Repair Candidate Exhaustion and Backoff | Landed, first pass | Keeper coverage now emits explicit repair-backoff evidence instead of silently over-assigning. |
| T6. Hard Evidence: Corrupt Data and Invalid Proofs | Landed, first pass | Invalid proof paths reject bad work, record hard evidence, and avoid rewarding invalid liveness proofs. |
| T7. Provider and Gateway Fault Injection Harness | Landed, first pass | Dev/test fault injection hooks exist; the next gap is selecting the smallest stable e2e that should be CI-grade. |
| T8. Storage Escrow Lifecycle Accounting | Partial, in PR stack | Owner-funded, sponsored, and protocol-funded expired retrieval session guards are covered; full keeper close/refund/expiry semantics still need human decisions on rounding, quote signing, and close authority. |
| T9. Retrieval Session Accounting and Sponsored Reads | Landed, first pass | Keeper tests cover owner-funded and requester/sponsor-funded settlement, burn, payout, and owner-escrow isolation. |
| T10. High-Bandwidth Promotion and Demotion | Partial, in PR stack | Current work uses existing `Edge` capability as the Hot-placement/high-bandwidth proxy; telemetry, explicit promotion/demotion, and operator UX remain open. |
| T11. Performance Market Latency Tiers | Partial | Latency tier boundaries are covered; telemetry accumulation and tiered payout integration remain broader performance-market work. |
| T12. Elasticity Overlay Spend Window | Partial, in PR stack | Spend-cap/escrow fail-closed behavior, funded overlay route state, and query visibility are covered; readiness, service accounting, TTL cleanup, and gateway routing remain open. |

## Ready Tickets

### T0. Keeper No-Op Control

Evidence:

- [ideal report](../simulation-reports/policy-sim/ideal/report.md)
- [ideal baseline sweep](../simulation-reports/policy-sim/sweeps/ideal-baseline-controls/sweep_summary.md)

Goal:

Healthy providers should not accrue suspect, delinquent, repair, reward
exclusion, jail, slash, or hard-fault state during normal epochs.

Implementation surfaces:

- `polystorechain/x/polystorechain/keeper`
- Epoch hooks that update provider or slot health state
- Queries for reward eligibility and health state

Test shape:

- Create a deal with healthy slots.
- Advance several epochs with successful quota/retrieval accounting.
- Assert no suspect/delinquent slots, no repairs, no invalid proofs, no reward
  burns, and full reward eligibility.

Definition of done:

- Keeper tests establish the healthy control invariant.
- Events or queries explain that no policy consequence was applied.
- No e2e requirement beyond existing happy-path smoke.

### T1. Slot Health and Soft-Fault Accumulator

Evidence:

- [single outage report](../simulation-reports/policy-sim/single-outage/report.md)
- [single outage repair sweep](../simulation-reports/policy-sim/sweeps/single-outage-repair-controls/sweep_summary.md)
- [sustained non-response report](../simulation-reports/policy-sim/sustained-non-response/report.md)
- [flapping provider report](../simulation-reports/policy-sim/flapping-provider/report.md)

Goal:

Repeated soft failures should move a slot through healthy, suspect, and
delinquent states without treating transient infra noise as hard evidence.

Implementation surfaces:

- Per-slot health state and missed-epoch counters
- Reason codes: `quota_miss_recorded`, `provider_degraded`,
  `provider_delinquent`
- Query path for slot health and current reason

Test shape:

- Intermittent miss below threshold records suspect evidence but no repair.
- Sustained miss crosses threshold and marks delinquent.
- Threshold-1 behavior is allowed but must not require a suspect pre-state.
- Measure-only mode records evidence without starting repair.

Definition of done:

- Keeper tests cover transient, sustained, aggressive-threshold, and
  measure-only behavior.
- The state machine is deterministic for fixed epoch inputs.
- No slash or jail can happen from soft evidence alone.

### T2. Automatic Repair and Promotion Readiness

Evidence:

- [single outage report](../simulation-reports/policy-sim/single-outage/report.md)
- [sustained non-response report](../simulation-reports/policy-sim/sustained-non-response/report.md)
- [replacement grinding report](../simulation-reports/policy-sim/replacement-grinding/report.md)

Goal:

A delinquent slot should enter repair, select a deterministic pending provider,
require readiness before promotion, and complete without breaking availability.

Implementation surfaces:

- Existing `ACTIVE` / `REPAIRING` slot lifecycle
- Pending provider and generation tracking
- Readiness proof marker
- Reason codes: `slot_repair_started`, `slot_repair_ready`,
  `slot_repair_completed`

Test shape:

- Force one assigned provider past missed-epoch threshold.
- Assert repair starts and pending provider is system-selected.
- Submit readiness for pending provider.
- Assert promotion completes and old provider is no longer responsible.
- Add a negative case where pending provider never proves readiness and times
  out or retries without promotion.

Definition of done:

- Keeper tests prove make-before-break repair semantics.
- Pending providers cannot be promoted without readiness.
- Repair attempt ledger includes candidate and failure reason.

### T3. Reward Exclusion for Soft Non-Compliance

Evidence:

- [lazy provider report](../simulation-reports/policy-sim/lazy-provider/report.md)
- [subsidy farming report](../simulation-reports/policy-sim/subsidy-farming/report.md)
- [storage escrow noncompliance report](../simulation-reports/policy-sim/storage-escrow-noncompliance-burn/report.md)

Goal:

Soft non-compliant responsibility should lose base reward and storage-fee
eligibility without creating punitive slashing behavior.

Implementation surfaces:

- Reward eligibility ledger
- Storage fee payout eligibility
- Burn ledger attribution
- Query path for reward exclusion reason

Test shape:

- Provider misses quota or synthetic fill.
- Assert reward is burned or withheld for that responsibility.
- Assert compliant providers remain paid.
- Assert no corrupt bytes are paid and no hard-fault consequence is emitted.

Definition of done:

- Keeper tests distinguish reward exclusion from slash/jail.
- Reports or queries expose who was excluded and why.
- Existing happy-path rewards remain unchanged.

### T4. Setup Failure Bump Before First Commit

Evidence:

- [setup failure report](../simulation-reports/policy-sim/setup-failure/report.md)
- [setup failure repair sweep](../simulation-reports/policy-sim/sweeps/setup-failure-repair-controls/sweep_summary.md)

Goal:

If initial placement upload fails before first content commit, the system should
replace that setup slot without classifying the original provider as malicious.

Implementation surfaces:

- Setup slot state
- Setup bump event
- Candidate exclusion reasons
- Gateway/provider upload error classification

Test shape:

- Create a deal container.
- Simulate one provider setup upload failure.
- Assert replacement is system-selected and commit can proceed.
- Assert no slash, jail, or hard-fault evidence is created.

Definition of done:

- Keeper or gateway tests cover setup bump semantics.
- Candidate selection does not allow user-chosen replacement grinding.
- Events distinguish setup failure from post-commit delinquency.

### T5. Repair Candidate Exhaustion and Backoff

Evidence:

- [repair candidate exhaustion report](../simulation-reports/policy-sim/repair-candidate-exhaustion/report.md)
- [coordinated regional outage sweep](../simulation-reports/policy-sim/sweeps/coordinated-regional-outage-controls/sweep_summary.md)

Goal:

When no eligible replacement exists or repair-start capacity is exhausted, the
system should emit explicit backoff state instead of over-assigning providers.

Implementation surfaces:

- Candidate exclusion diagnostics
- Repair attempt caps
- Repair backoff ledger
- Replacement capacity query

Test shape:

- Exhaust replacement capacity or candidate eligibility.
- Attempt repair.
- Assert repair is backlogged/backed off with reason.
- Assert no provider exceeds capacity and no unsafe promotion occurs.

Definition of done:

- Keeper tests cover no-candidate, saturated-candidate, and retry cases.
- Backoff state is queryable and explainable.
- Data-loss handling remains simulator-only until a real durability invariant is
  added to keeper tests.

### T6. Hard Evidence: Corrupt Data and Invalid Proofs

Evidence:

- [corrupt provider report](../simulation-reports/policy-sim/corrupt-provider/report.md)
- [invalid synthetic proof report](../simulation-reports/policy-sim/invalid-synthetic-proof/report.md)

Goal:

Cryptographic hard evidence should reject bad work, prevent bad payment, start
repair, and optionally record simulated jail/slash consequences behind disabled
defaults.

Implementation surfaces:

- Proof validation error attribution
- Hard evidence submission state
- Corrupt-byte reward exclusion
- Jail/slash parameters, default disabled

Test shape:

- Submit invalid liveness or synthetic proof.
- Simulate wrong data/proof-bound corrupt response where supported.
- Assert invalid work is unpaid and repair starts.
- Assert simulated slash/jail accounting only applies when explicitly enabled.

Definition of done:

- Keeper tests separate invalid proof from soft non-response.
- No corrupt bytes or invalid proofs are paid.
- Live punitive behavior remains off by default.

### T7. Provider and Gateway Fault Injection Harness

Evidence:

- Scenarios above require deterministic process-level failure hooks before e2e
  can be reliable.

Goal:

Add dev/test-only switches for provider-daemon and user-gateway failures so e2e
tests do not rely on timing flukes.

Implementation surfaces:

- Provider-daemon fault flags or test config
- Gateway failure classification hooks
- E2E orchestration scripts

Test shape:

- Provider offline or blackholed during retrieval.
- Provider withholds response.
- Provider returns corrupt bytes or invalid proof envelope.
- Provider setup upload fails.

Definition of done:

- Fault hooks are disabled by default.
- CI can trigger deterministic failure modes without sleeping on races.
- One small e2e test can kill or blackhole one provider and still fetch data.

### T8. Storage Escrow Lifecycle Accounting

Evidence:

- [storage close/refund report](../simulation-reports/policy-sim/storage-escrow-close-refund/report.md)
- [storage expiry report](../simulation-reports/policy-sim/storage-escrow-expiry/report.md)
- [storage noncompliance burn report](../simulation-reports/policy-sim/storage-escrow-noncompliance-burn/report.md)

Goal:

Committed storage should lock, earn, refund, expire, and burn non-compliant
payouts deterministically.

Implementation surfaces:

- Storage escrow state
- Earned-fee payout ledger
- Deal close and expiry messages
- Refund rounding
- Expired/closed retrieval guards

Test shape:

- Quote and lock storage escrow on content commit.
- Earn fees across epochs.
- Close early and refund unearned escrow.
- Expire fully earned deals and stop responsibility.
- Force delinquency and burn non-compliant earned fees.

Definition of done:

- Keeper tests prove lock/earn/refund/expiry/burn accounting.
- Gateway or query paths expose outstanding escrow and final close state.
- No hidden outstanding balance remains after close or expiry.

### T9. Retrieval Session Accounting and Sponsored Reads

Evidence:

- [viral public retrieval report](../simulation-reports/policy-sim/viral-public-retrieval/report.md)
- [wash retrieval report](../simulation-reports/policy-sim/wash-retrieval/report.md)
- [sponsored retrieval sweep](../simulation-reports/policy-sim/sweeps/sponsored-retrieval-funding/sweep_summary.md)

Goal:

Retrieval settlement should make requester/sponsor funding explicit, burn the
configured amount, pay serving providers, and avoid owner-escrow surprise
charges.

Implementation surfaces:

- Sponsored session funding
- Requester-paid session accounting
- Burn ledger
- Owner escrow isolation
- Credit cap enforcement

Test shape:

- Open sponsored retrieval session and complete reads.
- Assert sponsor pays base/variable spend and owner escrow is not debited.
- Exercise wash-like retrieval load and assert burn/spend exceeds farmable
  payout under target params.

Definition of done:

- Keeper tests cover sponsor-funded and owner-funded accounting paths.
- Gateway/session code exposes who pays for each read.
- Reports can reconcile provider payout, burn, and payer debit.

### T10. High-Bandwidth Promotion and Demotion

Evidence:

- [high-bandwidth promotion report](../simulation-reports/policy-sim/high-bandwidth-promotion/report.md)
- [high-bandwidth promotion sweep](../simulation-reports/policy-sim/sweeps/high-bandwidth-promotion-controls/sweep_summary.md)
- [high-bandwidth regression report](../simulation-reports/policy-sim/high-bandwidth-regression/report.md)
- [high-bandwidth threshold sweep](../simulation-reports/policy-sim/sweeps/high-bandwidth-thresholds/sweep_summary.md)

Goal:

Measured high-bandwidth providers should become eligible for hot routing, and
providers that regress into saturation should demote without losing durability.

Implementation surfaces:

- Provider capability tier state
- Bandwidth probe telemetry
- Hot-route preference query
- Saturation evidence accumulator
- Capability demotion rule

Test shape:

- Feed successful high-bandwidth telemetry and assert promotion.
- Route hot reads and assert preferred providers receive traffic.
- Feed saturation/regression telemetry and assert demotion.
- Assert capacity constraints and fallback routing remain intact.

Definition of done:

- Keeper/runtime tests prove promotion and demotion state transitions.
- Gateway routing can explain why a hot route chose a provider.
- No punitive fault is attached to QoS-only regression.

### T11. Performance Market Latency Tiers

Evidence:

- [performance market latency report](../simulation-reports/policy-sim/performance-market-latency/report.md)
- [performance market latency sweep](../simulation-reports/policy-sim/sweeps/performance-market-latency-controls/sweep_summary.md)

Goal:

Latency telemetry should map to Platinum/Gold/Silver/Fail reward tiers without
turning QoS misses into slashable evidence.

Implementation surfaces:

- Service-class parameters
- Latency telemetry accumulator
- Tiered reward multipliers
- QoS-only health notes

Test shape:

- Submit retrieval telemetry across tier thresholds.
- Assert deterministic tier classification and payout multipliers.
- Assert Fail-tier service affects QoS/reputation but not hard-fault state.

Definition of done:

- Keeper/runtime tests cover latency tier boundaries.
- Reports expose tier counts and payouts.
- Slashing remains impossible from latency alone.

### T12. Elasticity Overlay Spend Window

Evidence:

- [elasticity overlay report](../simulation-reports/policy-sim/elasticity-overlay-scaleup/report.md)
- [elasticity cap hit report](../simulation-reports/policy-sim/elasticity-cap-hit/report.md)
- [elasticity overlay sweep](../simulation-reports/policy-sim/sweeps/elasticity-overlay-controls/sweep_summary.md)
- [elasticity cap sweep](../simulation-reports/policy-sim/sweeps/elasticity-cap-hit-controls/sweep_summary.md)

Goal:

Hot demand should be able to buy bounded temporary overlay routes, while spend
caps fail closed and TTL cleanup removes temporary routes.

Implementation surfaces:

- `MsgSignalSaturation`
- Deal spend window accounting
- Overlay readiness proof
- Overlay TTL
- Overlay route telemetry

Test shape:

- Signal saturation with enough spend window and add overlay route.
- Require readiness before routing overlay traffic.
- Serve hot reads through ready overlay routes.
- Expire overlay routes by TTL.
- Reject expansion when spend cap is exhausted.

Definition of done:

- Keeper/gateway tests cover funded route creation, readiness, service, expiry,
  and cap-hit rejection.
- Overlay routing does not mutate base slot durability.
- User-facing reports show spend and route lifecycle.

## Tickets Requiring More Parameter Review

These are not blocked forever, but should not be the first implementation work:

| Theme | Evidence | Reason to wait |
|---|---|---|
| Dynamic storage/retrieval pricing defaults | `price-controller-bounds`, `storage-demand-elasticity`, `retrieval-demand-shock` | Needs governance bounds, smoothing, and affordability review. |
| Provider supply entry and economic churn | `provider-supply-entry`, `provider-economic-churn`, `provider-cost-shock` | Needs lifecycle and exit policy decisions before keeper state. |
| Provider bonding and underbonded repair urgency | `provider-bond-headroom` | Needs collateral formula and top-up UX decisions. |
| Evidence market and deputy bounties | `deputy-evidence-spam`, `withholding` | Needs evidence message design, conviction semantics, and deputy reputation. |
| Operator concentration and Sybil limits | `operator-concentration-cap`, `coordinated-regional-outage` | Needs operator identity and placement-diversity policy. |

## First PR Stack Recommendation

1. T0 keeper no-op control tests.
2. T1 slot health and soft-fault accumulator.
3. T2 automatic repair and promotion readiness.
4. T3 reward exclusion for soft non-compliance.
5. T4 setup failure bump before first commit.
6. T5 repair candidate exhaustion and backoff.
7. T6 hard evidence invalid-proof and corrupt-data paths.
8. T7 deterministic fault injection plus one small provider-outage e2e.

This ordering gives the team an implementation backbone before economic,
capability-tier, or punitive policy work expands the state surface.
