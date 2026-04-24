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
| `elasticity-overlay-controls` | 6 | 1 | Sensitivity sweep for user-funded elasticity overlay readiness, TTL, spend cap, and per-deal route caps. | [summary](elasticity-overlay-controls/sweep_summary.md) |
| `evidence-spam-economics` | 8 | 0 | Sensitivity sweep for deputy evidence-spam bond, bounty, conviction, and claim-volume economics. | [summary](evidence-spam-economics/sweep_summary.md) |
| `high-bandwidth-thresholds` | 9 | 5 | Sensitivity sweep for high-bandwidth capacity and demotion-saturation thresholds under hot retrieval pressure. | [summary](high-bandwidth-thresholds/sweep_summary.md) |
| `operator-concentration-controls` | 7 | 0 | Sensitivity sweep for per-deal operator assignment caps under dominant-operator Sybil pressure. | [summary](operator-concentration-controls/sweep_summary.md) |
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
| `sponsored-retrieval-funding` | 3 | 2 | Sensitivity sweep for public retrieval demand funded by sponsor sessions versus owner deal escrow. | [summary](sponsored-retrieval-funding/sweep_summary.md) |
| `staged-upload-controls` | 7 | 0 | Sensitivity sweep for staged upload retention, pending-generation caps, and partial commit pressure under abandoned provisional uploads. | [summary](staged-upload-controls/sweep_summary.md) |
| `storage-demand-elasticity-controls` | 9 | 0 | Sensitivity sweep for storage-price demand elasticity, price-step speed, reference price, and disabled-controller recovery. | [summary](storage-demand-elasticity-controls/sweep_summary.md) |
| `storage-escrow-close-refund` | 5 | 0 | Sensitivity sweep for storage lock-in, earned storage fees, early close refunds, and end-of-run outstanding escrow. | [summary](storage-escrow-close-refund/sweep_summary.md) |
| `storage-escrow-expiry-controls` | 6 | 0 | Sensitivity sweep for committed-storage expiry timing, run length, disabled-expiry behavior, and larger escrow books. | [summary](storage-escrow-expiry-controls/sweep_summary.md) |
| `storage-escrow-noncompliance-modes` | 3 | 0 | Sensitivity sweep for storage-fee payout and burn behavior across measure-only, repair-only, and reward-exclusion enforcement modes. | [summary](storage-escrow-noncompliance-modes/sweep_summary.md) |
| `wash-retrieval-economics` | 8 | 0 | Sensitivity sweep for requester-paid retrieval funding, burn rates, and wash-traffic profitability. | [summary](wash-retrieval-economics/sweep_summary.md) |

## Review Rule

Sweeps are parameter-review artifacts. Assertion failures are allowed when a sweep intentionally explores unsafe thresholds, but any failed run must be treated as non-graduating until a human accepts the risk or changes the parameter range.
