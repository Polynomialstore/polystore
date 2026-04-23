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

Generate human-readable reports from raw simulator outputs:

```bash
python3 tools/policy_sim/report.py \
  --run-dir /tmp/polystore-policy/runs/single-outage \
  --out-dir /tmp/polystore-policy/reports/single-outage
```

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

## Model Scope

The simulator mirrors current protocol concepts:

- Mode 2 RS(`K`, `K+M`) slot assignment.
- Epoch liveness quotas with organic credit caps and synthetic fill.
- Retrieval routing around failed slots when at least `K` slots can serve.
- Corrupt retrievals and invalid synthetic proofs as hard faults.
- Provider outage/withholding as soft faults that become quota/deputy misses.
- Make-before-break repair with deterministic replacement provider selection.
- Simulated enforcement modes before live chain/runtime rollout.
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

`report.py` consumes those raw files and can emit:

- `report.md`
- `risk_register.md`
- `graduation.md`
- `policy_delta.md` for baseline/candidate comparisons
- `graphs/*.svg`

The simulator should remain deterministic and machine-output focused. Reporting
and graph generation belong in `report.py`.

## Tests

```bash
python3 -m unittest discover -s tools/policy_sim
```
