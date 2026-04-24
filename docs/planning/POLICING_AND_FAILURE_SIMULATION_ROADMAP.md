# PolyStore Policing and Failure Simulation Roadmap

Last updated: 2026-04-24

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

### 3.1 Review Findings Resolved in This Pass

This pass reviewed the roadmap against `spec.md`, `ECONOMY.md`,
`MAINNET_ECON_PARITY_CHECKLIST.md`, and the economics RFCs. The main concerns
were:

| Concern | Why it mattered | Resolution in this roadmap |
|---|---|---|
| Economic self-calibration was implicit, not a first-class workstream. | The target network depends on storage pricing, retrieval pricing, rewards, audit budget, and elasticity converging together. | Added a dedicated financial market section and expanded goals, metrics, scenarios, workstreams, and DoD. |
| Policing could be interpreted as only fault detection and slashing. | The intended system also uses pricing, escrow, reward exclusion, bond requirements, and spend caps as primary control surfaces. | Added economic control loops and market-failure scenarios before punitive rollout. |
| Provider behavior was modeled without provider profit and cost. | A provider can be honest but economically unable to remain in the active set if prices or subsidies are wrong. | Added provider P&L, cost shocks, utilization, churn, and fee-vs-issuance metrics to the simulator requirements. |
| Elasticity was described operationally but not financially. | Overlay expansion must be demand-funded and bounded by user escrow and spend windows. | Added explicit elasticity accounting invariants and viral-demand scenarios. |
| Audit and deputy behavior lacked a full market-clearing view. | Audit budget, deputy premiums, evidence bonds, and bounties can underpay honest work or invite spam. | Added audit/deputy market metrics, scenarios, and calibration gates. |
| Completion criteria did not require economic equilibrium evidence. | A network can be reliable in a short devnet and still economically unstable. | Added fee-dominant steady-state, price convergence, and anti-wash DoD items. |

## 4. Goals

1. Maintain availability under normal failures.
2. Detect and contain malicious provider behavior.
3. Prevent economic griefing by providers, users, deputies, and gateways.
4. Avoid false positives that punish honest operators.
5. Make repair, reward exclusion, jailing, and slashing explainable.
6. Produce quantitative outputs for every policy change.
7. Keep simulation scenarios aligned with real chain and gateway concepts.
8. Model the financial market as a deterministic control system, not only as
   reward constants.
9. Calibrate toward a fee-dominant equilibrium where marginal honest providers
   can cover costs primarily from user-funded storage and retrieval fees.
10. Make price, escrow, reward, audit, and elasticity changes testable before
    they become consensus-critical defaults.

## 5. Non-Goals

1. Do not implement new slashing rules before evidence and policy gates are clear.
2. Do not treat off-chain observations as hard-fault evidence by default.
3. Do not make the simulator a parallel protocol with fantasy state.
4. Do not promote every simulation scenario into a slow e2e test.
5. Do not rely on provider goodwill or gateway trust for correctness.
6. Do not tune market parameters from one happy-path devnet run.
7. Do not use dynamic pricing to hide missing accounting, missing evidence, or
   insufficient provider incentives.

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
| Replacement grinding | User or attacker repeatedly forces replacements or pending catch-up attempts to churn. | Chain-observable churn | Readiness timeout, cooldowns, attempt caps, deterministic candidate selection. |
| Deputy evidence spam | Deputy submits many low-quality failure claims. | Evidence-market signal | Evidence bond, burn-on-expiry, bounty only on conviction. |
| Gateway misbehavior | Gateway withholds, rewrites, or misroutes requests. | Client/provider observable | Gateway is not a trust anchor; clients and chain verify roots/sessions. |
| Coordinated provider failure | Multiple assigned slots fail together. | Mixed | Availability threshold analysis, repair backlog controls, operator alerts. |
| Underpriced storage | Storage price does not cover honest provider cost at target utilization. | Market simulation / chain params | Price controller tuning, subsidy review, assignment throttling. |
| Overpriced storage | Storage price suppresses user demand or causes systematic escrow underfunding. | Market simulation / user telemetry | Price bounds, quote UX, governance/default review. |
| Price oscillation | Dynamic pricing overreacts to utilization or retrieval bursts. | Chain state / simulator | Step clamps, EMA windows, dampening, delayed activation. |
| Wash retrieval traffic | Actors create fake retrievals to farm rewards or credits. | Session accounting / burn economics | Mandatory burns, credit caps, requester-paid sessions, anomaly alerts. |
| Viral debt | Public or hot content exhausts escrow during a traffic spike. | Escrow/spend-window state | Sponsored sessions, top-ups, rate limiting, bounded elasticity. |
| Elasticity overlay churn | Temporary overflow routes activate but do not become ready, serve, or expire cleanly. | Market/runtime telemetry | Readiness gate, spend-window accounting, TTL cleanup, route visibility. |
| Subsidy farming | Providers create storage responsibility mainly to extract emissions. | Reward/accounting analysis | Fee-backed rent base, compliance gating, burn unearned rewards. |

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
| Data-loss events | Measures when the simulator believes fewer than `K` trusted durable slots remain. This should stay at zero for current fixtures. |
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
| Storage utilization | Drives storage price and supply calibration. |
| Retrieval demand by epoch | Drives retrieval price calibration and hot-deal routing. |
| Storage price trajectory | Detects underpricing, overpricing, and oscillation. |
| Retrieval price trajectory | Detects spam pressure, affordability issues, and burst sensitivity. |
| Provider profit/loss | Shows whether honest marginal providers can remain online. |
| Fee-vs-issuance share | Measures progress toward fee-dominant equilibrium. |
| Burn/mint ratio | Detects missing sinks, excessive burns, or reward starvation. |
| Escrow runway | Shows whether users can sustain committed storage and expected retrievals. |
| Elasticity spend-window usage | Shows whether demand-funded scaling is useful or cap-bound. |

Every scenario should define expected bounds for the metrics it exercises.

Scale threshold policy:

1. Temporary unavailable reads are acceptable in explicitly marked stress
   fixtures while the system is still being tuned.
2. Data-loss events are not acceptable for the current simulator milestone.
3. Corrupt bytes paid must remain zero.
4. Any scenario that allows unavailable reads must say so in its report and
   still assert `max_data_loss_events = 0`.

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
9. Storage and retrieval pricing parameters.
10. Deal escrow, spend windows, and sponsored requester funding.
11. Base reward pool, audit budget, burns, and provider payouts.
12. Provider costs, capacity, bond requirements, and churn behavior.

### 10.1 Report Corpus and CI Contract

The simulator now has a committed report corpus generated from
`tools/policy_sim/scenarios` into `docs/simulation-reports/policy-sim`.

The committed corpus should include:

1. `README.md` scenario index.
2. One directory per scenario.
3. `report.md`, `risk_register.md`, and `graduation.md`.
4. `signals.json`, `summary.json`, and `assertions.json`.
5. Inline SVG graph assets under `graphs/`.

The committed corpus intentionally does not include full CSV ledgers for every
scenario. Those ledgers are generated locally or uploaded as CI artifacts
because scale scenarios can produce large slot/evidence/economy tables.

CI should run the full fixture suite first, including the expensive
`large-scale-regional-stress` scenario. If this proves too expensive, scale
back only after observing real CI timing and failure modes. The current desired
posture is:

1. Unit-test simulator code.
2. Run every scenario fixture.
3. Regenerate `docs/simulation-reports/policy-sim`.
4. Fail CI if the committed reports are stale.
5. Upload raw simulator ledgers as artifacts for deeper review.

### 10.2 Economic Assumptions in Current Reports

The simulator's economic model is a deterministic control-system model, not a
final token-economics model. Reports must make the assumptions visible so human
review can decide whether they are credible before policy graduates.

Current assumptions:

1. Prices, rewards, costs, burns, and budgets are unitless accounting values.
2. Storage price responds to modeled capacity utilization when dynamic pricing
   is enabled.
3. Retrieval price responds to retrieval attempts per epoch when dynamic
   pricing is enabled.
4. The controller uses bounded per-epoch steps, floors, and ceilings.
5. Provider P&L is simplified as fixed cost plus storage responsibility cost
   plus retrieval bandwidth cost, optionally with per-provider jitter.
6. Base rewards are modeled as issuance/subsidy and paid only to
   reward-eligible slots.
7. Retrieval burns reduce requester/session payments before provider payout.
8. Audit budget spending is capped by available budget and miss-driven demand.
9. Elasticity spending fails closed when the configured spend cap is exceeded.
10. The model now includes first-pass storage demand elasticity, but it does
    not yet include real fiat bandwidth prices, capital cost of bonds, or
    secondary market token volatility.

Human decisions still required:

1. Which cost assumptions should be anchored to real provider pricing data.
2. Whether target utilization should differ by service class.
3. Whether storage and retrieval controllers should share state or remain
   separate.
4. Whether audit budget exhaustion should create backlog, fee increases,
   stronger admission control, or governance intervention.
5. Which economic thresholds become governance params versus monitoring-only
   launch metrics.

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
| Staged upload grief | Are abandoned provisional generations bounded before commit? | Retention cleanup and preflight rejection cap pending staged state without repair/slash. | Provider-daemon staged cleanup and gateway preflight tests. |
| Replacement grinding | Are repeated replacements and failed pending catch-up attempts rate-limited? | Readiness timeouts, cooldowns, and attempt caps bind. | Keeper replacement cooldown and readiness-timeout tests. |
| Deputy evidence spam | Is spam uneconomic? | Bond burn exceeds expected spam gain. | Evidence-market keeper tests. |
| Audit budget exhaustion | Does the system degrade predictably? | Backlog grows, no unbounded mint. | Audit budget cap tests. |
| Coordinated regional outage | What is the availability cliff? | Success drops only when fewer than `K` slots remain. | Nightly/long-running multi-SP tests. |
| Underpriced supply collapse | Do honest providers churn when price is below cost? | Provider P&L turns negative and capacity exits. | Dynamic pricing and subsidy calibration tests. |
| Provider cost shock | Does a sudden operator cost increase create churn pressure before availability fails? | Cost-shock epochs are visible, provider P&L turns negative, and retrievals remain available. | Provider cost telemetry and price-floor governance review. |
| Overpriced demand collapse | Does high price suppress useful demand? | New deal creation and retrieval demand fall below target. | Quote UX and pricing-bound tests. |
| Price oscillation | Does the controller converge after demand shocks? | Price remains within bounds and settles without repeated overshoot. | Epoch pricing keeper tests. |
| Retrieval demand shock | Does burst read demand move retrieval price without oscillating or harming availability? | Retrieval price reacts within bounds, direction changes stay limited, and reads remain available. | Retrieval pricing keeper tests. |
| Wash traffic | Can fake retrievals profit from rewards or credits? | Burn and fees exceed expected reward or credit value. | Session fee, credit cap, and anomaly tests. |
| Viral public retrieval | Does public demand scale without draining owner escrow? | Sponsored sessions fund retrieval; owner escrow remains stable. | Sponsored-session e2e. |
| Storage escrow close/refund | Does committed storage escrow lock, earn, and refund deterministically? | Storage escrow locks upfront, pays earned fees, refunds unearned close balance, and leaves no outstanding escrow. | Quote-to-charge, close/refund, and expiry keeper tests. |
| Storage escrow noncompliance burn | Are earned storage fees withheld from delinquent responsibility? | Storage escrow still earns, compliant slots are paid, delinquent share is burned, and availability/durability stay intact. | Storage-fee payout eligibility and burn-ledger tests. |
| Storage escrow expiry | Does fully earned committed storage expire cleanly? | Deals auto-expire at duration end, stop active responsibility, and leave no outstanding escrow. | Expiry auto-close and deal GC keeper tests. |
| Closed retrieval rejection | Do reads after intentional deal close fail explicitly? | Post-close requests are counted as closed-content rejections, not unavailable reads or billable sessions. | Closed-deal query and post-close retrieval response tests. |
| Elasticity cap hit | What happens when demand exceeds user budget? | Scaling stops cleanly and service is rate-limited, not unbounded. | `MsgSignalSaturation` spend-window e2e. |
| Elasticity overlay scale-up | Does funded overflow capacity become useful and temporary? | Overlay routes activate, become ready, serve reads, and expire without data loss. | Overlay readiness, routing expansion, and TTL e2e. |
| Subsidy farming | Can providers earn emissions without useful service? | Non-compliant or idle responsibility is unrewarded or uneconomic. | Base reward compliance tests. |
| Repair candidate exhaustion | Does the network expose lack of spare capacity safely? | Repair backoffs occur, capacity is respected, no silent over-assignment. | Keeper candidate-selection and backoff tests. |
| Price controller bounds | Does dynamic pricing stay bounded under sustained demand? | Prices move within configured floors/ceilings and reports expose provider P&L. | Epoch pricing keeper tests. |

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
5. Scenario fixture files that can be reviewed and versioned.
6. Per-provider, per-slot, evidence, repair, and economic ledgers.
7. A comparison command for policy parameter changes.

