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
| `elasticity-overlay-controls` | 6 | 1 | Sensitivity sweep for user-funded elasticity overlay readiness, TTL, spend cap, and per-deal route caps. | [summary](elasticity-overlay-controls/sweep_summary.md) |
| `high-bandwidth-thresholds` | 9 | 5 | Sensitivity sweep for high-bandwidth capacity and demotion-saturation thresholds under hot retrieval pressure. | [summary](high-bandwidth-thresholds/sweep_summary.md) |
| `price-step-controller` | 4 | 0 | Controller sensitivity sweep for dynamic pricing max-step parameters in the pricing-bounds fixture. | [summary](price-step-controller/sweep_summary.md) |
| `provider-churn-caps` | 7 | 0 | Sensitivity sweep for provider economic churn caps versus repair throughput under the economic churn fixture. | [summary](provider-churn-caps/sweep_summary.md) |
| `provider-reliability-large-scale` | 3 | 0 | Population-scale sensitivity sweep for heterogeneous provider online-probability floors. | [summary](provider-reliability-large-scale/sweep_summary.md) |
| `repair-throughput-large-scale` | 3 | 0 | Population-scale sensitivity sweep for repair-start throughput under the large regional stress fixture. | [summary](repair-throughput-large-scale/sweep_summary.md) |
| `route-attempt-large-scale` | 3 | 1 | Population-scale sensitivity sweep for retrieval route-attempt limits during correlated regional stress. | [summary](route-attempt-large-scale/sweep_summary.md) |

## Review Rule

Sweeps are parameter-review artifacts. Assertion failures are allowed when a sweep intentionally explores unsafe thresholds, but any failed run must be treated as non-graduating until a human accepts the risk or changes the parameter range.
