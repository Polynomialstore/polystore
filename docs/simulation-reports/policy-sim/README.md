# Policy Simulation Report Corpus

This directory contains the committed human-readable report set generated from `tools/policy_sim/scenarios`.

The complete CSV ledgers are intentionally omitted from git because scale runs can produce large per-slot/per-epoch output. Regenerate them locally or use CI artifacts when a full ledger review is needed.

Regenerate this corpus with:

```bash
python3 tools/policy_sim/generate_report_corpus.py \
  --scenario-dir tools/policy_sim/scenarios \
  --out-dir docs/simulation-reports/policy-sim \
  --work-dir /tmp/polystore-policy-runs
```

## Scenario Index

The corpus-level [graduation map](graduation_map.md) translates these simulator results into the next keeper, gateway/provider, or policy-calibration artifacts.

The [sweep reports](sweeps/README.md) compare parameter ranges for scale, routing, reliability, and pricing decisions. Regenerate them with `tools/policy_sim/run_sweeps.py` after regenerating this scenario corpus.

| Scenario | Verdict | Success | Unavailable Reads | Data Loss Events | Repairs | Backoffs | Saturated | Negative P&L | Report |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `audit-budget-exhaustion` | `PASS` | 1.0000 | 0 | 0 | 32/32 | 0 | 0 | 4 | [report](audit-budget-exhaustion/report.md) |
| `coordinated-regional-outage` | `PASS` | 1.0000 | 0 | 0 | 96/96 | 1144 | 0 | 0 | [report](coordinated-regional-outage/report.md) |
| `corrupt-provider` | `PASS` | 1.0000 | 0 | 0 | 6/6 | 0 | 0 | 1 | [report](corrupt-provider/report.md) |
| `elasticity-cap-hit` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 0 | [report](elasticity-cap-hit/report.md) |
| `flapping-provider` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 0 | [report](flapping-provider/report.md) |
| `ideal` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 0 | [report](ideal/report.md) |
| `large-scale-regional-stress` | `PASS` | 0.9926 | 1065 | 0 | 3624/3050 | 21150 | 15482 | 4 | [report](large-scale-regional-stress/report.md) |
| `lazy-provider` | `PASS` | 1.0000 | 0 | 0 | 6/6 | 0 | 0 | 1 | [report](lazy-provider/report.md) |
| `price-controller-bounds` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 0 | [report](price-controller-bounds/report.md) |
| `repair-candidate-exhaustion` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 72 | 0 | 0 | [report](repair-candidate-exhaustion/report.md) |
| `setup-failure` | `PASS` | 1.0000 | 0 | 0 | 6/6 | 0 | 0 | 1 | [report](setup-failure/report.md) |
| `single-outage` | `PASS` | 1.0000 | 0 | 0 | 6/6 | 0 | 0 | 1 | [report](single-outage/report.md) |
| `subsidy-farming` | `PASS` | 1.0000 | 0 | 0 | 48/48 | 0 | 0 | 6 | [report](subsidy-farming/report.md) |
| `sustained-non-response` | `PASS` | 1.0000 | 0 | 0 | 6/6 | 0 | 0 | 1 | [report](sustained-non-response/report.md) |
| `underpriced-storage` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 48 | [report](underpriced-storage/report.md) |
| `viral-public-retrieval` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 0 | [report](viral-public-retrieval/report.md) |
| `wash-retrieval` | `PASS` | 1.0000 | 0 | 0 | 0/0 | 0 | 0 | 0 | [report](wash-retrieval/report.md) |
| `withholding` | `PASS` | 1.0000 | 0 | 0 | 6/6 | 0 | 0 | 1 | [report](withholding/report.md) |

## Review Rule

Unavailable reads are a bounded availability signal for explicitly marked stress scenarios. Modeled data-loss events are a durability failure and should remain zero for the current simulator milestone.