Exit criteria:

1. A policy change can be evaluated across at least ideal, outage, corrupt, withholding, and lazy-provider scenarios.
2. The simulator identifies which chain/gateway behavior a scenario depends on.
3. Canonical reliability and economic scenarios run from fixture files with
   deterministic assertions.
4. The simulator can produce enough evidence to decide which behavior should
   graduate to keeper tests.

### Milestone 2: Policy Calibration

Deliverables:

1. Candidate values for missed-epoch thresholds.
2. Candidate values for non-response conviction windows.
3. Repair cooldown and attempt cap recommendations.
4. Evidence bond and bounty calibration.
5. Audit budget sizing recommendations.
6. Storage and retrieval pricing controller parameters.
7. Base reward start/tail bps and halving interval recommendations.
8. Elasticity cost, spend-window, and TTL recommendations.
9. Provider cost assumptions and marginal-provider profitability report.

Exit criteria:

1. Chosen parameters have documented metric tradeoffs.
2. False-positive rates are tracked explicitly.
3. Economic parameters have documented convergence, affordability, and
   provider-profitability tradeoffs.

### Milestone 3: Keeper Test Graduation

Deliverables:

1. Keeper tests for every consensus-state policy that graduated from simulation.
2. Tests for quota miss, invalid proof, deputy-served miss, repair start, repair completion, draining, and replacement selection.
3. Explicit tests that soft faults do not slash by default.

Exit criteria:

1. Chain behavior matches simulator assumptions for the covered policy surfaces.
2. No punitive policy is enabled without deterministic tests.

Current landed status:

1. Dynamic pricing bounds, base reward compliance, audit budget caps, protocol
   repair-session authorization, repair candidate eligibility, and repair
   backoff evidence have keeper coverage.
2. Repair start and replacement selection now have deterministic tests across
   quota misses, deputy-served misses, provider health failures, draining, and
   routine rotation.
3. The active graduation slice is repair-readiness and promotion correctness:
   a pending provider must produce deterministic readiness evidence before
   manual or automatic slot promotion can replace the active provider.

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

### Milestone 7: Live Enforcement Rollout

This milestone means enabling enforcement in live protocol/runtime
configuration. It is not the first time these consequences are modeled. Every
live mode below must be simulated first, then covered by keeper tests, then
confirmed through the minimum relevant e2e path.

Deliverables:

1. Live measure-only mode.
2. Live repair-only mode.
3. Live reward exclusion mode.
4. Live jail mode.
5. Live slash mode for hard or convicted faults.

Exit criteria:

1. The corresponding simulated enforcement mode has deterministic passing
   assertions.
2. Keeper tests cover the consensus state transition.
3. Runtime or e2e tests cover the minimum data-plane behavior, if applicable.
4. False slash risk is acceptably low.
5. Hard-fault evidence paths are deterministic and tested.
6. Soft-fault conviction thresholds are calibrated against simulation and
   devnet data.

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
| `tools/policy_sim` | Fast deterministic policy, reliability, and market simulation with quantitative scenario assertions. |
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

## 16. Full Desired Network State

The end state is a self-healing storage network with explicit policy state,
not a happy-path devnet with manual operator intervention.

At maturity, the network should provide:

1. **Provider lifecycle management:** providers progress through onboarding,
   probation, active service, higher-capability promotion, degradation,
   delinquency, repair, draining, jailing, and exit states.
2. **Slot lifecycle automation:** every assigned slot has health, evidence,
   replacement, catch-up, and promotion state.
3. **Automatic delinquency handling:** when a slot is delinquent, the chain can
   mark it `REPAIRING`, attach a deterministic pending provider, route around
   it, verify catch-up, and promote the replacement.
4. **Performance-aware placement:** service hints such as `Hot`, `Cold`,
   `General`, `Archive`, and `Edge` affect placement, audit frequency, quotas,
   reward multipliers, and promotion eligibility.
5. **User-funded elasticity:** bandwidth or replication increases only when the
   user's escrow and spend window can pay for it.
6. **Protocol-funded audit and repair:** protocol sessions can audit or repair
   restricted deals without bypassing retrieval-session accounting.
7. **Evidence-backed consequences:** repair, reward exclusion, jailing, and
   slashing all have explicit evidence classes and event reason codes.
8. **Operational clarity:** users, provider operators, and maintainers can see
   why a route, repair, demotion, promotion, or penalty occurred.
9. **Financial self-calibration:** storage price, retrieval price, issuance,
   burns, rewards, audit budget, and elasticity spending move toward a stable
   operating point.
10. **Fee-dominant steady state:** protocol issuance bootstraps reliability,
    but honest providers can eventually cover marginal cost mostly from
    user-funded storage and retrieval demand.

The rest of this document should be read as the implementation map to reach
that state.

## 17. Provider Lifecycle State Machine

The current chain has a simple provider registry with `Active` and `draining`
concepts. The desired network needs a richer lifecycle. Not every state needs
to be consensus-critical on day one, but the model should be explicit so
simulation, policy, UI, and chain implementation do not diverge.

| State | Meaning | Eligible for new assignments? | Typical transitions |
|---|---|---:|---|
| `CANDIDATE` | Operator has identity and endpoint but has not proven readiness. | No | Pairing requested, endpoint checked. |
| `PAIRED` | Provider identity is linked to an operator or wallet. | No | Operator approval, funding/bond check. |
| `PROBATIONARY` | Provider can receive low-risk assignments with caps. | Limited | Pass readiness tests, serve trial traffic. |
| `ACTIVE` | Provider is eligible for normal placement. | Yes | Good health and sufficient bond/capacity. |
| `PREFERRED` | Provider has sustained good performance and reliability. | Yes, with higher caps | Better placement priority or hot-deal eligibility. |
| `HIGH_BANDWIDTH` | Provider qualifies for higher-throughput or hot-path routing. | Yes, for high bandwidth demand | Promotion from measured throughput and low error rate. |
| `DEGRADED` | Provider has soft-fault history but is not yet delinquent. | Limited or no | Health decay, operator alert, lower placement priority. |
| `DELINQUENT` | Provider exceeded soft-fault thresholds for one or more assignments. | No | Slot repair, reward exclusion, possible evidence workflow. |
| `DRAINING` | Provider is voluntarily exiting new work. | No | Existing slots replaced under churn caps. |
| `JAILED` | Provider is temporarily ineligible due to hard or convicted faults. | No | Jail expiry plus reactivation conditions. |
| `EXITED` | Provider has completed exit or is removed. | No | Unbonding and final GC policy. |

Required implementation decisions:

1. Which states are consensus fields versus derived query/UI state.
2. Whether `DEGRADED` and `DELINQUENT` are global provider states, per-slot
   states, or both.
3. How provider state affects placement, repair selection, reward eligibility,
   and audit targeting.
4. Whether `HIGH_BANDWIDTH` is a separate state, a capability label, or a
   scored tier.

## 18. Slot Lifecycle State Machine

Provider state is not enough. Accountability is per assignment, especially for
Mode 2. The slot lifecycle should be the primary unit for repair and
delinquency.

| State | Meaning | Reads | Quotas/rewards | Transition triggers |
|---|---|---|---|---|
| `SETUP_PENDING` | Slot assigned before first content commit. | No committed data yet | No quota | Deal created. |
| `SETUP_FAILED` | Initial upload to this slot failed. | No committed data yet | No quota | Client/gateway detects upload failure. |
| `ACTIVE` | Slot is current accountable provider. | Route eligible | Quota/reward eligible | Successful setup or promotion. |
| `SUSPECT` | Soft failures observed but below repair threshold. | Route with lower priority | Quota still applies | Timeouts, latency, deputy-served hints. |
| `DELINQUENT` | Threshold crossed for soft non-compliance. | Route around if possible | Reward excluded | Missed epochs or confirmed non-response. |
| `REPAIRING` | Replacement candidate is catching up. | Route around old slot | Excluded from quotas/rewards | Repair start. |
| `CATCHUP_READY` | Pending provider claims it has caught up. | Optional verification route | Not yet active | Readiness proof submitted. |
| `ACTIVE_PROMOTED` | Pending provider becomes current provider. | Route eligible | Quota/reward eligible | Chain promotes pending provider. |
| `REPAIR_BACKOFF` | Repair attempts exhausted or no eligible candidate. | Route around if possible | No reward | Attempt cap or candidate exhaustion. |
| `EXPIRED` | Deal expired; slot no longer serves. | No | No | Deal expiry / GC. |

Current implementation already has `ACTIVE`, `REPAIRING`, `pending_provider`,
`repair_target_gen`, and a first-generation `Mode2RepairReadiness` keeper
ledger. The readiness ledger is set by valid pending-provider proof activity
while a slot is repairing, and promotion checks that readiness before swapping
the active provider. The policy simulator now mirrors this lifecycle by
emitting repair ledger events in `started/ready/completed` order, where `ready`
represents pending-provider catch-up evidence before promotion. Missing
desired-state pieces include:

1. Keeper/runtime `SUSPECT` / `DELINQUENT` reason codes. The simulator now
   emits per-slot `HEALTHY`, `SUSPECT`, and `DELINQUENT` health state with
   reason codes in `slots.csv`.
2. Keeper/runtime repair attempt counters and cooldown windows. The simulator
   now models these with `repair_attempt_cap_per_slot`,
   `repair_backoff_epochs`, per-slot attempt state, cooldown backoff events,
   attempt-cap backoff events, and candidate-exclusion diagnostics.
3. Full catch-up proofs for all data/generation ranges, beyond the current
   readiness marker.
4. Per-slot health queries for UI and operator tooling.
5. A unified treatment of setup-phase bumping and post-commit repair.

## 19. Automatic Delinquency Repair and Promotion Flow

The most important automation loop is: mark one SP delinquent, demote it for
that slot, and promote a replacement without losing availability.

Desired flow:

