# PolyStore Policing and Failure Simulation Roadmap

Last updated: 2026-04-23

## 1. Purpose

PolyStore has a working happy path for cooperative provider-daemons and data
users. The next milestone is to make degraded and adversarial behavior
measurable, testable, and eventually enforceable.

The goal is not to begin with aggressive slashing. The goal is to build a
control loop:

1. Detect degraded or malicious behavior.
2. Classify the evidence quality.
3. Preserve user-facing retrieval availability.
4. Repair or replace unhealthy slots.
5. Apply proportional economic consequences.
6. Surface clear state to users, provider operators, and protocol maintainers.

This roadmap is breadth-first. It should guide planning before deeper execution
continues.

## 2. North Star

PolyStore policing is successful when the system can answer these questions
with evidence and metrics:

| Question | Target posture |
|---|---|
| Is the data still retrievable when providers fail? | Reads continue as long as at least `K` Mode 2 slots are available. |
| Was blame attributed to the right provider or component? | Every repair, reward exclusion, jail, or slash has an evidence class and reason. |
| Did bad actors get paid? | Corrupt, unproven, or out-of-session bytes are not rewarded. |
| Were honest providers punished for normal infra noise? | Transient soft faults decay health or trigger repair only after calibrated thresholds. |
| Can policy changes be calibrated safely? | Simulations and tests show impact before consensus behavior is hardened. |

## 3. Current Baseline

The current repo already contains several enforcement surfaces:

| Surface | Current posture |
|---|---|
| Mode 2 slot state | Explicit `mode2_slots`, `ACTIVE` / `REPAIRING`, pending providers, and generation tracking exist. |
| Retrieval sessions | Data-plane session gating exists on primary fetch paths. |
| Quotas and credits | Epoch quotas, organic credits, synthetic proof accounting, and missed-epoch tracking exist. |
| Repair | Make-before-break slot repair and deterministic replacement selection exist. |
| Draining | Provider draining and bounded repair scheduling exist. |
| Audit and deputy paths | Protocol audit tasks, deputy-served accounting, and protocol sessions are partially wired. |
| Fast simulation | `tools/policy_sim` now provides an initial deterministic logical simulator. |

The remaining work is to organize these mechanisms into an explicit reliability
and policing program, then calibrate the policy using simulations, keeper tests,
and selected process-level devnet e2e scenarios.

## 4. Goals

1. Maintain availability under normal failures.
2. Detect and contain malicious provider behavior.
3. Prevent economic griefing by providers, users, deputies, and gateways.
4. Avoid false positives that punish honest operators.
5. Make repair, reward exclusion, jailing, and slashing explainable.
6. Produce quantitative outputs for every policy change.
7. Keep simulation scenarios aligned with real chain and gateway concepts.

## 5. Non-Goals

1. Do not implement new slashing rules before evidence and policy gates are clear.
2. Do not treat off-chain observations as hard-fault evidence by default.
3. Do not make the simulator a parallel protocol with fantasy state.
4. Do not promote every simulation scenario into a slow e2e test.
5. Do not rely on provider goodwill or gateway trust for correctness.

## 6. Failure Taxonomy

| Failure class | Example behavior | Evidence quality | First policy posture |
|---|---|---:|---|
| Setup failure | Provider selected for a new slot but upload/manifest placement fails before first commit. | Weak, client/gateway observed | Setup bump, no slash. |
| Transient outage | Provider is offline for one or a few epochs. | Soft | Retry, route around, health decay only if repeated. |
| Sustained non-response | Provider repeatedly fails retrieval or audit sessions. | Soft to threshold-verifiable | Health decay, repair, possible conviction after threshold. |
| Quota shortfall | Provider does not meet epoch liveness quota. | Chain-measurable soft fault | No slash by default, missed epochs, repair trigger. |
| Corrupt data | Provider returns bytes that fail proof verification. | Hard if proof-bound | No payment, repair, slash/jail candidate. |
| Invalid proof | Provider submits an invalid synthetic/session proof. | Chain-verifiable hard fault | Immediate hard-fault path. |
| Withholding/ransom | Provider refuses to serve data it should hold. | Soft unless transcript/evidence reaches threshold | Route around, deputy/audit evidence, repair. |
| Slow service | Provider serves correctly but misses latency expectations. | Statistical | Reputation or placement priority, not slash initially. |
| Staged upload grief | User/gateway uploads many provisional generations and never commits. | Operational/accounting | Preflight rejection, retention limits, cleanup policy. |
| Replacement grinding | User or attacker repeatedly forces replacements to capture slots. | Chain-observable churn | Cooldowns, attempt caps, deterministic candidate selection. |
| Deputy evidence spam | Deputy submits many low-quality failure claims. | Evidence-market signal | Evidence bond, burn-on-expiry, bounty only on conviction. |
| Gateway misbehavior | Gateway withholds, rewrites, or misroutes requests. | Client/provider observable | Gateway is not a trust anchor; clients and chain verify roots/sessions. |
| Coordinated provider failure | Multiple assigned slots fail together. | Mixed | Availability threshold analysis, repair backlog controls, operator alerts. |

