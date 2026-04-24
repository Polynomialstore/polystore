# PolyStore Policy Simulation Harness

This harness is a deterministic, stdlib-only simulator for the next enforcement
milestone: outages, degraded providers, malicious provider behavior, and policy
assertions before full process-level devnet tests.

It is not a replacement for `scripts/e2e_*`. It is a fast policy lab that can
run tens or hundreds of logical providers and deals, produce JSON/CSV metrics,
and fail CI when a scenario violates an expected invariant.

## Run

```bash
python3 tools/policy_sim/policing_sim.py --scenario ideal --assert
python3 tools/policy_sim/policing_sim.py --scenario single-outage --providers 96 --deals 64 --epochs 16 --assert
python3 tools/policy_sim/policing_sim.py --scenario malicious-corrupt --json-out /tmp/polystore-policing.json --csv-out /tmp/polystore-policing.csv --assert
```

Run a versioned fixture and emit the full output contract:

```bash
python3 tools/policy_sim/policing_sim.py \
  --scenario-file tools/policy_sim/scenarios/single_outage.yaml \
  --out-dir /tmp/polystore-policy/single_outage
```

Fixture files use a YAML extension for the roadmap convention, but are written
as JSON-compatible YAML so the simulator remains stdlib-only.

Run the canonical fixture suite:

```bash
python3 tools/policy_sim/policing_sim.py \
  --scenario-dir tools/policy_sim/scenarios \
  --out-dir /tmp/polystore-policy/runs
```

Generate the committed human-readable report corpus:

```bash
python3 tools/policy_sim/generate_report_corpus.py \
  --scenario-dir tools/policy_sim/scenarios \
  --out-dir docs/simulation-reports/policy-sim \
  --work-dir /tmp/polystore-policy/runs
```

Generate human-readable reports from raw simulator outputs:

```bash
python3 tools/policy_sim/report.py \
  --run-dir /tmp/polystore-policy/runs/single-outage \
  --out-dir /tmp/polystore-policy/reports/single-outage
```

Generate a sensitivity sweep or regression-suite summary from many completed
runs:

```bash
python3 tools/policy_sim/report.py \
  --sweep-dir /tmp/polystore-policy/runs \
  --out-dir /tmp/polystore-policy/reports/sweep
```

Run the versioned sweep specs and generate committed sweep reports:

```bash
python3 tools/policy_sim/run_sweeps.py \
  --sweep-dir tools/policy_sim/sweeps \
  --run-dir /tmp/polystore-policy-sweep-runs \
  --out-dir docs/simulation-reports/policy-sim/sweeps
```

If `--out-dir` is omitted, `report.py` writes to a dedicated subdirectory
instead of polluting raw simulator outputs: `<run-dir>/report` for single-run
reports, `<candidate-dir>/delta` for baseline/candidate comparisons, and
`<sweep-dir>/sweep_report` for sweep/regression summaries.

Custom fault injections are repeatable:

```bash
python3 tools/policy_sim/policing_sim.py \
  --scenario ideal \
  --providers 120 \
  --deals 80 \
  --epochs 20 \
  --fault offline:sp-000:3-8 \
  --fault corrupt:sp-014:0.25 \
  --fault withhold:sp-020:0.50 \
  --min-success-rate 0.99 \
  --assert
```

Supported fault forms:

- `offline:sp-000:2-5`
- `corrupt:sp-001:0.25`
- `withhold:sp-002:1`
- `invalid-proof:sp-003:1`
- `lazy:sp-004`
- `draining:sp-005`

Supported simulated enforcement modes:

- `MEASURE_ONLY`
- `REPAIR_ONLY`
- `REWARD_EXCLUSION`
- `JAIL_SIMULATED`
- `SLASH_SIMULATED`

Population-scale fixtures can also model heterogeneous providers. These fields
are supported in scenario files:

- `provider_capacity_min` / `provider_capacity_max`
- `provider_bandwidth_capacity_min` / `provider_bandwidth_capacity_max`
- `provider_online_probability_min` / `provider_online_probability_max`
- `provider_repair_probability_min` / `provider_repair_probability_max`
- `provider_storage_cost_jitter_bps` / `provider_bandwidth_cost_jitter_bps`
- `provider_regions`
- `regional_outages`
- `max_repairs_started_per_epoch`
- `repair_attempt_cap_per_slot`
- `repair_backoff_epochs`
- `high_bandwidth_promotion_enabled`
- `high_bandwidth_capacity_threshold`
- `high_bandwidth_min_retrievals`
- `high_bandwidth_min_success_rate_bps`
- `high_bandwidth_max_saturation_bps`
- `high_bandwidth_demotion_saturation_bps`
- `high_bandwidth_routing_enabled`
- `hot_retrieval_bps`