1. **Evidence accrues:** quota shortfall, zero direct service with deputy
   service, threshold non-response, invalid proof, corrupt response, or
   operator-initiated drain.
2. **Classification occurs:** the chain or policy layer classifies the event as
   hard fault, soft fault, setup failure, maintenance/drain, or inconclusive.
3. **Slot is marked:** for post-commit content, the slot moves to `REPAIRING`;
   for setup-phase content, the slot uses deterministic setup bumping.
4. **Replacement is selected:** the chain deterministically selects an eligible
   provider, excluding jailed, draining, underbonded, insufficient-capacity,
   already-assigned, incompatible, or recently-failed candidates.
5. **Reads route around repair:** user-gateways and clients choose any `K`
   healthy `ACTIVE` slots.
6. **Protocol repair session opens:** pending provider fetches data using
   protocol-authorized retrieval sessions, not free side-channel reads.
7. **Pending provider catches up:** it reconstructs and stores required shards
   through `repair_target_gen` and any append-only generations that occurred
   during repair.
8. **Readiness is verified:** pending provider submits a readiness proof,
   catch-up proof, or satisfies a repair quota window.
9. **Promotion occurs:** chain swaps `slot.provider = pending_provider`, clears
   `pending_provider`, sets slot `ACTIVE`, advances generation or replacement
   nonce as needed, and mirrors legacy `providers[]`.
10. **Old provider consequences apply:** old provider may be no-op, degraded,
    reward-excluded, jailed, or slashed depending on evidence class.

Required policy gates:

1. A soft-fault repair should not imply slash.
2. A hard-fault repair may imply immediate penalty if evidence is deterministic.
3. A setup bump should not imply fraud or penalty.
4. A draining repair should not imply penalty if the provider continues serving
   until replaced.
5. If no replacement is available, the slot enters backoff and emits an alert.

Implementation surfaces:

| Surface | Required work |
|---|---|
| Chain | Slot health state, repair attempt ledger, deterministic candidate selection, readiness proof, promotion conditions, events. |
| Provider-daemon | Protocol repair fetch, local catch-up storage, readiness proof generation, storage of repaired shards. |
| User-gateway | Route around `REPAIRING`, expose repair status, retry after promotion. |
| Website | Show degraded/repairing slot state and current provider/pending provider. |
| Simulator | Model delinquency thresholds, candidate exhaustion, repair duration, false positives, and promotion success. |
| E2E | Kill/withhold/corrupt provider, verify repair starts, pending provider catches up, promotion occurs, reads remain available. |

Current implementation note:

The current keeper-level readiness marker is a promotion guardrail, not a full
data-plane catch-up proof. It prevents immediate promotion without pending
provider proof activity, but the next data-plane step is to prove that the
pending provider reconstructed every required shard for `repair_target_gen`
and any generations committed while repair was in progress.

## 20. New SP Onboarding and Higher-Bandwidth Promotion

The network should not treat every new provider as equally reliable or equally
capable. New SPs need a promotion path from "can join" to "trusted for hot or
high-bandwidth work."

### 20.1 Onboarding Pipeline

Desired onboarding stages:

1. **Identity creation:** provider key exists and is paired with an operator.
2. **Endpoint registration:** endpoints are canonical, reachable, and versioned.
3. **Health check:** provider responds to `/health`, status, and capability
   queries.
4. **Storage readiness:** provider proves writable storage root and minimum free
   space.
5. **Bandwidth probe:** provider completes controlled upload/download probes.
6. **Protocol readiness:** provider can open/serve retrieval sessions and submit
   proof paths.
7. **Probation:** provider receives limited assignments and is watched closely.
8. **Promotion:** provider becomes eligible for normal, preferred, or
   high-bandwidth work.

### 20.2 Promotion Signals

Promotion should use multiple signals, not a single speed test:

| Signal | Use |
|---|---|
| Successful setup uploads | Proves the provider can receive assigned artifacts. |
| Retrieval success rate | Measures real serving reliability. |
| Time to first byte / throughput | Determines hot/high-bandwidth eligibility. |
| Synthetic proof completion | Measures accountability under protocol liveness. |
| Protocol repair participation | Measures usefulness during failure recovery. |
| Error rate and timeout rate | Drives demotion or probation extension. |
| Bond and capacity headroom | Prevents over-assignment. |
| Version and feature compatibility | Ensures provider supports required protocol features. |

### 20.3 Assignment Caps

Promotion should affect maximum responsibility:

| Tier | Assignment posture |
|---|---|
| `PROBATIONARY` | Low cap, small/cold deals only, no hot deals. |
| `ACTIVE` | Normal assignment caps. |
| `PREFERRED` | Higher placement priority and higher caps. |
| `HIGH_BANDWIDTH` | Eligible for hot deals, larger egress load, and overflow routing. |
| `DEGRADED` | No new assignments, existing assignments watched. |

Caps should be enforced per provider and possibly per operator to limit Sybil
concentration.

### 20.4 High-Bandwidth Promotion

High-bandwidth promotion should be tied to measurable capability:

1. Controlled benchmark sessions run through normal retrieval-session paths.
2. Provider serves multiple blob ranges with low error rate and stable
   throughput.
3. Provider demonstrates concurrency without degrading proof/session behavior.
4. Provider has enough bond and capacity for the extra responsibility.
5. Promotion is revocable if later measurements regress.

Simulation should model high-bandwidth SPs separately from normal SPs so policy
can answer:

1. How quickly should a new fast SP receive more work?
2. How much assignment should one fast SP be allowed to accumulate?
3. How sensitive should hot-deal routing be to transient latency?
4. What happens when a high-bandwidth SP fails suddenly?

Current simulator coverage:

1. `tools/policy_sim/scenarios/high_bandwidth_promotion.yaml` models a
   heterogeneous provider population with hot retrieval demand.
2. `tools/policy_sim/scenarios/high_bandwidth_regression.yaml` models the
   revocation side of the same policy when promoted providers saturate under
   concentrated hot traffic.
3. Providers promote to `HIGH_BANDWIDTH` only after satisfying configured
   bandwidth capacity, retrieval-count, success-rate, saturation, and
   hard-fault checks.
4. Hot retrieval routing can prefer promoted providers while retaining the
   existing route-attempt, availability, and over-capacity assertions.
5. Reports expose promotion count, final high-bandwidth provider count,
   demotions, hot retrieval attempts, saturation responses, and hot serves by
   high-bandwidth providers.
6. `tools/policy_sim/sweeps/high_bandwidth_thresholds.yaml` compares capacity
   and demotion-saturation thresholds so the implementation default can be
   chosen from parameter evidence instead of one fixture.
7. The missing live surfaces are provider capability state, probe telemetry,
   hot-route preference queries, saturation evidence accumulation, and demotion
   policy.

## 21. Performance Market and Service Classes

`spec.md` defines a performance market with service hints and reward tiers. The
roadmap should treat this as a first-class policing surface, not a UI label.

Desired service classes:

| Class | Intended provider pool | Policy differences |
|---|---|---|
| `Cold` | `Archive` / `General` | Lower audit frequency, looser latency, lower quota pressure, larger capacity. |
| `General` | Balanced providers | Default quotas and repair thresholds. |
| `Hot` | `General` / `Edge` / high-bandwidth providers | Higher audit frequency, tighter health thresholds, faster repair, higher reward multipliers. |

Desired reward tiers:

| Tier | Meaning | Policy use |
|---|---|---|
| `Platinum` | Very fast successful service. | Highest retrieval/performance reward. |
| `Gold` | Good service within target. | Normal positive reward. |
| `Silver` | Acceptable but slow service. | Lower reward, possible health note. |
| `Fail` | Missed response or invalid service. | No reward, health impact. |

Implementation requirements:

1. Define latency/throughput windows as params or profile values.
2. Attribute each retrieval/proof to provider, slot, service class, and epoch.
3. Keep latency rewards separate from hard correctness.
4. Use service class to tune quotas, repair thresholds, audit sampling, and
   placement priority.
5. Avoid slashing based solely on latency unless a future threshold-evidence
   design makes it defensible.

Performance-market rewards should be simulated together with provider costs.
A provider that is consistently `Silver` may still be useful for cold data, but
should not be able to dominate hot placement or earn high-bandwidth rewards.
Likewise, `Platinum` providers should receive more opportunity only while
assignment caps, operator concentration limits, and bond headroom stay healthy.

Current simulator coverage:

1. `tools/policy_sim/scenarios/performance_market_latency.yaml` models Hot
   service demand across providers with heterogeneous latency.
2. Providers are classified into Platinum/Gold/Silver/Fail tiers using
   configured latency windows while retrieval correctness remains separate from
   QoS tiering.
3. Tiered performance rewards are accounted separately from baseline storage
   rewards and retrieval fee settlement.
4. Reports expose tier counts, average latency, Fail-tier share, performance
   reward paid, provider latency distribution, and a performance-tier graph.
5. `tools/policy_sim/sweeps/performance_market_latency_controls.yaml` compares
   latency tier windows, slow-provider tails, jitter, route-attempt limits,
   high-bandwidth routing, and reward multipliers before keeper/runtime QoS
   defaults are chosen.
6. The missing live surfaces are service-class params, latency telemetry
   accumulation, tiered reward multipliers, and explicit policy that slow QoS
   evidence is not slashable hard-fault evidence.

## 22. Elasticity and Overflow Scaling

The spec describes user-funded elasticity and saturation signaling. Current
keeper work persists funded overlay route state and exposes it through deal
queries, but striped overlay elasticity is not yet fully modeled end-to-end.
The implementation roadmap should explicitly include the remaining runtime
semantics.

Desired behavior:

1. Assigned provider signals saturation or gateway observes sustained pressure.
2. Chain checks the user's max spend window and escrow.
3. Chain selects additional providers or overlay slots deterministically.
4. New providers receive data through protocol repair/replication sessions.
5. Routing expands to include new capacity once ready.
6. Rewards and accountability include overlay providers without weakening the
   base `K`-of-`N` invariant.

Open design choices:

1. Whether overlays are per slot, per deal, or per hot object/range.
2. Whether overlay providers are accountable for full slot shards or cached
   hot ranges only.
3. How synthetic challenges target overlay replicas.
4. How overlay providers are paid and demoted.
5. How user-funded elasticity interacts with base storage escrow.

Simulation requirements:

1. Model demand spikes and provider saturation.
2. Model cost and benefit of adding overlay/high-bandwidth providers.
3. Measure time to absorb traffic surge.
4. Measure whether elasticity causes provider concentration.
5. Verify spend-window caps prevent unbounded user cost.
6. Verify sponsored public retrievals do not drain owner escrow.
7. Verify scale-up and scale-down hysteresis prevents oscillation.
8. Verify overlay providers become accountable for the service they are paid to
   provide.

Economic invariants:

1. A scaling event must fail closed if `Deal.escrow_balance` or
   `Deal.max_monthly_spend` cannot pay for it.
2. Scaling should add capacity only for a minimum TTL long enough to amortize
   replication cost.
3. Overlay providers must not dilute accountability for base slots.
4. Elasticity should degrade into rate limiting when unfunded, not into
   unbounded protocol subsidy.

Current simulator coverage:

1. `tools/policy_sim/scenarios/elasticity_overlay_scaleup.yaml` models funded
   hot-demand overflow capacity.
2. Overlay routes activate only after the retrieval trigger, wait for readiness,
   serve reads as temporary routes, and expire by TTL.
3. Overlay providers do not become durable base slots, and corrupt overlay
   responses produce evidence without automatically repairing base slots.