## 7. Evidence Classes

| Evidence class | Examples | Consequence ceiling |
|---|---|---|
| Cryptographic hard evidence | Invalid proof, wrong-data fraud proof, replayed proof. | Slash, jail, repair, reward exclusion. |
| Chain-measurable soft evidence | Quota shortfall, duplicate proof, expired session attempt. | Health decay, reward exclusion, repair. |
| Threshold evidence | Repeated non-response transcripts from distinct actors. | Conviction, jail/slash if policy is enabled. |
| Client-observed evidence | Fetch timeout, provider HTTP failure, setup upload failure. | Retry, route around, setup bump, no slash alone. |
| Gateway/provider logs | Transport errors, local health, staged upload cleanup. | Operator alerting, simulation input, not consensus by itself. |
| Statistical evidence | Latency distribution, high deputy-served fraction, repeated churn. | Placement priority, investigation, calibration. |

The core rule: hard consequences require hard or thresholded evidence. Soft
signals should first affect routing, health, rewards, and repair.

## 8. Policy Outcomes

| Outcome | Intended use |
|---|---|
| Ignore/noise | One-off failures below threshold. |
| Retry/fallback | Client or user-gateway route around transient failures. |
| Setup bump | Replace a slot before first content commit when setup fails. |
| Health decay | Track soft non-compliance without immediate punishment. |
| Reward exclusion | Provider did not satisfy quota or served no attributable bytes. |
| Repair/replacement | Move slot to `REPAIRING`, attach pending provider, preserve availability. |
| Evidence bond burn | Discourage low-quality deputy accusations. |
| Jail | Temporarily remove provider from eligibility after serious or repeated faults. |
| Slash | Apply only for hard or convicted faults with calibrated parameters. |
| Operator alert | Surface repeated issues before punitive policy is enabled. |

## 9. Metrics and Assertions

The program should standardize metrics before adding more enforcement:

| Metric | Why it matters |
|---|---|
| Retrieval success rate | Primary user-facing availability metric. |
| Unavailable reads | Measures when RS/routing failed to find `K` usable slots. |
| Time to repair start | Measures detection speed. |
| Time to repair completion | Measures healing speed. |
| False repair rate | Avoids needless churn from transient noise. |
| False slash/jail rate | Must approach zero before punitive rollout. |
| Corrupt bytes paid | Should be zero. |
| Bad-provider reward leakage | Measures whether unhealthy providers still earn. |
| Quota miss rate | Measures liveness policy pressure. |
| Deputy-served fraction | Indicates provider ghosting or routing weakness. |
| Repair churn per slot | Detects replacement grinding or unstable thresholds. |
| Slots hitting attempt caps | Shows repair-market or eligibility exhaustion. |
| Provider concentration | Detects placement capture risk. |
| Audit budget utilization | Shows whether audit policy is underfunded or overminting. |
| Evidence conviction ratio | Detects spam if too low and systemic outage if too high. |

Every scenario should define expected bounds for the metrics it exercises.

## 10. Simulation Program

The simulation program should have three layers:

| Layer | Purpose | Speed |
|---|---|---:|
| Logical policy simulator | Hundreds or thousands of providers, deals, users, epochs, and fault profiles without running processes. | Fast |
| Keeper-level tests | Consensus state transitions for policies that have graduated from the simulator. | Medium |
| Process-level devnet e2e | Real chain, user-gateway, provider-daemon, browser or CLI, and actual HTTP/P2P behavior for a small set of critical flows. | Slow |

The logical simulator should remain anchored to real protocol state:

1. Mode 2 RS(`K`, `K+M`) slot assignment.
2. Epoch liveness quotas.
3. Organic retrieval credits and credit caps.
4. Synthetic proof fill.
5. Retrieval sessions and range accountability.
6. Deputy-served evidence and audit debt.
7. `ACTIVE` / `REPAIRING` slot lifecycle.
8. Draining and deterministic replacement selection.

## 11. Scenario Matrix

| Scenario | Primary question | First simulation assertion | Later implementation gate |
|---|---|---|---|
| Ideal cooperative network | Does the system stay quiet when everyone behaves? | No repairs, no quota misses, full reward coverage. | Keeper no-op epoch tests. |
| Single provider outage | Does RS+routing preserve availability? | Success rate stays near 100%, repair starts after threshold. | Multi-provider e2e kill one provider. |
| Flapping provider | Are transient failures tolerated without thrash? | Repair rate below cap, no slash/jail. | Keeper missed-epoch window tests. |
| Sustained non-response | Does soft evidence trigger repair? | Missed epochs cross threshold, slot enters `REPAIRING`. | Keeper quota shortfall repair tests. |
| Corrupt data provider | Are bad bytes rejected and unpaid? | Corrupt bytes paid equals zero, hard fault recorded. | Provider response corruption e2e or proof-negative tests. |
| Invalid synthetic proof | Does hard-fault evidence trigger penalty path? | Invalid proof count increments, provider becomes repair candidate. | Keeper invalid proof penalty tests. |
| Withholding provider | Can users route around ransom behavior? | Retrieval success remains high, deputy/audit miss grows. | Router fallback and deputy evidence e2e. |
| Lazy provider | Does no-synthetic/no-credit behavior lose rewards? | Quota miss and reward exclusion occur. | Base reward eligibility tests. |
| Setup failure storm | Can new deals recover before first commit? | Bump count bounded, replacement not user-chosen. | Setup bump e2e with failed upload. |
| Replacement grinding | Are repeated replacements rate-limited? | Cooldown and attempt caps bind. | Keeper replacement cooldown tests. |
| Deputy evidence spam | Is spam uneconomic? | Bond burn exceeds expected spam gain. | Evidence-market keeper tests. |
| Audit budget exhaustion | Does the system degrade predictably? | Backlog grows, no unbounded mint. | Audit budget cap tests. |
| Coordinated regional outage | What is the availability cliff? | Success drops only when fewer than `K` slots remain. | Nightly/long-running multi-SP tests. |

## 12. Milestone Sequence

### Milestone 0: Planning Baseline

Deliverables:

1. This roadmap.
2. A failure and evidence taxonomy.
3. A scenario matrix with target metrics.
4. A list of existing implementation surfaces and known gaps.

Exit criteria:

1. Agreement on failure classes and consequence ceilings.
2. Agreement that simulation-first is the default for policy calibration.

### Milestone 1: Simulator as Policy Lab

Deliverables:

1. Scenario definitions for the canonical cases above.
2. JSON and CSV outputs for metrics.
3. Assertion presets for normal, degraded, and malicious conditions.
4. Seeded deterministic runs that can be compared over time.

Exit criteria:

1. A policy change can be evaluated across at least ideal, outage, corrupt, withholding, and lazy-provider scenarios.
2. The simulator identifies which chain/gateway behavior a scenario depends on.

### Milestone 2: Policy Calibration

Deliverables:

1. Candidate values for missed-epoch thresholds.
2. Candidate values for non-response conviction windows.
3. Repair cooldown and attempt cap recommendations.
4. Evidence bond and bounty calibration.
5. Audit budget sizing recommendations.

Exit criteria:

1. Chosen parameters have documented metric tradeoffs.
2. False-positive rates are tracked explicitly.

### Milestone 3: Keeper Test Graduation

Deliverables:

1. Keeper tests for every consensus-state policy that graduated from simulation.
2. Tests for quota miss, invalid proof, deputy-served miss, repair start, repair completion, draining, and replacement selection.
3. Explicit tests that soft faults do not slash by default.

Exit criteria:

1. Chain behavior matches simulator assumptions for the covered policy surfaces.
2. No punitive policy is enabled without deterministic tests.

### Milestone 4: Gateway and Provider Enforcement

Deliverables:

1. Endpoint audit for "no session, no bytes".
2. Structured provider error classes for timeout, refused, invalid response, wrong proof, and stale root.
3. User-gateway routing behavior for degraded providers.
4. Provider-daemon behavior for protocol audit and repair sessions.

Exit criteria:

1. Gateway/provider failures map to known taxonomy entries.
2. Routing around unhealthy slots is observable.

### Milestone 5: Process-Level Devnet Scenarios

Deliverables:

1. A small critical e2e suite, not a huge matrix.
2. Multi-provider tests for outage, corrupt response, withholding, repair, and setup bump.
3. Optional nightly or manual stress profile for 12+ providers.

Exit criteria:

1. The most important simulation claims have at least one real-stack confirmation.
2. Slow tests remain stable enough to run intentionally.

### Milestone 6: Observability and Operator UX

Deliverables:

1. Provider health and slot status surfaces.
2. Reason codes for repair and reward exclusion.
3. Audit debt and deputy-served metrics.
4. User-visible explanation when retrieval routes around a provider.

Exit criteria:

1. A user or operator can understand why a slot is `REPAIRING`.
2. Maintainers can monitor threshold tuning before enabling stronger penalties.

### Milestone 7: Punitive Policy Rollout

Deliverables:

1. Measure-only mode.
2. Repair-only mode.
3. Reward exclusion mode.
4. Jail mode.
5. Slash mode for hard or convicted faults.

Exit criteria:

1. False slash risk is acceptably low.
2. Hard-fault evidence paths are deterministic and tested.
3. Soft-fault conviction thresholds are calibrated against simulation and devnet data.

## 13. Graduation Criteria

A scenario should move from simulation to keeper tests when:

1. The expected outcome affects consensus state.
2. The simulator has stable deterministic assertions for it.
3. The required chain state already exists or is intentionally being added.

A scenario should move from keeper tests to process-level e2e when:

1. It depends on HTTP/P2P behavior, gateway routing, provider-daemon behavior, or browser/client behavior.
2. The process-level test will catch a bug that keeper tests cannot.
3. The scenario is important enough to justify slow test cost.

A scenario should not move to punitive enforcement until:

1. Evidence class and consequence ceiling are agreed.
2. False-positive risk is measured.
3. Operator/user observability exists.
4. Rollback or parameter reduction is straightforward.

## 14. Implementation Surfaces

| Surface | Responsibilities |
|---|---|
| `polystorechain` keeper | Evidence classification, quotas, credits, missed epochs, repair, draining, rewards, jailing/slashing when enabled. |
| `polystore_gateway` user-gateway mode | Session planning, route selection, fallback, error classification, user-facing retrieval behavior. |
| `polystore_gateway` provider-daemon mode | Byte serving, session validation, proof headers, provider-side session durability, protocol audit/repair handling. |
| `polystore-website` | Degraded-state UX, provider/slot visibility, clear route and repair status. |
| `tools/policy_sim` | Fast deterministic policy simulation and quantitative scenario assertions. |
| `scripts/e2e_*` | Slow confirmation for critical real-stack failure scenarios. |
| Docs/RFCs | Evidence taxonomy, policy defaults, operational runbooks, launch posture. |

## 15. Immediate Planning Tasks

Before investing further in execution:

1. Review this roadmap and adjust taxonomy names.
2. Decide the first 5 canonical scenarios to standardize.
3. For each canonical scenario, define target metrics and acceptable bounds.
4. Map each scenario to current code coverage and missing tests.
5. Decide which consequences remain measure-only for the next milestone.

Recommended first canonical scenarios:

1. Ideal cooperative network.
2. Single provider outage.
3. Sustained non-response or withholding.
4. Corrupt data or invalid proof.
5. Setup failure before first commit.

## 16. Open Questions

1. Should hot and cold deals use separate missed-epoch thresholds from the start?
2. What false-positive repair rate is acceptable during trusted devnet?
3. What false-positive slash rate is acceptable before mainnet? The likely answer is effectively zero.
4. Which non-response evidence should count toward conviction: user reports, deputy transcripts, audit tasks, or all of them with weights?
5. How much audit budget should be reserved for proactive checks versus repair catch-up?
6. Should replacement cooldowns be per slot, per deal, per provider, or all three?
7. What operator maintenance mode is needed before "draining" becomes the only clean exit path?
8. Which degraded behaviors should affect placement priority before they affect economic penalties?

