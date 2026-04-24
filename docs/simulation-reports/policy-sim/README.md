# Policy Simulation Report Corpus

This directory contains the committed human-readable report set generated from `tools/policy_sim/scenarios`.

The complete CSV ledgers are intentionally omitted from git because scale runs can produce large per-slot/per-epoch output. Regenerate them locally or use CI artifacts when a full ledger review is needed.

Regenerate this corpus with:

```bash
python3 tools/policy_sim/generate_report_corpus.py \
  --scenario-dir tools/policy_sim/scenarios \
  --out-dir docs/simulation-reports/policy-sim \
  --work-dir /tmp/polystore-policy-runs \
  --jobs 0
```

## Scenario Index

The corpus-level [graduation map](graduation_map.md) translates these simulator results into the next keeper, gateway/provider, or policy-calibration artifacts.

The [sweep reports](sweeps/README.md) compare parameter ranges for scale, routing, reliability, and pricing decisions. Regenerate them with `tools/policy_sim/run_sweeps.py` after regenerating this scenario corpus.

`Repairs` is reported as `started/ready/completed`; `ready` is pending-provider catch-up evidence before promotion. `Backoffs` includes no-candidate, coordination-limit, cooldown, and attempt-cap throttling events. `High-BW` is reported as `promotions/final providers`. `Perf` is reported as Platinum/Gold/Silver/Fail serves. `OpCap` is `top operator assignment share / max same-operator slots per deal / cap violations`.

| Scenario | Verdict | Success | Unavailable Reads | Data Loss Events | Repairs | Health | Attempts | Backoffs | High-BW | Perf | OpCap | Saturated | Negative P&L | Report |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `audit-budget-exhaustion` | `PASS` | 1.0000 | 0 | 0 | 32/32/32 | 32/64 | 32 | 0 | 0/0 | 0/0/0/0 | 231/1/0 | 0 | 4 | [report](audit-budget-exhaustion/report.md) |
| `coordinated-regional-outage` | `PASS` | 1.0000 | 0 | 0 | 96/96/96 | 22/925 | 794 | 698 | 0/0 | 0/0/0/0 | 114/1/0 | 0 | 0 | [report](coordinated-regional-outage/report.md) |
| `corrupt-provider` | `PASS` | 1.0000 | 0 | 0 | 6/6/6 | 0/6 | 6 | 0 | 0/0 | 0/0/0/0 | 243/1/0 | 0 | 1 | [report](corrupt-provider/report.md) |
| `elasticity-cap-hit` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 208/1/0 | 0 | 0 | [report](elasticity-cap-hit/report.md) |
| `flapping-provider` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 24/0 | 0 | 0 | 0/0 | 0/0/0/0 | 208/1/0 | 0 | 0 | [report](flapping-provider/report.md) |
| `high-bandwidth-promotion` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 55/55 | 0/0/0/0 | 104/1/0 | 0 | 0 | [report](high-bandwidth-promotion/report.md) |
| `high-bandwidth-regression` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 32/30 | 0/0/0/0 | 138/1/0 | 21 | 0 | [report](high-bandwidth-regression/report.md) |
| `ideal` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 208/1/0 | 0 | 0 | [report](ideal/report.md) |
| `large-scale-regional-stress` | `PASS` | 0.9926 | 1065 | 0 | 3624/3050/3050 | 361/25634 | 16060 | 12436 | 0/0 | 0/0/0/0 | 13/1/0 | 15482 | 4 | [report](large-scale-regional-stress/report.md) |
| `lazy-provider` | `PASS` | 1.0000 | 0 | 0 | 6/6/6 | 6/12 | 6 | 0 | 0/0 | 0/0/0/0 | 243/1/0 | 0 | 1 | [report](lazy-provider/report.md) |
| `operator-concentration-cap` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 1208/2/0 | 0 | 0 | [report](operator-concentration-cap/report.md) |
| `performance-market-latency` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 64/64 | 10077/14584/17480/7779 | 104/1/0 | 0 | 0 | [report](performance-market-latency/report.md) |
| `price-controller-bounds` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 104/1/0 | 0 | 0 | [report](price-controller-bounds/report.md) |
| `repair-candidate-exhaustion` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/40 | 8 | 40 | 0/0 | 0/0/0/0 | 833/1/0 | 0 | 0 | [report](repair-candidate-exhaustion/report.md) |
| `setup-failure` | `PASS` | 1.0000 | 0 | 0 | 6/6/6 | 0/12 | 6 | 0 | 0/0 | 0/0/0/0 | 243/1/0 | 0 | 1 | [report](setup-failure/report.md) |
| `single-outage` | `PASS` | 1.0000 | 0 | 0 | 6/6/6 | 1/12 | 6 | 0 | 0/0 | 0/0/0/0 | 243/1/0 | 0 | 1 | [report](single-outage/report.md) |
| `subsidy-farming` | `PASS` | 1.0000 | 0 | 0 | 48/48/48 | 48/96 | 48 | 0 | 0/0 | 0/0/0/0 | 208/1/0 | 0 | 6 | [report](subsidy-farming/report.md) |
| `sustained-non-response` | `PASS` | 1.0000 | 0 | 0 | 6/6/6 | 0/12 | 6 | 0 | 0/0 | 0/0/0/0 | 243/1/0 | 0 | 1 | [report](sustained-non-response/report.md) |
| `underpriced-storage` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 208/1/0 | 0 | 48 | [report](underpriced-storage/report.md) |
| `viral-public-retrieval` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 104/1/0 | 0 | 0 | [report](viral-public-retrieval/report.md) |
| `wash-retrieval` | `PASS` | 1.0000 | 0 | 0 | 0/0/0 | 0/0 | 0 | 0 | 0/0 | 0/0/0/0 | 208/1/0 | 0 | 0 | [report](wash-retrieval/report.md) |
| `withholding` | `PASS` | 1.0000 | 0 | 0 | 6/6/6 | 0/12 | 6 | 0 | 0/0 | 0/0/0/0 | 243/1/0 | 0 | 1 | [report](withholding/report.md) |

## Review Rule

Unavailable reads are a bounded availability signal for explicitly marked stress scenarios. Modeled data-loss events are a durability failure and should remain zero for the current simulator milestone.