4. Reports expose overlay activations, ready routes, active routes, serves,
   expirations, rejections, and spend.
5. `tools/policy_sim/sweeps/elasticity_overlay_controls.yaml` compares
   readiness delay, TTL, spend cap, per-deal route cap, and aggressive scale-up
   variants before keeper/runtime defaults are chosen.

## 23. Chain and Consensus Implementation Scope

The chain is responsible for deterministic state transitions and economic
accounting. Full implementation likely requires the following additions or
hardening beyond current devnet behavior.

### 23.1 State

Potential state additions:

1. `ProviderLifecycleState(provider)`.
2. `ProviderHealthState(provider, epoch_window)`.
3. `ProviderCapabilityScore(provider)` or explicit capability tiers.
4. `SlotHealthState(deal_id, slot)`.
5. `SlotRepairAttempt(deal_id, slot, window)`.
6. `RepairReadinessProof(deal_id, slot, pending_provider, gen)`.
7. `EvidenceCase(evidence_id)`.
8. `NonResponseAccumulator(provider, deal_id, slot, window)`.
9. `ProviderBondState(provider)`.
10. `AssignmentCollateral(provider, deal_id, slot)`.
11. `ProviderJailState(provider)`.
12. Overlay or elasticity state for high-demand deals.
13. `DynamicPricingState(epoch)`.
14. `TotalActiveSlotBytes` accumulator.
15. `RetrievalDemandState(epoch)`.
16. `RewardPoolState(epoch)`.
17. `AuditBudgetState(epoch)`.
18. `DealSpendWindow(deal_id)`.
19. `SponsoredSessionFunding(session_id)`.
20. `ProviderPayoutLedger(provider, epoch)`.

### 23.2 Params

Likely params:

1. Hot/cold missed-epoch thresholds.
2. Non-response threshold and window.
3. Repair cooldown and attempt caps.
4. Jail durations by evidence class.
5. Slash bps by hard-fault class.
6. Minimum provider bond and assignment collateral formula.
7. Probation assignment caps.
8. High-bandwidth promotion thresholds.
9. Performance tier windows and multipliers.
10. Audit budget sizing and carryover.
11. Evidence bond, bounty, and burn-on-expiry.
12. Overlay elasticity spend and churn caps.
13. Dynamic pricing enablement, min/max bounds, targets, and max step bps.
14. Base reward start bps, tail bps, halving interval, and start height.
15. Retrieval burn bps and base fee defaults.
16. Storage and retrieval affordability floors for devnet/testnet launch.
17. Assignment collateral formula and bond months.

### 23.3 Messages

Likely messages:

1. `MsgSubmitEvidence` for non-response, wrong data, or deputy transcripts.
2. `MsgSubmitRepairReadiness` for pending provider catch-up proof.
3. `MsgStartSlotRepair` / `MsgCompleteSlotRepair` hardening, or automatic
   epoch-hook variants.
4. `MsgSetProviderMaintenance` distinct from full draining.
5. `MsgRequestSlotExit` convenience path for voluntary provider exit.
6. `MsgSignalSaturation` hardening for Mode 2 overlay elasticity.
7. `MsgUpdateProviderBond` or staking integration.
8. `MsgUpdateProviderCapabilities` or capability attestation.
9. `MsgOpenRetrievalSessionSponsored` for requester-funded public retrieval.
10. `MsgOpenProtocolRetrievalSession` for audit, repair, and healing.
11. `MsgCloseDeal` or explicit expiry/escrow-close path.
12. Governance or authority-gated `MsgUpdateMarketParams`.

### 23.4 Queries and Events

Queries/events should make the system explainable:

1. Provider lifecycle state and reason.
2. Provider health summary.
3. Slot health and current repair status.
4. Pending provider and repair target generation.
5. Evidence case status.
6. Repair attempt history.
7. Audit debt by provider/slot.
8. Reward eligibility and exclusion reason.
9. Jail/slash history.
10. Elasticity overlays and spend-window usage.
11. Current storage and retrieval price with prior-epoch deltas.
12. Storage utilization and retrieval demand inputs used by pricing.
13. Base reward pool minted, paid, and burned by epoch.
14. Audit budget minted, spent, carried over, and exhausted by epoch.
15. Provider revenue, slash, burn, and reward-exclusion summaries.

## 24. Provider-Daemon Implementation Scope

The provider-daemon should remain a dumb byte pipe for file semantics, but it
must be policy-aware for accountability and repair.

Required capabilities:

1. Serve bytes only for valid sessions, including protocol audit/repair
   sessions.
2. Return structured error classes: timeout, unavailable, not found,
   unauthorized session, stale manifest root, invalid range, internal error.
3. Store and serve Mode 2 slot shards by `(deal_id, mdu_index, slot,
   manifest_root)`.
4. Support repair catch-up fetches and writes.
5. Generate or help produce readiness proofs for repaired shards.
6. Report local health, storage headroom, endpoint version, and capability.
7. Expose controlled benchmark/probe endpoints or use normal session paths for
   promotion tests.
8. Implement safe staged-generation cleanup.
9. Support operator maintenance mode separately from draining.
10. Provide deterministic fault-injection switches for test/devnet e2e.

Provider-daemon tests should cover:

1. Session-required serving.
2. Range and slot confinement.
3. Corrupt/missing shard behavior.
4. Protocol repair catch-up.
5. Restart durability during sessions and repairs.
6. Staged upload cleanup.
7. Health and capability reporting.

## 25. User-Gateway and Router Implementation Scope

The user-gateway/router is the main availability-preserving component for many
users. It should not be trusted for correctness, but it should be smart about
routing and recovery.

Required capabilities:

1. Resolve deal slot topology and provider endpoint metadata.
2. Choose any `K` healthy `ACTIVE` slots for reads.
3. Route around `REPAIRING`, jailed, draining, degraded, or unreachable slots
   where possible.
4. Use structured retry policies with bounded attempts.
5. Classify provider errors into the failure taxonomy.
6. Trigger setup bump flows for setup-phase slot upload failure.
7. Surface slot-specific upload errors instead of generic upload failure.
8. Preserve session binding and blob-range subset rules.
9. Provide fallback from direct provider to gateway/proxy/deputy paths.
10. Record metrics for route source, provider served, latency, failure class,
    and proof validity.

Gateway tests should cover:

1. No session means no bytes.
2. `K`-of-`N` route selection under failures.
3. Provider corruption does not result in accepted data.
4. Setup bump and retry for one failed slot.
5. Repairing slot route-around.
6. Endpoint discovery and stale provider metadata.
7. Fault-classification determinism.

## 26. Client and Website UX Scope

The website should not hide degraded behavior. It should make the network state
understandable without overwhelming normal users.

Required user-facing surfaces:

1. Deal slot map: provider, status, endpoint, route health.
2. Retrieval route: which provider/slot served the data.
3. Degraded-read explanation: "provider X unavailable, reconstructed from K
   other slots."
4. Repair status: old provider, pending provider, repair generation, progress.
5. Setup failure recovery: slot-specific bump-and-retry flow.
6. Provider dashboard: health, assignment count, quota status, rewards, missed
   epochs, audit tasks.
7. High-bandwidth/probation status for provider operators.
8. Warning surfaces before punitive consequences become active.

UX tests should cover:

1. User can complete upload when one setup slot fails and is bumped.
2. User can download while one slot is repairing.
3. Provider operator can see why they are degraded or ineligible.
4. UI labels distinguish `user-gateway` and `provider-daemon` terminology.

## 27. Simulation Program Expansion

The current `tools/policy_sim` is a seed. It should become a policy workbench.

The current active goal is to complete the simulator workbench before starting
new punitive chain-policy implementation. Chain and e2e work should consume
simulator outputs, not race ahead of them.

### 27.0 Active Simulator Scope

For the next engineering milestone, prioritize:

1. Turn CLI-only scenarios into versioned scenario fixtures.
2. Define stable output schemas for metrics and ledgers.
3. Add deterministic assertion presets for each canonical scenario.
4. Add provider/slot lifecycle ledgers so policy outcomes are explainable.
5. Add the first economic ledgers: escrow, retrieval settlement, reward pool,
   audit budget, provider P&L, and elasticity spend.
6. Add simulated enforcement modes for measure-only, repair-only, reward
   exclusion, jail, slash, dynamic pricing, and elasticity rejection.
7. Add a separate report tool that consumes simulator outputs and generates
   human-readable summaries, charts, comparisons, and graduation analysis.
8. Add scenario comparison reports for parameter changes.
9. Produce a graduation map from simulator scenario to keeper/e2e test target.

### 27.1 Model Dimensions

The simulator should model:

1. Providers with capacity, bandwidth, latency, bond, uptime, region, operator,
   lifecycle state, and fault behavior.
2. Users with retrieval demand, write demand, public/private access patterns,
   and spend budgets.
3. Deals with service class, size, RS profile, heat, expiry, escrow, and
   elasticity settings.
4. Slots with health, evidence, missed epochs, repair state, pending provider,
   and assignment history.
5. Network conditions such as regional outage, latency spikes, and correlated
   failures.
6. Adversaries such as corrupt providers, withholding providers, lazy
   providers, Sybil operators, replacement grinders, and evidence spammers.
7. Market state such as storage utilization, retrieval demand, storage price,
   retrieval price, reward pools, burns, and audit budget.
8. Provider economics such as storage cost, bandwidth cost, fixed operator
   cost, bond opportunity cost, revenue, slashing, and churn threshold.
9. User economics such as escrow balance, spend windows, retrieval budget,
   sponsored-session demand, top-up behavior, and willingness to pay.

### 27.2 Scenario DSL

The simulator should support scenario files, not only CLI flags:

```yaml
name: hot-deal-provider-delinquency
seed: 42
providers: 200
users: 1000
deals:
  count: 120
  service_mix:
    hot: 0.20
    general: 0.60
    cold: 0.20
faults:
  - kind: offline
    provider_selector: tier:high_bandwidth
    epochs: 8-12
  - kind: withhold
    provider: sp-014
    rate: 1.0
assertions:
  min_success_rate: 0.995
  max_false_repair_rate: 0.01
  max_corrupt_bytes_paid: 0
```

### 27.3 Outputs

The simulator should emit stable machine-readable outputs. A separate reporting
tool should consume those outputs and generate human-facing assets. This keeps
simulation deterministic and lightweight while allowing richer analysis,
graphs, and reports to evolve independently.

Simulator raw outputs:

1. Per-epoch JSON and CSV metrics.
2. Per-provider summary.
3. Per-slot repair history.
4. Evidence and consequence ledger.
5. Economy ledger.
6. Assertion results.
7. No precomputed baseline-vs-candidate deltas; simulator outputs are
   single-run artifacts only.

Report-tool outputs:

1. Run summary report.
2. Scenario comparison report for changed policy parameters, computed by the
   report tool from separate baseline and candidate run directories.
3. Price trajectory and convergence report.
4. Provider P&L and churn report.
5. Fee, burn, mint, reward, and audit-budget accounting report.
6. Escrow runway and elasticity-spend report.
7. Graduation-readiness report for keeper/e2e tests.

### 27.4 Simulator Tests

The simulator itself needs tests:

1. Determinism for fixed seeds.
2. Scenario parser tests.
3. Assertion failure tests.
4. Candidate selection determinism.
5. Repair/promotion state machine tests.
6. Credit/quota accounting tests.
7. Regression fixtures for canonical scenarios.
8. Dynamic pricing convergence and step-clamp tests.
9. Reward pool mint/pay/burn accounting tests.
10. Sponsored retrieval and owner-escrow isolation tests.
11. Provider P&L and churn-threshold tests.

