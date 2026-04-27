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
  --out-dir /tmp/polystore-policy/runs \
  --jobs 0
```

Generate the committed human-readable report corpus:

```bash
python3 tools/policy_sim/generate_report_corpus.py \
  --scenario-dir tools/policy_sim/scenarios \
  --out-dir docs/simulation-reports/policy-sim \
  --work-dir /tmp/polystore-policy/runs \
  --jobs 0
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
  --out-dir docs/simulation-reports/policy-sim/sweeps \
  --jobs 0
```

`--jobs 0` auto-detects CPU count and caps parallel workers at 8. Directory
fixture runs default to this auto-parallel mode, and directory sweeps share one
bounded worker pool across all selected sweep cases, so small sweep specs still
utilize available cores. Use `--jobs 1` for single-process debugging or exact
profiler traces.

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

## Devnet Provider-Bond Calibration

The chain exposes `types.DevnetPolicingParams()` as the current simulator-backed
devnet policing profile. It is calibrated from
`tools/policy_sim/scenarios/provider_bond_headroom.yaml`:

| Simulator value | Chain/devnet value | Meaning |
| --- | --- | --- |
| `provider_initial_bond = 2.0` | `200stake` registration self-bond | Recommended local/testnet provider bond headroom. |
| `provider_min_bond = 1.5` | `min_provider_bond = 150stake` | Minimum bond before placement/reward eligibility. |
| `provider_bond_per_slot = 0.05` | `assignment_collateral_per_slot = 5stake` | Extra bond reserved per active/pending assignment. |
| `slash_hard_fault_bps = 5000` against remaining provider bond | `hard_fault_bond_slash_bps = 5000` | 50% slashable-bond burn for hard faults. |
| `jail_epochs = 3` and `epoch_len_blocks = 100` | `provider_bond_unbonding_blocks = 300` | Withdrawal queue spans the hard-fault jail window. |
| `provider_bond_opportunity_cost_bps_per_epoch` | simulator-only carry cost | Models locked-collateral opportunity cost in provider P&L and churn pressure before translating to chain params. |

`scripts/run_devnet_alpha_multi_sp.sh` applies this profile by default for
multi-provider devnets and registers local providers with `200stake` self-bond.
Set `POLYSTORE_DEVNET_POLICING_DEFAULTS=0` to keep compatibility-zero bond
params, or override individual chain params with
`POLYSTORE_MIN_PROVIDER_BOND`, `POLYSTORE_ASSIGNMENT_COLLATERAL_PER_SLOT`,
`POLYSTORE_HARD_FAULT_BOND_SLASH_BPS`, and
`POLYSTORE_PROVIDER_BOND_UNBONDING_BLOCKS`.

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
- `provider_bond_opportunity_cost_bps_per_epoch`
- `slash_hard_fault_bps`
- `slash_corrupt_retrieval_bps` / `slash_invalid_synthetic_proof_bps`
- `provider_cost_shocks`
- `provider_regions`
- `regional_outages`
- `elasticity_overlay_enabled`
- `elasticity_overlay_providers_per_epoch`
- `elasticity_overlay_max_providers_per_deal`
- `elasticity_overlay_ready_delay_epochs`
- `elasticity_overlay_ttl_epochs`
- `staged_upload_attempts_per_epoch`
- `staged_upload_mdu_per_attempt`
- `staged_upload_commit_rate_bps`
- `staged_upload_retention_epochs`
- `staged_upload_max_pending_generations`
- `max_repairs_started_per_epoch`
- `repair_attempt_cap_per_slot`
- `repair_backoff_epochs`
- `repair_pending_timeout_epochs`
- `high_bandwidth_promotion_enabled`
- `high_bandwidth_capacity_threshold`
- `high_bandwidth_min_retrievals`
- `high_bandwidth_min_success_rate_bps`
- `high_bandwidth_max_saturation_bps`
- `high_bandwidth_demotion_saturation_bps`
- `high_bandwidth_routing_enabled`
- `hot_retrieval_bps`
- `service_class`
- `performance_market_enabled`
- `provider_latency_ms_min` / `provider_latency_ms_max`
- `provider_latency_jitter_bps`
- `platinum_latency_ms` / `gold_latency_ms` / `silver_latency_ms`
- `performance_reward_per_serve`
- `platinum_reward_multiplier_bps` / `gold_reward_multiplier_bps` /
  `silver_reward_multiplier_bps` / `fail_reward_multiplier_bps`
- `operator_count`
- `dominant_operator_provider_bps`
- `operator_assignment_cap_per_deal`
- `retrieval_demand_shocks`
- `sponsored_retrieval_bps`
- `owner_retrieval_debit_bps`
- `storage_lockin_enabled`
- `deal_expiry_enabled`
- `deal_duration_epochs`
- `deal_close_epoch`
- `deal_close_count`
- `deal_close_bps`
- `new_deal_requests_per_epoch`
- `storage_demand_price_ceiling`
- `storage_demand_reference_price`
- `storage_demand_elasticity_bps`
- `storage_demand_min_bps` / `storage_demand_max_bps`

Versioned sweep specs live in `tools/policy_sim/sweeps`. They are strict JSON
documents with a `.yaml` extension, matching scenario fixture conventions. A
sweep chooses a base scenario and a matrix of config overrides; raw per-case
ledgers are generated locally while committed reports contain only
`sweep_summary.md`, `sweep_summary.json`, and `manifest.json`. Current sweeps
cover repair throughput, route attempts, provider reliability, price-controller
steps, high-bandwidth capability thresholds, elasticity overlay controls,
sponsored retrieval funding, storage escrow close/refund accounting, and
storage escrow noncompliance enforcement modes.

CI enforces direct sweep coverage for every scenario fixture:

```bash
python3 tools/policy_sim/check_sweep_coverage.py
```

This check ensures each `tools/policy_sim/scenarios/*.yaml` file has at least
one sweep whose `base_scenario` points directly at that fixture. Scenario
fixtures may still share broader population-scale sweeps, but a new fixture
should not land without its own reviewable parameter sweep.

## Model Scope

The simulator mirrors current protocol concepts:

- Mode 2 RS(`K`, `K+M`) slot assignment.
- Epoch liveness quotas with organic credit caps and synthetic fill.
- Retrieval routing around failed slots when at least `K` slots can serve.
- Corrupt retrievals and invalid synthetic proofs as hard faults.
- Provider outage/withholding as soft faults that become quota/deputy misses.
- Make-before-break repair with deterministic replacement provider selection.
- Repair attempt caps and cooldown windows for constrained replacement markets.
- Pending-provider readiness timeouts that cancel stalled repair attempts before
  bounded retry.
- Per-slot `HEALTHY` / `SUSPECT` / `DELINQUENT` health state with reason codes.
- Provider capability promotion to `HIGH_BANDWIDTH` based on measured capacity,
  retrieval success, saturation, and hard-fault history.
- Capability demotion from `HIGH_BANDWIDTH` when hot routing exposes sustained
  saturation regression.
- Hot retrieval routing that can prefer promoted high-bandwidth providers
  without bypassing capacity and availability assertions.
- Performance-market service tiers that classify modeled retrieval latency into
  Platinum/Gold/Silver/Fail and pay optional tiered QoS rewards.
- Epoch-scoped retrieval demand shocks that exercise pricing response and
  oscillation bounds.
- Operator identity concentration and per-deal assignment caps for Sybil-shaped
  provider populations.
- Simulated enforcement modes before live chain/runtime rollout.
- Large-scale heterogeneous-provider runs with regional outages, bandwidth
  saturation, and repair coordination limits.
- Explicit distinction between temporary unavailable reads and modeled
  data-loss events. Stress scenarios may allow bounded unavailable reads, but
  current durability assertions expect data-loss events to remain zero.
- Explicit post-expiry retrieval rejection accounting so expired content
  requests are not confused with live availability failures or billable
  retrieval sessions.
- Explicit post-close retrieval rejection accounting so intentionally closed
  content requests are not confused with live availability failures or billable
  retrieval sessions.
- Basic economic accounting for retrieval fees, rewards, audit budget, provider
  P&L, slashing, and elasticity spend caps.
- Epoch-scoped provider cost shocks that surface churn pressure.
- Bounded provider economic churn that turns sustained negative P&L into
  draining exits, active-capacity loss, and repair pressure.
- Reserve-provider supply entry with probationary promotion before new SPs
  become eligible for normal placement.
- Provider bond-headroom checks that exclude undercollateralized SPs from new
  responsibility and can repair active slots away from underbonded providers.
- User-funded elasticity overlays that activate temporary overflow routes,
  wait for readiness, serve retrievals, and expire by TTL without becoming
  base durable slots.
- Sponsored retrieval sessions that separate requester-funded public demand
  from deal-owner escrow debit.
- Storage lock-in accounting that charges committed deals upfront, earns
  storage fees over service epochs, pays eligible providers, burns the
  delinquent share under reward-exclusion semantics, and refunds unearned
  escrow on early close or auto-expires fully earned deals.
- Staged upload grief pressure where provisional generations are bounded by
  retention TTL, preflight rejection, and pending-generation caps.
- Demand-side storage admission accounting for latent new deal requests,
  price-elastic demand suppression, price rejections, capacity rejections, and
  effective/latent acceptance rates.

The simulator deliberately does not run `polystorechaind`, gateways, or provider
processes. Once a policy is stable here, add keeper tests or e2e scripts for the
corresponding implementation path.

## Output Contract

When `--out-dir` is supplied, the simulator emits:

- `summary.json`
- `assertions.json`
- `epochs.csv`
- `providers.csv`
- `operators.csv`
- `slots.csv`
- `evidence.csv`
- `repairs.csv`
- `economy.csv`

`slots.csv` includes per-slot health reason, repair attempt, and cooldown state.
`operators.csv` groups provider identities by operator and records provider
share, assignment share, success, and P&L.
`repairs.csv` includes start, pending-provider readiness, readiness timeout,
completion, attempt-count, cooldown, candidate-exclusion, attempt-cap, and
backoff events.

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
provider P&L, provider churn, burn/mint ratio, price trajectory, capacity
utilization, saturation/repair pressure, repair backlog, repair readiness,
provider supply entry, provider bond headroom, high-bandwidth promotion, and hot
retrieval routing, performance tiers, operator concentration, evidence pressure,
audit budget, sponsored retrieval accounting, elasticity spend, elasticity
overlay routes, and staged upload pressure.
`signals.json` records derived
availability, saturation, repair, capacity, economic, sponsored-retrieval,
elasticity-overlay, staged-upload, regional, high-bandwidth,
performance-market, concentration, and provider bottleneck signals for
downstream analysis.

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
