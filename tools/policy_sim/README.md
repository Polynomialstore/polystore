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

## Model Scope

The simulator mirrors current protocol concepts:

- Mode 2 RS(`K`, `K+M`) slot assignment.
- Epoch liveness quotas with organic credit caps and synthetic fill.
- Retrieval routing around failed slots when at least `K` slots can serve.
- Corrupt retrievals and invalid synthetic proofs as hard faults.
- Provider outage/withholding as soft faults that become quota/deputy misses.
- Make-before-break repair with deterministic replacement provider selection.

The simulator deliberately does not run `polystorechaind`, gateways, or provider
processes. Once a policy is stable here, add keeper tests or e2e scripts for the
corresponding implementation path.

## Tests

```bash
python3 -m unittest discover -s tools/policy_sim
```