### 27.5 Simulator Milestone Plan

The simulator should be developed in staged slices. Each slice should leave the
repository with passing tests and useful outputs.

| Stage | Name | Deliverables | Exit criteria |
|---|---|---|---|
| S0 | Planning contract | Final scenario list, metric names, assertion names, output file schema, fixture directory layout. | A future agent can add a scenario without inventing new conventions. |
| S1 | Fixture runner | Scenario parser, fixture discovery, seeded run command, JSON/CSV output paths, assertion runner. | Existing ideal/outage/corrupt/withholding scenarios run from fixtures. |
| S2 | Reliability ledgers | Per-provider summary, per-slot history, evidence ledger, repair ledger, reward eligibility ledger. | Every repair, miss, hard fault, and reward exclusion has a reason in output. |
| S3 | Economic ledgers | Escrow ledger, retrieval settlement ledger, base reward ledger, audit budget ledger, provider P&L ledger. | Economic scenarios can assert fee, burn, mint, payout, and provider-profit outcomes. |
| S4 | Simulated enforcement modes | Scenario-level consequences for measure-only, repair-only, reward exclusion, jail, slash, dynamic pricing, and elasticity rejection. | Live rollout modes have simulator evidence before keeper or runtime enablement. |
| S5 | Reporting assets | Markdown reports, charts, risk summaries, and analysis bundles generated from raw simulator outputs. | Humans can review a run without reading raw CSV/JSON. |
| S6 | Parameter comparison | Baseline vs candidate report, sensitivity sweeps, metric delta summaries. | A policy parameter change can be evaluated before keeper work begins. |
| S7 | Graduation report | Scenario-to-chain/e2e mapping, missing implementation surfaces, recommended next keeper tests. | The team can choose the next keeper test slice from simulator evidence. |

S6 must include population-scale dynamics, not only small fixed fixtures. The
required scale/sensitivity work is:

1. Run seeded scenarios with more than 1,000 SPs and thousands of data users.
2. Model provider heterogeneity: region, capacity, bandwidth, reliability,
   storage cost, bandwidth cost, and repair/catch-up probability.
3. Model correlated failures: regional outages, partial fleet degradation, and
   provider-class failures.
4. Model healing throughput: repair-start caps, replacement capacity, and
   catch-up probability so detection can outrun healing in bad cases.
5. Track network-state trajectories: active slots, repairing slots, storage
   utilization, retrieval success rate, bandwidth saturation, price, burn/mint,
   provider P&L, churn risk, and repair backlog.
6. Generate reports that explain not only "did the assertion pass", but how the
   network state moved under stress and whether the policy recovered.

### 27.6 Scenario Fixture Inventory

Start with these fixture files under `tools/policy_sim/scenarios/`:

| Fixture | Purpose | Required assertions |
|---|---|---|
| `ideal.yaml` | Cooperative baseline. | Full retrieval success, no repairs, no quota misses, no bad payouts. |
| `single_outage.yaml` | One provider offline for several epochs. | Reads remain available, repair starts after threshold, no slash. |
| `withholding.yaml` | Provider refuses retrievals and synthetic participation. | Route-around succeeds where possible, deputy/audit misses accrue, repair starts. |
| `corrupt_provider.yaml` | Provider returns corrupt data or invalid proofs. | Corrupt bytes are unpaid, hard fault is recorded, repair starts. |
| `invalid_synthetic_proof.yaml` | Provider submits invalid synthetic/liveness proofs without corrupting retrieval bytes. | Invalid proofs are recorded, repair starts and completes, simulated slash accounting is visible, and corrupt byte payment remains zero. |
| `lazy_provider.yaml` | Provider does not meet proof quota. | Reward exclusion occurs, soft-fault path does not slash. |
| `setup_failure.yaml` | Initial upload to one slot fails. | Setup bump is bounded and replacement is system-selected. |
| `staged_upload_grief.yaml` | User-gateway or client uploads provisional generations and never commits them. | Pending staged generations remain capped, preflight rejections and retention cleanup are visible, and committed data availability is unaffected. |
| `repair_candidate_exhaustion.yaml` | Replacement capacity is unavailable or saturated. | Repair backoffs and candidate-exclusion reasons are visible, provider capacity is not over-assigned, and data-loss events remain zero. |
| `replacement_grinding.yaml` | Pending replacement providers fail to prove readiness before promotion. | Repair readiness timeouts, cooldowns, and attempt caps are visible; no pending provider is promoted without readiness; data-loss events remain zero. |
| `underpriced_storage.yaml` | Storage price below provider cost. | Provider P&L turns negative and churn pressure is visible. |
| `overpriced_storage.yaml` | Storage price above modeled user willingness to pay. | Existing reads remain healthy while new deal demand is rejected by price, not capacity. |
| `demand_elasticity_recovery.yaml` | Latent storage demand is suppressed by high price and recovers as dynamic pricing moves down. | Suppressed demand, recovered effective requests, accepted deals, bounded final price, and no capacity rejection. |
| `provider_cost_shock.yaml` | Provider operating costs jump after launch while technical availability remains healthy. | Cost-shock windows are visible, provider P&L turns negative, churn pressure appears, and no availability or durability loss occurs. |
| `provider_economic_churn.yaml` | Sustained negative provider economics causes bounded active-set exits. | Churn events are capped per epoch, exited capacity is visible, affected slots are repaired, reads remain available, and no data-loss events occur. |
| `provider_supply_entry.yaml` | Reserve providers enter after supply pressure, serve probation, then promote into active assignment capacity. | Churn remains bounded, provider entries and probation promotions are visible, entered providers become active, repair completes, and data-loss events remain zero. |
| `provider_bond_headroom.yaml` | Hard-fault slashing leaves a provider below minimum/per-slot collateral. | Underbonded providers are visible, new assignments exclude insufficient bond headroom, active underbonded slots repair away, and data-loss events remain zero. |
| `retrieval_demand_shock.yaml` | Temporary read-demand spike tests retrieval-price response and oscillation bounds. | Retrieval shock windows are visible, price direction changes stay bounded, reads remain available, and price remains within configured limits. |
| `wash_retrieval.yaml` | Fake reads attempt to farm rewards or credits. | Burns/fees/caps make the strategy negative expected value. |
| `viral_public_retrieval.yaml` | Public content receives a demand spike. | Sponsored sessions pay retrieval cost, sponsor spend is visible, and owner escrow remains stable. |
| `storage_escrow_close_refund.yaml` | Committed storage locks escrow, earns provider storage fees, then closes a subset of deals early. | Locked, earned, refunded, outstanding, provider-payout, burned storage-fee, and post-close rejection values are visible; outstanding escrow reaches zero by run end. |
| `storage_escrow_noncompliance_burn.yaml` | A lazy provider misses quota while committed storage escrow continues earning. | Non-compliant slot share is burned instead of paid, compliant providers still receive earned fees, repairs start, and reads remain available. |
| `storage_escrow_expiry.yaml` | Committed storage reaches its configured duration. | Deals expire automatically after fully earning escrow, final open deals reach zero, and no hidden outstanding escrow remains. |
| `closed_retrieval_rejection.yaml` | Committed storage is intentionally closed and later read attempts target inactive content. | Post-close reads are counted as closed-content rejections, unavailable reads stay zero, owner retrieval escrow is not debited, and unearned storage escrow is refunded. |
| `expired_retrieval_rejection.yaml` | Committed storage reaches duration end and later read attempts target inactive content. | Post-expiry reads are counted as expired-content rejections, unavailable reads stay zero, owner retrieval escrow is not debited, and no hidden storage escrow remains. |
| `elasticity_cap_hit.yaml` | Demand exceeds user spend cap. | Scaling fails closed and rate-limit state is emitted. |
| `elasticity_overlay_scaleup.yaml` | Sustained hot retrieval demand buys temporary overflow routes. | Overlay activations, serves, and TTL expirations are visible; spend caps are respected and durability is unaffected. |
| `high_bandwidth_promotion.yaml` | Hot retrieval demand is routed across heterogeneous providers after measured high-bandwidth promotion. | Providers promote only after success/capacity/saturation checks, hot traffic uses promoted providers, no demotion or over-capacity assignment occurs. |
| `high_bandwidth_regression.yaml` | Promoted high-bandwidth providers experience sustained saturation under concentrated hot routing. | Demotion occurs, hot retrievals continue, capacity remains respected, and data-loss events stay zero. |
| `large_scale_regional_stress.yaml` | More than 1,000 heterogeneous SPs and thousands of users experience a correlated regional outage, bandwidth saturation, dynamic pricing, and constrained repair coordination. | Availability remains above floor, saturation and repair backoffs are visible, price remains bounded, and no provider is assigned beyond modeled capacity. |

