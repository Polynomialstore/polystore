# Policy Simulation Sweep Reports

This directory contains committed sweep summaries generated from versioned specs in `tools/policy_sim/sweeps`.

Raw per-case simulator ledgers are intentionally omitted from git. Regenerate them locally or use CI artifacts when detailed ledger inspection is needed.

Regenerate this corpus with:

```bash
python3 tools/policy_sim/run_sweeps.py \
  --sweep-dir tools/policy_sim/sweeps \
  --run-dir /tmp/polystore-policy-sweep-runs \
  --out-dir docs/simulation-reports/policy-sim/sweeps \
  --jobs 0
```

## Sweep Index

| Sweep | Cases | Assertion Failures | Description | Report |
|---|---:|---:|---|---|
| `audit-budget-controls` | 6 | 0 | Sensitivity sweep for protocol audit-budget funding versus miss-driven audit demand, backlog, and carryover. | [summary](audit-budget-controls/sweep_summary.md) |
| `closed-retrieval-rejection-controls` | 5 | 0 | Sensitivity sweep for post-close retrieval rejection timing, partial close behavior, refund accounting, and larger closed-content read demand. | [summary](closed-retrieval-rejection-controls/sweep_summary.md) |
| `coordinated-regional-outage-controls` | 6 | 0 | Direct sweep for correlated regional outage handling across repair throughput, route attempts, outage severity, and larger heterogeneous populations. | [summary](coordinated-regional-outage-controls/sweep_summary.md) |
| `corrupt-provider-enforcement-controls` | 7 | 0 | Sensitivity sweep for corrupt-retrieval hard faults across measure-only, repair, jail, slash, slash size, and larger corrupt-provider populations. | [summary](corrupt-provider-enforcement-controls/sweep_summary.md) |
| `elasticity-cap-hit-controls` | 6 | 0 | Sensitivity sweep for non-overlay elasticity spend-cap behavior across zero budget, small spend windows, expensive overflow, disabled demand triggers, and larger viral retrieval pressure. | [summary](elasticity-cap-hit-controls/sweep_summary.md) |
| `elasticity-overlay-controls` | 6 | 1 | Sensitivity sweep for user-funded elasticity overlay readiness, TTL, spend cap, and per-deal route caps. | [summary](elasticity-overlay-controls/sweep_summary.md) |
| `evidence-spam-economics` | 8 | 0 | Sensitivity sweep for deputy evidence-spam bond, bounty, conviction, and claim-volume economics. | [summary](evidence-spam-economics/sweep_summary.md) |
| `expired-retrieval-rejection-controls` | 5 | 0 | Sensitivity sweep for post-expiry retrieval rejection timing, no-bill accounting, and larger expired-content read demand. | [summary](expired-retrieval-rejection-controls/sweep_summary.md) |
| `flapping-provider-thresholds` | 5 | 0 | Sensitivity sweep for intermittent provider outage thresholds, repair-churn risk, and suspect evidence visibility. | [summary](flapping-provider-thresholds/sweep_summary.md) |
| `high-bandwidth-promotion-controls` | 6 | 0 | Direct sweep for hot-retrieval high-bandwidth promotion across capacity thresholds, traffic pressure, routing enablement, and saturation guardrails. | [summary](high-bandwidth-promotion-controls/sweep_summary.md) |
| `high-bandwidth-thresholds` | 9 | 5 | Sensitivity sweep for high-bandwidth capacity and demotion-saturation thresholds under hot retrieval pressure. | [summary](high-bandwidth-thresholds/sweep_summary.md) |
| `ideal-baseline-controls` | 5 | 0 | Direct cooperative-baseline sweep covering scale, heterogeneous capacity, high retrieval demand, and mild pricing-controller activation without failures. | [summary](ideal-baseline-controls/sweep_summary.md) |
| `invalid-synthetic-proof-enforcement-controls` | 7 | 0 | Sensitivity sweep for invalid synthetic/liveness proof hard faults without corrupt retrieval bytes across enforcement modes, slash size, and multi-provider proof abuse. | [summary](invalid-synthetic-proof-enforcement-controls/sweep_summary.md) |
| `lazy-provider-quota-controls` | 7 | 0 | Sensitivity sweep for lazy-provider quota misses across reward exclusion, repair-only reward leakage, measure-only observation, eviction thresholds, multi-provider laziness, and repair throughput limits. | [summary](lazy-provider-quota-controls/sweep_summary.md) |
| `operator-concentration-controls` | 7 | 0 | Sensitivity sweep for per-deal operator assignment caps under dominant-operator Sybil pressure. | [summary](operator-concentration-controls/sweep_summary.md) |
| `overpriced-storage-affordability` | 6 | 0 | Sensitivity sweep for overpriced storage demand rejection, willingness-to-pay ceilings, dynamic price movement, and capacity-limited acceptance. | [summary](overpriced-storage-affordability/sweep_summary.md) |
| `performance-market-latency-controls` | 9 | 0 | Sensitivity sweep for Hot-service latency tier windows, reward multipliers, jitter, routing, and slow-provider tails. | [summary](performance-market-latency-controls/sweep_summary.md) |
| `price-step-controller` | 4 | 0 | Controller sensitivity sweep for dynamic pricing max-step parameters in the pricing-bounds fixture. | [summary](price-step-controller/sweep_summary.md) |
| `provider-bond-headroom-controls` | 7 | 0 | Sensitivity sweep for provider minimum bond, per-slot collateral, initial bond, and hard-fault slash sizing. | [summary](provider-bond-headroom-controls/sweep_summary.md) |
| `provider-churn-caps` | 7 | 0 | Sensitivity sweep for provider economic churn caps versus repair throughput under the economic churn fixture. | [summary](provider-churn-caps/sweep_summary.md) |
| `provider-cost-shock-controls` | 8 | 0 | Sensitivity sweep for provider cost-shock severity, reward buffer, and dynamic-pricing response. | [summary](provider-cost-shock-controls/sweep_summary.md) |
| `provider-reliability-large-scale` | 3 | 0 | Population-scale sensitivity sweep for heterogeneous provider online-probability floors. | [summary](provider-reliability-large-scale/sweep_summary.md) |
| `provider-supply-entry-controls` | 8 | 0 | Sensitivity sweep for reserve-provider entry caps, probation length, trigger timing, and underfilled reserve recovery. | [summary](provider-supply-entry-controls/sweep_summary.md) |
| `repair-candidate-exhaustion-controls` | 7 | 0 | Sensitivity sweep for replacement capacity, retry caps, and cooldowns when repair candidates are exhausted or saturated. | [summary](repair-candidate-exhaustion-controls/sweep_summary.md) |
| `repair-throughput-large-scale` | 3 | 0 | Population-scale sensitivity sweep for repair-start throughput under the large regional stress fixture. | [summary](repair-throughput-large-scale/sweep_summary.md) |
| `replacement-grinding-controls` | 7 | 0 | Sensitivity sweep for pending-repair timeout, cooldown, and per-slot attempt-cap controls under replacement grinding. | [summary](replacement-grinding-controls/sweep_summary.md) |
| `retrieval-demand-shock-controls` | 9 | 0 | Sensitivity sweep for retrieval-demand shock multipliers, pricing target, step size, and disabled controller behavior. | [summary](retrieval-demand-shock-controls/sweep_summary.md) |
| `route-attempt-large-scale` | 3 | 1 | Population-scale sensitivity sweep for retrieval route-attempt limits during correlated regional stress. | [summary](route-attempt-large-scale/sweep_summary.md) |
| `setup-failure-repair-controls` | 7 | 0 | Sensitivity sweep for setup-phase provider failures across observation mode, repair-only mode, threshold timing, multi-provider setup failure, and repair-start throttles. | [summary](setup-failure-repair-controls/sweep_summary.md) |
| `single-outage-repair-controls` | 7 | 0 | Direct sweep for one-provider outage repair behavior across enforcement posture, threshold timing, multi-provider outages, and repair throughput limits. | [summary](single-outage-repair-controls/sweep_summary.md) |
| `sponsored-retrieval-funding` | 3 | 2 | Sensitivity sweep for public retrieval demand funded by sponsor sessions versus owner deal escrow. | [summary](sponsored-retrieval-funding/sweep_summary.md) |
| `staged-upload-controls` | 7 | 0 | Sensitivity sweep for staged upload retention, pending-generation caps, and partial commit pressure under abandoned provisional uploads. | [summary](staged-upload-controls/sweep_summary.md) |
| `storage-demand-elasticity-controls` | 9 | 0 | Sensitivity sweep for storage-price demand elasticity, price-step speed, reference price, and disabled-controller recovery. | [summary](storage-demand-elasticity-controls/sweep_summary.md) |
| `storage-escrow-close-refund` | 5 | 0 | Sensitivity sweep for storage lock-in, earned storage fees, early close refunds, and end-of-run outstanding escrow. | [summary](storage-escrow-close-refund/sweep_summary.md) |
| `storage-escrow-expiry-controls` | 6 | 0 | Sensitivity sweep for committed-storage expiry timing, run length, disabled-expiry behavior, and larger escrow books. | [summary](storage-escrow-expiry-controls/sweep_summary.md) |
| `storage-escrow-noncompliance-modes` | 3 | 0 | Sensitivity sweep for storage-fee payout and burn behavior across measure-only, repair-only, and reward-exclusion enforcement modes. | [summary](storage-escrow-noncompliance-modes/sweep_summary.md) |
| `subsidy-farming-economics` | 7 | 0 | Sensitivity sweep for base reward leakage under lazy-provider subsidy farming, enforcement modes, lazy share, and subsidy size. | [summary](subsidy-farming-economics/sweep_summary.md) |
| `sustained-non-response-thresholds` | 5 | 0 | Sensitivity sweep for sustained provider non-response repair timing, delayed readiness, and repair timeout behavior. | [summary](sustained-non-response-thresholds/sweep_summary.md) |
| `underpriced-storage-economics` | 6 | 0 | Sensitivity sweep for provider P&L under storage underpricing, user-funded storage fees, reward-only buffers, and storage-price floors. | [summary](underpriced-storage-economics/sweep_summary.md) |
| `wash-retrieval-economics` | 8 | 0 | Sensitivity sweep for requester-paid retrieval funding, burn rates, and wash-traffic profitability. | [summary](wash-retrieval-economics/sweep_summary.md) |
| `withholding-enforcement-controls` | 7 | 0 | Sensitivity sweep for refusal-to-serve soft failures across measure-only, repair-only, reward exclusion, delayed thresholds, multi-provider withholding, and repair throughput limits. | [summary](withholding-enforcement-controls/sweep_summary.md) |

## Review Rule

Sweeps are parameter-review artifacts. Assertion failures are allowed when a sweep intentionally explores unsafe thresholds, but any failed run must be treated as non-graduating until a human accepts the risk or changes the parameter range.