Versioned sweep specs live in `tools/policy_sim/sweeps`. They are strict JSON
documents with a `.yaml` extension, matching scenario fixture conventions. A
sweep chooses a base scenario and a matrix of config overrides; raw per-case
ledgers are generated locally while committed reports contain only
`sweep_summary.md`, `sweep_summary.json`, and `manifest.json`. Current sweeps
cover repair throughput, route attempts, provider reliability, price-controller
steps, and high-bandwidth capability thresholds.

## Model Scope

The simulator mirrors current protocol concepts:

- Mode 2 RS(`K`, `K+M`) slot assignment.
- Epoch liveness quotas with organic credit caps and synthetic fill.
- Retrieval routing around failed slots when at least `K` slots can serve.
- Corrupt retrievals and invalid synthetic proofs as hard faults.
- Provider outage/withholding as soft faults that become quota/deputy misses.
- Make-before-break repair with deterministic replacement provider selection.
- Repair attempt caps and cooldown windows for constrained replacement markets.
- Per-slot `HEALTHY` / `SUSPECT` / `DELINQUENT` health state with reason codes.
- Provider capability promotion to `HIGH_BANDWIDTH` based on measured capacity,
  retrieval success, saturation, and hard-fault history.
- Capability demotion from `HIGH_BANDWIDTH` when hot routing exposes sustained
  saturation regression.
- Hot retrieval routing that can prefer promoted high-bandwidth providers
  without bypassing capacity and availability assertions.
- Simulated enforcement modes before live chain/runtime rollout.
- Large-scale heterogeneous-provider runs with regional outages, bandwidth
  saturation, and repair coordination limits.
- Explicit distinction between temporary unavailable reads and modeled
  data-loss events. Stress scenarios may allow bounded unavailable reads, but
  current durability assertions expect data-loss events to remain zero.
- Basic economic accounting for retrieval fees, rewards, audit budget, provider
  P&L, slashing, and elasticity spend caps.

The simulator deliberately does not run `polystorechaind`, gateways, or provider
processes. Once a policy is stable here, add keeper tests or e2e scripts for the
corresponding implementation path.

## Output Contract

When `--out-dir` is supplied, the simulator emits:

- `summary.json`
- `assertions.json`
- `epochs.csv`
- `providers.csv`
- `slots.csv`
- `evidence.csv`
- `repairs.csv`
- `economy.csv`

`slots.csv` includes per-slot health reason, repair attempt, and cooldown state.
`repairs.csv` includes start, pending-provider readiness, completion,
attempt-count, cooldown, candidate-exclusion, attempt-cap, and backoff events.

`report.py` consumes those raw files and can emit:

- `report.md`
- `risk_register.md`
- `graduation.md`
- `policy_delta.md` for baseline/candidate comparisons
- `sweep_summary.md` and `sweep_summary.json` for parameter sweeps or fixture
  regression summaries
- `signals.json`
- `graphs/*.svg`

`generate_report_corpus.py` runs the fixture suite and writes a committed report
set under `docs/simulation-reports/policy-sim`. The corpus includes Markdown,
graphs, `signals.json`, `summary.json`, and `assertions.json`; full CSV ledgers
are generated as local/CI artifacts instead of being committed.

The corpus also includes `graduation_map.md` and `graduation_map.json`, which
aggregate all scenario outcomes into keeper, gateway/provider, process-level
e2e, and further-simulation targets.

`run_sweeps.py` writes committed sweep summaries under
`docs/simulation-reports/policy-sim/sweeps`, while omitting raw sweep ledgers
for the same reason.

The Markdown reports are intended to be human review artifacts, not just metric
dumps. A run report explains scenario intent, expected behavior, what happened
over the timeline, enforcement interpretation, economic interpretation, the
assertion contract, evidence excerpts, generated graphs, and remaining review
questions. The generated SVG graphs are embedded inline in `report.md` with
relative Markdown image links. Graphs include retrieval success, slot state,
provider P&L, burn/mint ratio, price trajectory, capacity utilization,
saturation/repair pressure, repair backlog, high-bandwidth promotion, and hot
retrieval routing. `signals.json` records derived availability, saturation,
repair, capacity, economic, regional, high-bandwidth, and provider bottleneck
signals for downstream analysis.

The economics in these reports are unitless simulator accounting. They are
intended to make assumptions explicit: storage price, retrieval price, base
reward, burns, audit budget, provider cost, and dynamic-pricing step behavior.
They are not final token economics.

The simulator should remain deterministic and machine-output focused. Reporting
and graph generation belong in `report.py`.

## Tests

```bash
python3 -m unittest discover -s tools/policy_sim
```