Current S6 sweep specs include `tools/policy_sim/sweeps/sponsored_retrieval_funding.yaml`,
which compares full, partial, and absent sponsored-session funding so owner
escrow-drain risk is visible before keeper defaults are chosen;
`tools/policy_sim/sweeps/storage_escrow_close_refund.yaml`, which compares
full-duration service, early close timing, close count, close-by-bps storage
escrow outcomes, and post-close rejection counts;
`tools/policy_sim/sweeps/storage_escrow_noncompliance_modes.yaml`, which
compares measure-only, repair-only, and reward-exclusion treatment for earned
storage-fee payout and burn behavior;
`tools/policy_sim/sweeps/audit_budget_controls.yaml`, which compares
miss-driven audit demand against tight, moderate, clearing, reserve, high-cost,
and low-cost budget assumptions before keeper audit-budget defaults are chosen;
`tools/policy_sim/sweeps/operator_concentration_controls.yaml`, which
compares per-deal operator caps, disabled caps, dominant-operator share, and
operator-count assumptions before placement-diversity defaults are chosen;
`tools/policy_sim/sweeps/staged_upload_controls.yaml`, which compares
retention TTL, pending-generation caps, no-cap behavior, and partial commit
pressure before provider-daemon staged-generation cleanup defaults are chosen;
and `tools/policy_sim/sweeps/replacement_grinding_controls.yaml`, which
compares pending-provider readiness timeout, repair cooldown, and per-slot
attempt-cap assumptions before keeper replacement retry defaults are chosen;
and `tools/policy_sim/sweeps/repair_candidate_exhaustion_controls.yaml`,
which compares replacement capacity, attempt caps, and cooldowns before
candidate-selection fallback and capacity-guard defaults are chosen; and
`tools/policy_sim/sweeps/performance_market_latency_controls.yaml`, which
compares Hot-service latency tier windows, reward multipliers, slow-provider
tails, jitter, route attempts, and high-bandwidth routing before QoS reward and
placement-priority defaults are chosen; and
`tools/policy_sim/sweeps/provider_bond_headroom_controls.yaml`, which compares
minimum bond, per-slot collateral, initial bond, and hard-fault slash sizing
before collateral and underbonded-repair defaults are chosen; and
`tools/policy_sim/sweeps/provider_cost_shock_controls.yaml`, which compares
cost-shock severity, bandwidth-heavy demand, reward-buffer sizing, and
dynamic-pricing response speed before storage-price floors, issuance buffers,
or provider-cost telemetry assumptions are promoted into keeper work; and
`tools/policy_sim/sweeps/provider_supply_entry_controls.yaml`, which compares
reserve-provider entry caps, probation length, trigger timing, and underfilled
reserve recovery before provider lifecycle-state and new-supply promotion
semantics are chosen; and
`tools/policy_sim/sweeps/evidence_spam_economics.yaml`, which compares deputy
evidence-spam claim volume, bond size, conviction rate, and bounty sizing so
unconvicted spam remains negative-EV, zero-bond spam is surfaced as unsafe, and
profitable bounty farming is visible before evidence-market keeper defaults are
chosen; and `tools/policy_sim/sweeps/wash_retrieval_economics.yaml`, which
compares requester-funded retrieval sessions, owner-funded variable debits,
retrieval burn rates, base fees, and wash-traffic volume so fake reads cannot
profitably recycle provider payouts before retrieval-accounting defaults are
chosen; and `tools/policy_sim/sweeps/retrieval_demand_shock_controls.yaml`,
which compares retrieval-demand shock magnitude, duration, target, price-step
size, ceiling, and disabled-controller behavior before retrieval price response
and smoothing defaults are chosen; and
`tools/policy_sim/sweeps/storage_demand_elasticity_controls.yaml`, which
compares storage-demand elasticity, reference price, minimum demand floor,
price-step speed, and disabled-controller behavior before storage price
recovery defaults are chosen; and
`tools/policy_sim/sweeps/elasticity_cap_hit_controls.yaml`, which compares
non-overlay elasticity spend caps, overflow cost, trigger thresholds, and viral
retrieval pressure so user-funded elasticity fails closed instead of creating
unbounded spend; and
`tools/policy_sim/sweeps/storage_escrow_expiry_controls.yaml`, which compares
expiry duration, run length, disabled-expiry behavior, and larger escrow books
so committed storage expires when fully mature, immature deals remain visibly
open with outstanding escrow, and missing expiry enforcement is surfaced before
keeper expiry semantics are chosen; and
`tools/policy_sim/sweeps/expired_retrieval_rejection_controls.yaml` plus
`tools/policy_sim/sweeps/closed_retrieval_rejection_controls.yaml`, which
compare inactive-content retrieval timing, no-bill owner-escrow guards,
partial close behavior, refund accounting, and larger read demand so expired
and intentionally closed content fail explicitly instead of becoming live
availability failures or billable retrieval sessions; and
`tools/policy_sim/sweeps/subsidy_farming_economics.yaml`, which compares
reward-exclusion, repair-only, and measure-only enforcement against lazy
providers, higher lazy share, delayed eviction, and subsidy size so base
rewards do not leak to quota-missing responsibility before reward-eligibility
keeper defaults are chosen; and
`tools/policy_sim/sweeps/underpriced_storage_economics.yaml` plus
`tools/policy_sim/sweeps/overpriced_storage_affordability.yaml`, which compare
provider P&L under storage underpricing, user-funded storage fee floors,
reward/retrieval buffers, willingness-to-pay ceilings, dynamic price movement,
and capacity-limited acceptance before storage quote and price-floor defaults
are chosen; and `tools/policy_sim/sweeps/flapping_provider_thresholds.yaml`
plus `tools/policy_sim/sweeps/sustained_non_response_thresholds.yaml`, which
compare intermittent outage thresholds, repair-churn risk, sustained
non-response repair timing, and repair-readiness timeouts before liveness
threshold defaults are chosen; and
`tools/policy_sim/sweeps/setup_failure_repair_controls.yaml`, which compares
early setup-phase provider failure across measure-only, repair-only,
threshold-delay, multi-provider, and repair-throughput-constrained cases before
provider admission, initial health check, and setup-bump keeper semantics are
chosen; and
`tools/policy_sim/sweeps/withholding_enforcement_controls.yaml` plus
`tools/policy_sim/sweeps/lazy_provider_quota_controls.yaml`, which compare
soft-failure evidence across measure-only, repair-only, reward-exclusion,
threshold-delay, multi-provider, and repair-throughput-constrained cases while
asserting that soft evidence does not slash provider bond or pay corrupt bytes;
and
`tools/policy_sim/sweeps/corrupt_provider_enforcement_controls.yaml` plus
`tools/policy_sim/sweeps/invalid_synthetic_proof_enforcement_controls.yaml`,
which compare hard-fault behavior across measure-only, repair-only, jail, and
slash-simulated modes, slash sizing, multi-provider abuse, and repair
throughput limits before punitive keeper enforcement defaults are chosen.

Current storage-escrow coverage includes
`tools/policy_sim/scenarios/storage_escrow_close_refund.yaml`, which models
upfront lock-in, per-epoch earned storage fees, provider payout, early
close/refund, and run-end outstanding escrow before keeper close/refund
semantics are chosen. The paired sweep keeps the production question concrete:
human review should decide exact keeper rounding, expiry auto-close, and
quote-signing semantics only after looking at how earned/refunded/outstanding
balances move under close timing and close fraction.
`tools/policy_sim/scenarios/storage_escrow_noncompliance_burn.yaml` covers the
adjacent enforcement question: when responsibility is delinquent under
reward-exclusion semantics, earned storage-fee share should be burned rather
than paid while the storage lock-in ledger remains balanced.
`tools/policy_sim/scenarios/storage_escrow_expiry.yaml` covers duration-end
auto-expiry: fully earned deals should leave the active set and leave no
outstanding escrow before keeper expiry/GC semantics are implemented.
`tools/policy_sim/scenarios/closed_retrieval_rejection.yaml` and
`tools/policy_sim/scenarios/expired_retrieval_rejection.yaml` cover inactive
content retrieval semantics: after close or expiry, reads should be rejected as
closed or expired content rather than counted as live availability failures or
billable retrieval sessions.

### 27.7 Output Contract

Each simulator run should be able to emit:

1. `summary.json`: config, seed, assertion results, and top-level metrics.
2. `epochs.csv`: one row per epoch with reliability and economic metrics.
3. `providers.csv`: one row per provider with health, assignment, reward,
   payout, P&L, and churn-risk metrics.
4. `slots.csv`: one row per deal-slot with lifecycle, health reason, repair,
   provider, and reward eligibility state.
5. `evidence.csv`: hard faults, soft faults, threshold evidence, and source.
6. `repairs.csv`: repair start, candidate selection, catch-up, readiness
   timeout, promotion, attempt-count, cooldown, candidate-exclusion,
   attempt-cap, and backoff events.
7. `economy.csv`: storage charges, retrieval burns, payouts, reward mint/burn,
   audit budget, escrow runway, elasticity spend, and latent/effective storage
   demand admission.
8. No `comparison.json` or other precomputed baseline-vs-candidate artifact in
   single-run simulator outputs.

Schema stability matters. Once S1 lands, any schema change should update tests
and a small fixture expectation.

The report tool should read only these raw outputs. It should not rerun the
simulation, mutate fixtures, or invent hidden metrics that are not present in
the machine-readable artifacts.

### 27.7.1 Report Tool Contract

Add `tools/policy_sim/report.py` as a separate reporting layer.

Inputs:

1. A single run output directory containing `summary.json` and CSV ledgers.
2. Optionally, a baseline run directory and a candidate run directory for
   comparison mode; the report tool computes deltas from those two directories.
3. Optionally, a sweep directory containing many run outputs.

Outputs:

1. `report.md`: narrative summary of the scenario, seed, pass/fail state,
   important metrics, and notable events.
2. `graphs/`: static charts generated from raw outputs. The initial contract is
   stdlib-only SVG written directly by the report tool, so every report bundle
   emits at least the canonical minimal SVG set without optional dependencies.
3. `policy_delta.md`: baseline-vs-candidate comparison for changed params.
4. `risk_register.md`: failed assertions, unstable metrics, cap hits,
   concentration risks, and open review items.
5. `graduation.md`: recommended keeper/e2e graduation targets and missing
   implementation surfaces.
6. `signals.json`: derived diagnostic signals for availability cliffs, recovery
   epoch, saturation rate, repair backlog, capacity utilization percentiles,
   price movement, regional concentration, and bottleneck providers.
7. `sweep_summary.md` and `sweep_summary.json`: parameter-sweep or
   regression-suite summaries with run matrices, varied parameters,
   metric ranges, high-risk runs, and human review questions.
8. `graduation_map.md` and `graduation_map.json`: corpus-level mapping from
   scenario evidence to keeper tests, gateway/provider tests, e2e posture,
   missing implementation surfaces, and further simulation review.

Sweep specs should be versioned under `tools/policy_sim/sweeps`. Each sweep
should name a base scenario fixture and a small matrix of parameter overrides.
The raw per-case ledgers should remain local/CI artifacts, while committed
reports under `docs/simulation-reports/policy-sim/sweeps` should contain only
the sweep summary, machine-readable summary, and manifest.

The first report implementation must be stdlib-only and Markdown/CSV focused.
Graph generation starts with SVG written directly by the report tool. Optional
plotting dependencies can add richer assets later, but they must not be required
for the canonical `graphs/` bundle or change the raw simulator output contract.

### 27.7.2 Graph Inventory

The reporting layer should eventually generate:

1. Retrieval success rate by epoch.
2. Active, repairing, and backoff slots by epoch.
3. Quota misses, hard faults, and threshold evidence by epoch.
4. Repair backlog and repair completion latency.
5. Storage price and retrieval price trajectories.
6. Storage utilization and retrieval demand versus targets.
7. Provider P&L distribution and churn-risk bands.
8. Provider concentration and top-N assignment share.
9. Fee-vs-issuance share.
10. Burn/mint ratio.
11. Audit budget minted, spent, exhausted, and carried over.
12. Escrow runway, sponsored-session volume, and elasticity spend.

### 27.7.3 Analysis Modes

The report tool should support:

1. **Single-run analysis:** Did this scenario pass, and why?
2. **Baseline-vs-candidate comparison:** Did a policy change improve or
   regress the target metrics?
3. **Sensitivity sweep:** Which threshold or parameter ranges are stable?
4. **Regression suite summary:** Which canonical scenarios changed
   unexpectedly?
5. **Graduation assessment:** Which simulator behaviors are ready for keeper
   tests or process-level e2e?

### 27.8 Implementation Order

Recommended implementation order:

1. Create fixture loading and preserve current built-in scenario behavior.
2. Add stable output files without changing simulation semantics.
3. Add per-provider and per-slot ledgers.
4. Add scenario assertion presets.
5. Add reliability fixtures and regression tests.
6. Add economic state to the model.
7. Add economic fixtures and regression tests.
8. Add simulated enforcement mode switches and assertions.
9. Add `report.py` with Markdown reports over existing raw outputs.
10. Add graph generation and risk/graduation reports.
11. Add comparison reports and parameter sweeps.
12. Generate the first graduation report for keeper/e2e work.

Do not add new chain enforcement from this roadmap until at least S2 is done
for reliability behavior, S3 is done for economic behavior, and the relevant
S4 simulated enforcement mode passes.

### 27.9 Simulated Enforcement Modes

The simulator should model policy consequences before those consequences are
enabled in live protocol/runtime configuration.

| Mode | Simulator behavior | Live rollout prerequisite |
|---|---|---|
| `MEASURE_ONLY` | Record fault, evidence, health, and economic impact without changing slot/provider state. | Fixture assertions prove observability and no unintended consequence. |
| `REPAIR_ONLY` | Start setup bump or slot repair when thresholds are crossed, but do not exclude rewards, jail, or slash. | Repair ledgers and route-around assertions pass. |
| `REWARD_EXCLUSION` | Exclude non-compliant or hard-faulted slots from rewards while preserving no-slash behavior for soft faults. | Reward ledger proves bad-provider reward leakage is bounded or zero. |
| `JAIL_SIMULATED` | Mark providers ineligible for new assignments after hard or convicted threshold faults. | Candidate-selection and false-positive assertions pass. |
| `SLASH_SIMULATED` | Apply modeled bond loss only for hard or convicted evidence classes. | False-slash assertions pass and hard-fault evidence is deterministic. |
| `DYNAMIC_PRICING_SIMULATED` | Update prices inside configured bounds and step clamps. | Price convergence and affordability assertions pass. |
| `ELASTICITY_REJECTION_SIMULATED` | Reject unfunded scaling and emit rate-limit state when escrow or spend caps bind. | Viral-demand and cap-hit assertions pass. |

Naming should make the distinction explicit: simulator modes use `_SIMULATED`
for punitive or market-changing consequences, while live launch configs use
separate protocol/runtime params.

## 28. Code Implementation Workstreams

This program should be split into workstreams that can land independently.

| Workstream | Goal | Primary code |
|---|---|---|
| Policy simulator | Make policy measurable before consensus hardening. | `tools/policy_sim` |
| Chain health state | Add provider/slot health and evidence state. | `polystorechain/x/polystorechain/keeper` |
| Automatic repair | Automate delinquency to repair to promotion. | Chain keeper, provider-daemon, gateway |
| Provider lifecycle | Track readiness, probation, promotion, demotion, jail, exit. | Chain keeper, provider admin, website |
| High-bandwidth promotion | Measure and promote capable SPs for hot/overflow work. | Simulator fixture and reports now exist; next surfaces are chain params/state and gateway probes |
| Evidence/deputies | Add threshold evidence and incentives. | Chain keeper, gateway/provider proof paths |
| Bonding/slashing | Make penalties economically meaningful. | Chain keeper/bank/staking integration |
| Elasticity overlays | Add user-funded overflow capacity. | Chain state, gateway routing, provider storage |
| Market simulator | Model price, demand, supply, provider P&L, burn/mint, and elasticity convergence. | `tools/policy_sim`, future economics reports |
| Reporting and analysis | Turn simulator outputs into summaries, graphs, risk reports, comparisons, and graduation recommendations. | `tools/policy_sim/report.py`, generated artifacts |
| Pricing and escrow | Implement storage lock-in, retrieval settlement, sponsored sessions, spend windows, and close/refund semantics. | Chain keeper, EVM bridge, website quoting |
| Rewards and audit funding | Implement base rewards, compliance gating, reward burns, audit budget, and protocol session funding. | Chain keeper, epoch hooks |
| Observability | Explain state and consequences. | Queries, events, website, dashboards |
| E2E harness | Prove real-stack behavior for critical scenarios. | `scripts/e2e_*`, Playwright, provider fault modes |

The first implementation ticket seed is tracked in
[`POLICY_SIM_IMPLEMENTATION_TICKETS.md`](POLICY_SIM_IMPLEMENTATION_TICKETS.md).
It converts the graduation map and sweep evidence into keeper, gateway,
provider-daemon, and e2e PR slices. Treat that file as the bridge from
simulation evidence to implementation work; keep the roadmap strategic and keep
individual ticket acceptance criteria in the ticket document.

## 29. End-to-End Test Program

The full system needs layered e2e coverage. The target should be few reliable
tests in CI and richer stress scenarios for nightly/manual runs.

### 29.1 CI-Level E2E

CI should cover:

1. Happy path upload/commit/fetch.
2. Mandatory retrieval session enforcement.
3. Mode 2 striped retrieval with multiple providers.
4. One provider unavailable during retrieval, read succeeds from other slots.
5. One setup slot upload fails, setup bump succeeds, commit succeeds.
6. Quota miss triggers `REPAIRING` in keeper tests, not necessarily full stack.
7. Upload quote matches storage lock-in charge on commit.
8. Retrieval open/complete burns and pays exactly as quoted.
9. Sponsored retrieval does not debit owner deal escrow.
10. Early deal close refunds unearned storage escrow and leaves no hidden
    outstanding balance.
11. Elasticity spend-window rejection is deterministic when cap is exhausted.

### 29.2 Nightly or Manual E2E

Nightly/manual should cover:

1. 12+ provider Mode 2 devnet.
2. Provider-daemon killed mid-retrieval.
3. Provider returns corrupt shard/proof.
4. Withholding provider forces deputy/route-around path.
5. Repair catch-up and pending-provider promotion.
6. Provider draining across multiple deals.
7. High-bandwidth SP promotion and later demotion.
8. Elasticity/overflow under sustained hot-deal demand.
9. Regional/correlated outage simulation.
10. Restart durability during sessions and repairs.
11. Dynamic pricing under storage utilization shock.
12. Dynamic pricing under retrieval demand spike.
13. Audit budget exhaustion and carryover behavior.
14. Provider cost shock causing churn and replacement pressure.
15. Wash-traffic attack with burns, credit caps, and reward accounting enabled.

### 29.3 Fault Injection Requirements

Provider-daemons and gateways need deterministic test hooks:

1. Fail upload for selected `(deal_id, slot)`.
2. Refuse reads for selected slots.
3. Delay reads to simulate latency tiers.
4. Return corrupt bytes for selected shards.
5. Return invalid proof headers.
6. Drop session state on restart only when explicitly configured.
7. Simulate storage full or disk errors.

These hooks must be dev/test-only and disabled by default.

## 30. Observability and Operations

Policing without observability will create opaque operator disputes. The system
needs first-class reason codes and dashboards.

Required event reason codes:

1. `setup_bump_started`
2. `setup_bump_completed`
3. `quota_miss_recorded`
4. `deputy_served_zero_direct`
5. `hard_fault_invalid_proof`
6. `hard_fault_wrong_data`
7. `slot_repair_started`
8. `slot_repair_ready`
9. `slot_repair_completed`
10. `provider_degraded`
11. `provider_delinquent`
12. `provider_jailed`
13. `provider_promoted`
14. `provider_demoted`
15. `provider_draining`
16. `elasticity_overlay_added`
17. `repair_backoff_entered`
18. `storage_price_updated`
19. `retrieval_price_updated`
20. `base_reward_pool_minted`
21. `base_reward_remainder_burned`
22. `audit_budget_minted`
23. `audit_budget_exhausted`
24. `sponsored_session_opened`
25. `elasticity_spend_rejected`
26. `provider_underbonded`
27. `provider_profitability_at_risk`
28. `retrieval_rejected_closed_deal`
29. `retrieval_rejected_expired_deal`

Recommended dashboards:

1. Retrieval success by service class.
2. Provider health by tier and operator.
3. Repair backlog and repair latency.
4. Slots by state.
5. Audit budget minted/spent/carryover.
6. Evidence submissions and conviction ratio.
7. Reward exclusions by reason.
8. Hot-deal saturation and elasticity spend.
9. Provider concentration and Sybil-risk indicators.
10. False positive review queue for trusted devnet.
11. Storage and retrieval price trajectories.
12. Storage utilization vs target utilization.
13. Retrieval demand vs target demand.
14. Fee-vs-issuance share.
15. Burn/mint ratio.
16. Provider revenue, P&L estimates, and churn risk.
17. Escrow runway and sponsored-session volume.
18. Dynamic pricing controller changes by epoch.

## 31. Definition of Done for a Fully Functioning Implementation

The policing milestone is not complete until all of these are true:

1. The simulator covers canonical normal, degraded, malicious, and economic
   grief scenarios with deterministic assertions.
2. Chain keeper tests cover all consensus-state transitions represented in
   those scenarios.
3. Provider-daemon and user-gateway tests cover data-plane behavior and error
   classification.
4. A multi-provider e2e harness proves read availability under at least one
   provider outage and one repair/promotion flow.
5. Setup failure can be recovered without recreating the deal.
6. A delinquent provider can be automatically demoted for an assignment.
7. A replacement provider can catch up and be promoted.
8. New providers can enter probation and be promoted based on measured
   readiness.
9. High-bandwidth providers can be promoted and later demoted based on measured
   service.
10. Reward exclusion works for soft non-compliance.
11. Hard-fault evidence does not pay bad actors and can trigger punitive policy
    when enabled.
12. Soft-fault slashing remains disabled until threshold evidence and
    false-positive monitoring are mature.
13. Operators and users can inspect why a provider or slot changed state.
14. Launch configs can choose measure-only, repair-only, reward-exclusion,
    jail, or slash modes.
15. Storage and retrieval prices converge under modeled demand and supply
    shocks without repeated oscillation.
16. Honest marginal providers can cover modeled storage, bandwidth, fixed, and
    bond costs under the target fee/subsidy mix.
17. Fee-funded revenue becomes the dominant provider income path as issuance
    decays toward tail emission.
18. New or reserve providers pass explicit entry and probation stages before
    normal assignment eligibility, and reports expose reserve, probationary,
    and newly active supply counts.
18. Wash retrieval, subsidy farming, and public-retrieval escrow drain are
    uneconomic in canonical simulations.
19. Audit budget can clear expected protocol audit and repair load without
    unbounded minting.
20. Elasticity either scales demand-funded capacity or fails closed into
    explicit rate limiting when unfunded.

## 32. Expanded Immediate Planning Tasks

Before implementing the next large slice:

1. Decide the canonical provider lifecycle states for devnet and which are only
   derived/query states.
2. Decide the canonical slot lifecycle states beyond `ACTIVE` and `REPAIRING`.
3. Define the first version of `DELINQUENT` for a slot.
4. Define the automatic repair/promotion state machine and readiness proof.
5. Decide whether high-bandwidth promotion is a provider state, capability, or
   score.
6. Define assignment caps for probationary and high-bandwidth providers.
7. Define which consequences are active in trusted devnet:
   measure-only, repair, reward exclusion, jail, slash.
8. Expand `tools/policy_sim` with scenario files and per-provider/per-slot
   outputs.
9. Map each canonical scenario to exact chain, gateway, provider, UI, and e2e
   tests.
10. Decide which process-level e2e tests are CI-grade versus nightly/manual.
11. Decide the first economic scenarios and target metrics:
    underpriced supply, overpriced demand, price oscillation, wash traffic,
    viral retrieval, and subsidy farming.
12. Define provider cost assumptions for devnet/testnet simulation.
13. Decide whether dynamic pricing remains disabled, measure-only, or active
    during trusted devnet.
14. Decide the production escrow close/refund semantics needed before
    fee-dominant equilibrium analysis is meaningful; the simulator now has a
    first-pass lock/earn/refund fixture, but keeper rounding, expiry auto-close,
    and quote-signing semantics still need human approval.

For the current simulator-first milestone, the immediate punch list is:

1. Freeze the S0 planning contract in this document or a linked simulator
   design note.
2. Create `tools/policy_sim/scenarios/` and move current built-in scenarios into
   fixture-backed runs.
3. Define the output schemas listed in §27.7 and add tests that protect them.
4. Implement reliability ledgers before adding new reliability behavior.
5. Implement economic ledgers before attempting dynamic pricing calibration.
6. Add simulated enforcement mode switches before planning live rollout.
7. Add `tools/policy_sim/report.py` after raw outputs are stable enough to
   support report generation.
8. Run the first canonical fixture set and review both raw output quality and
   generated report quality.
9. Update this roadmap with what the simulator reveals before graduating keeper
   tests.

## 33. Financial Market and Self-Calibration

The target network is not only a failure detector. It is a deterministic market
that should continually rebalance storage supply, retrieval demand, protocol
subsidy, audit load, and user-funded elasticity.

### 33.1 Intended Equilibrium

The long-run target is a fee-dominant steady state:

1. Users pay storage lock-in charges when content is committed.
2. Requesters pay retrieval fees through mandatory sessions.
3. Providers earn from successful retrievals and quota-compliant storage
   responsibility.
4. Protocol issuance bootstraps storage supply and liveness, then decays toward
   a bounded tail.
5. Audit and repair are funded by a bounded protocol budget derived from
   notional slot rent.
6. Burns and failed-reward remainders prevent free spam, wash traffic, and
   cartel reward leakage.
7. Elasticity is demand-funded and bounded by escrow and spend windows.

Success means the marginal honest provider can remain profitable without the
network depending indefinitely on large emissions, while users receive
predictable quotes and explicit rate limits when demand exceeds funded capacity.

### 33.2 Market Control Loops

The simulator and keeper tests should treat these loops as first-class:

| Loop | Input signal | Protocol action | Failure to detect |
|---|---|---|---|
| Storage pricing | Active slot bytes vs active provider capacity | Update or recommend `storage_price` within bounds. | Underpriced supply collapse or overpriced demand collapse. |
| Retrieval pricing | Prior-epoch session blob demand | Update or recommend `retrieval_price_per_blob` within bounds. | Spam pressure, unaffordable reads, or burst oscillation. |
| Storage lock-in | New committed bytes and remaining duration | Charge `ceil(storage_price * delta * duration)` into escrow. | Underfunded storage or inconsistent quote/sign behavior. |
| Retrieval settlement | Opened, completed, expired, and canceled sessions | Burn base fee, lock variable fee, pay provider on completion, refund eligible cancels. | Free bytes, owner-escrow drain, unpaid honest service. |
| Base rewards | Storage price and total active slot bytes | Mint bounded reward pool, pay compliant active slots, burn remainder. | Subsidy farming, reward leakage, or provider starvation. |
| Audit budget | Epoch slot rent and audit backlog | Mint bounded audit budget and fund protocol sessions. | Audit debt growth or unbounded protocol subsidy. |
| Elasticity | Saturation and retrieval load EMA | Add overlay capacity only within escrow/spend caps and TTL. | Viral debt, provider concentration, or oscillating overlays. |
| Provider supply | Profitability, health, bond, capacity, and churn | Promote, demote, repair, exclude, or throttle assignments. | Honest churn, Sybil concentration, or over-assignment. |

### 33.3 Economic State to Model

The policy simulator should include at least:

1. Provider cost model: storage cost, bandwidth cost, fixed cost, bond
   opportunity cost, and churn threshold.
2. User demand model: write demand, read demand, public/sponsored reads,
   top-up behavior, and willingness to pay.
3. Supply model: provider capacity, bandwidth, assignment caps, region,
   lifecycle state, and bond headroom.
4. Price controller: utilization target, demand target, min/max bounds, step
   clamp, EMA windows, and enabled/measure-only mode.
5. Escrow model: storage lock-in, retrieval locks, sponsored-session payer
   isolation, spend-window accounting, and deal close/refund semantics.
6. Emission model: base reward start/tail bps, halving interval, reward
   eligibility, and burned remainder.
7. Audit model: audit budget bps, cap bps, carryover, backlog, and fairness.
8. Anti-abuse model: burn cost, evidence bond, deputy bounty, credit caps,
   session uniqueness, and wash-traffic profitability.

### 33.4 Economic Scenarios

The canonical economic scenarios should run alongside reliability scenarios:

| Scenario | Question | Expected assertion |
|---|---|---|
| Underpriced storage | Does provider supply leave when price is below cost? | Honest provider churn rises and capacity drops until price/subsidy changes. |
| Provider supply entry | Does reserve or new supply recover after churn pressure? | Reserve providers enter probation, promote into active supply, and repair can use restored capacity without data loss. |
| Provider bond headroom | Does collateral constrain responsibility after slashing or underfunding? | Underbonded providers are excluded from new assignment and existing underbonded responsibility repairs away. |
| Overpriced storage | Does demand collapse or escrow funding fail? | Deal creation or committed bytes fall below target; quote rejection rises. |
| Storage price shock | Does the controller converge after supply/demand changes? | Price changes stay within step bounds and settle near target utilization. |
| Retrieval demand spike | Does retrieval pricing and elasticity absorb burst demand? | Reads remain paid and attributable; overlays spawn only when funded. |
| Viral public content | Can third-party demand pay without draining owner escrow? | Sponsored sessions carry public retrieval cost; sponsor spend is visible; owner escrow stays stable. |
| Wash retrieval | Can fake reads profit from rewards or credits? | Base burns, variable burns, and credit caps make the strategy negative EV. |
| Subsidy farming | Can inactive providers farm emissions from slot responsibility? | Non-compliant slots earn zero or insufficient rewards; remainders burn. |
| Audit budget exhaustion | Does protocol audit load exceed funding? | Backlog and alerts grow, but minting remains capped. |
| Cost shock | What if bandwidth or storage costs double? | Provider P&L and churn reflect pressure before availability collapses. |
| Elasticity cap hit | What if demand exceeds budget? | Scaling fails closed and route/rate-limit state is visible. |

### 33.5 Implementation Integration

The economic implementation should be staged:

1. **Measure-only accounting:** expose prices, charges, rewards, burns, and
   budgets without dynamic parameter changes.
2. **Frozen accounting tests:** harden storage lock-in, retrieval settlement,
   spend windows, sponsored sessions, protocol sessions, and reward burns.
3. **Market simulator:** model supply, demand, provider P&L, and price
   controller behavior across seeded scenarios.
4. **Keeper graduation:** add deterministic epoch tests for pricing, reward
   pools, audit budget, and elasticity caps.
5. **E2E confirmation:** verify quote-to-charge parity, retrieval
   burn/payout, sponsored-session isolation, and saturation spend rejection.
6. **Dynamic pricing trial:** enable measure-only or devnet-only price updates
   with conservative bounds and dashboard alerts.
7. **Governance launch posture:** decide which market params are fixed,
   dynamic, governance-adjustable, or disabled for each launch phase.

### 33.6 Economic Definition of Done

The financial market portion is not complete until:

1. A fixed-seed simulation can show stable behavior for normal demand,
   degraded supply, malicious traffic, and viral-demand scenarios.
2. Provider P&L is positive for target honest providers and negative for
   canonical abuse strategies.
3. Fee-vs-issuance share is measurable and trends toward the desired launch
   posture.
4. Price controller bounds prevent runaway oscillation in stress scenarios.
5. Escrow and sponsored-session accounting prevent public demand from draining
   long-term storage funding.
6. Audit budget sizing clears expected audit and repair load without uncapped
   minting.
7. Elasticity can absorb demand when funded and fails closed when unfunded.

## 34. Branching and PR Strategy

The simulator and policing work should move through reviewable branches and
pull requests. The historical direct-to-`main` workflow was acceptable during
rapid planning, but it is not appropriate for the simulator, keeper, gateway,
or enforcement workstreams.

### 34.1 Branch Policy

1. Agents should branch from a fresh `origin/main` before starting non-trivial
   work.
2. Agents must not push implementation or planning changes directly to `main`.
3. Work should land on topic branches and be reviewed through PRs.
4. Human approval is required before merge.
5. Agents may push branches and open or update PRs, but must not merge their
   own PRs.
6. Direct `main` pushes are reserved for documented emergency hotfixes
   explicitly authorized by the user.

Recommended branch prefixes:

| Prefix | Use |
|---|---|
| `docs/` | Roadmaps, RFCs, runbooks, AGENTS.md policy, planning updates. |
| `sim/` | `tools/policy_sim` scenarios, ledgers, output schemas, assertions. |
| `chain/` | Keeper state, params, messages, epoch hooks, consensus tests. |
| `gateway/` | user-gateway or provider-daemon behavior, routing, fault hooks. |
| `website/` | UX surfaces, dashboards, operator/user visibility. |
| `e2e/` | process-level scripts, fixtures, and devnet orchestration. |

### 34.2 PR Sizing

PRs should be small enough to review as one policy or implementation unit.
Recommended slicing:

1. One PR for S0 simulator planning contract.
2. One PR for fixture loading and built-in scenario migration.
3. One PR for reliability ledgers.
4. One PR for economic ledgers.
5. One PR for simulated enforcement modes.
6. One PR per keeper policy graduation.
7. One PR per process-level e2e scenario or tightly related scenario group.

Avoid combining docs, simulator behavior, keeper state, gateway behavior, and
website UX in one PR unless the change is a deliberate end-to-end slice.

### 34.3 PR Review Requirements

Every PR should state:

1. Which roadmap stage or simulator milestone it advances.
2. Which scenario fixtures or policy surfaces it changes.
3. Which tests or smoke checks were run.
4. Which output schemas changed, if any.
5. Whether the PR is planning-only, simulator-only, keeper-level,
   runtime/e2e, or live-enforcement related.

For simulator PRs, include example output paths or summarized assertion results.
For keeper or runtime PRs, identify the simulator scenario that justified
graduation.

### 34.4 Merge Gates

Minimum merge gates:

1. Human review and approval.
2. Relevant tests pass, or failures are documented and accepted by a human.
3. No direct `main` push by agents.
4. No destructive git operations or history rewrites without explicit approval.
5. For schema changes, fixtures and regression tests are updated in the same
   PR.

### 34.5 Agent Instruction Source

The root `AGENTS.md` must encode this branch/PR policy so future agents follow
it by default. If nested `AGENTS.md` files add local guidance, they should not
weaken the repo-wide requirement that agent work uses branches, PRs, and human
approval before merge.

## 35. Open Questions

1. Should hot and cold deals use separate missed-epoch thresholds from the start?
2. What false-positive repair rate is acceptable during trusted devnet?
3. What false-positive slash rate is acceptable before mainnet? The likely answer is effectively zero.
4. Which non-response evidence should count toward conviction: user reports, deputy transcripts, audit tasks, or all of them with weights?
5. How much audit budget should be reserved for proactive checks versus repair catch-up?
6. Should replacement cooldowns be per slot, per deal, per provider, or all three?
7. What operator maintenance mode is needed before "draining" becomes the only clean exit path?
8. Which degraded behaviors should affect placement priority before they affect economic penalties?
9. What is the minimum proof of readiness before a pending provider can be
   promoted?
10. What are the promotion and demotion thresholds for high-bandwidth SPs?
11. How should overlay elasticity be represented in `mode2_slots` or successor
    state?
12. How should provider lifecycle state interact with operator-level Sybil or
    concentration limits?
13. Which punitive policies are disabled, measure-only, or active for each
    devnet/testnet/mainnet phase?
14. Should dynamic pricing be disabled, measure-only, or active during trusted
    devnet?
15. What provider cost model should be used for devnet, testnet, and mainnet
    simulation?
16. What fee-vs-issuance target defines "healthy enough" before incentives are
    tightened?
17. What are the production end-of-deal escrow close/refund semantics now that
    the simulator can model lock-in, earned fees, early close refunds, and
    outstanding escrow?
18. Should reward remainders always burn, or can any phase route them to a
    protocol sink without creating cartel incentives?
19. What storage and retrieval price bounds preserve affordability while
    preventing underpriced supply?
20. How should wash-traffic alerts distinguish spam from legitimate viral
    demand?
