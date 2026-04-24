# Policy Simulation Graduation Map

This report converts the committed simulator corpus into implementation planning targets. It is intentionally higher-level than per-scenario `graduation.md` files: this is the artifact to use when choosing the next keeper, gateway/provider, or e2e test slice.

## Readiness Summary

| Status | Count | Meaning |
|---|---:|---|
| `implementation planning` | 14 | The fixture passed and maps to a concrete keeper, gateway/provider, or e2e artifact. |
| `further simulation review` | 6 | The fixture passed but should inform parameter or product policy before implementation work. |
| `blocked` | 0 | The fixture failed assertions or durability safety and should not graduate. |

## Scenario-to-Implementation Map

| Scenario | Status | Target | Next Test Slice | Missing Surfaces | E2E Posture |
|---|---|---|---|---|---|
| [`audit-budget-exhaustion`](audit-budget-exhaustion/report.md) | `implementation planning` | audit budget keeper tests | Add audit-budget minted/spent/carryover tests proving audit demand is capped and backlog is explicit. | `audit budget state`, `audit backlog query`, `evidence bounty accounting` | No process e2e until audit sessions are wired through provider-daemon. |
| [`coordinated-regional-outage`](coordinated-regional-outage/report.md) | `further simulation review` | placement diversity and nightly stress | Keep as simulator calibration until placement-diversity params exist, then add keeper candidate-selection tests. | `regional/provider-class placement metadata`, `operator concentration limits`, `nightly stress harness` | Manual or nightly multi-provider outage, not PR-blocking CI. |
| [`corrupt-provider`](corrupt-provider/report.md) | `implementation planning` | hard-fault keeper path | Add invalid-proof or wrong-data keeper tests proving no corrupt payment, repair start, and slash/jail simulation gates. | `hard evidence submission`, `corrupt-byte reward exclusion`, `jail/slash params` | Provider returns corrupt bytes or invalid proof and user-gateway rejects the response. |
| [`elasticity-cap-hit`](elasticity-cap-hit/report.md) | `further simulation review` | elasticity spend-window tests | Add spend-window tests for saturation signaling, fail-closed expansion, TTL, and cap-bound rejection. | `MsgSignalSaturation hardening`, `overlay accountability`, `deal spend window` | Burst traffic e2e after overlay semantics are implemented. |
| [`flapping-provider`](flapping-provider/report.md) | `implementation planning` | keeper soft-fault window | Add missed-epoch window tests proving intermittent failures create health evidence without triggering repair churn. | `soft-fault decay`, `per-slot suspect state`, `operator health query` | Optional provider restart e2e; keeper coverage should be the first artifact. |
| [`high-bandwidth-promotion`](high-bandwidth-promotion/report.md) | `implementation planning` | provider capability and hot-route policy tests | Add capability-tier keeper/runtime tests proving measured providers can become high-bandwidth eligible and hot retrieval routing prefers them without over-capacity assignment. | `provider capability tier state`, `bandwidth probe telemetry`, `hot-route preference query`, `capability demotion rule` | Hot retrieval burst against heterogeneous providers after gateway/provider telemetry exists; assert promoted providers receive hot traffic and can later demote on regression. |
| [`high-bandwidth-regression`](high-bandwidth-regression/report.md) | `implementation planning` | capability demotion and hot-route failover tests | Add keeper/runtime tests proving promoted providers demote after sustained saturation and hot routing falls back without data-loss or over-capacity assignment. | `capability demotion rule`, `saturation evidence accumulator`, `hot-route failover telemetry`, `operator regression alert` | Hot retrieval burst that intentionally saturates promoted providers; assert demotion events fire and retrievals continue through fallback capacity. |
| [`ideal`](ideal/report.md) | `implementation planning` | keeper control tests | Add no-op epoch tests proving healthy providers do not accrue evidence, repair, reward exclusion, jail, or slash state. | `keeper epoch hooks`, `reward eligibility queries` | Gateway happy-path smoke remains sufficient; do not add a slow failure e2e for the control case. |
| [`large-scale-regional-stress`](large-scale-regional-stress/report.md) | `further simulation review` | scale calibration and regression reporting | Use sweep reports to tune repair throughput, placement headroom, retrieval pricing, and provider P&L before keeper defaults. | `scale sweep corpus`, `placement diversity params`, `operator concentration analysis`, `CI artifact retention` | Do not mirror this as process e2e; keep it as simulator/CI artifact work. |
| [`lazy-provider`](lazy-provider/report.md) | `implementation planning` | reward eligibility keeper tests | Add quota shortfall and synthetic-fill tests proving lazy responsibility is excluded from base rewards without soft-fault slashing. | `quota miss ledger`, `reward exclusion reason query`, `soft fault consequence ceiling` | Slow-path only after keeper reward accounting is stable. |
| [`price-controller-bounds`](price-controller-bounds/report.md) | `implementation planning` | dynamic pricing keeper tests | Add epoch pricing tests for floors, ceilings, utilization target, retrieval-demand target, and max step bps. | `dynamic pricing params`, `storage utilization accumulator`, `retrieval demand accumulator` | No process e2e; validate with keeper tests and simulator sweeps first. |
| [`repair-candidate-exhaustion`](repair-candidate-exhaustion/report.md) | `implementation planning` | candidate selection and repair backoff keeper tests | Add tests proving no eligible replacement emits backoff, preserves capacity constraints, and does not over-assign providers. | `candidate exclusion reasons`, `repair attempt caps`, `replacement capacity query` | Small devnet with no spare provider capacity after keeper behavior is stable. |
| [`setup-failure`](setup-failure/report.md) | `implementation planning` | setup bump and deterministic replacement | Add setup-phase replacement tests proving failed initial upload selects a system provider and does not imply fraud. | `setup slot state`, `setup bump event`, `candidate exclusion reasons` | Create deal with one failing provider upload and verify replacement before first content commit. |
| [`single-outage`](single-outage/report.md) | `implementation planning` | keeper repair and gateway route-around | Add a keeper test where a slot crosses missed-epoch threshold, enters repair, selects a deterministic pending provider, and later promotes. | `slot health state`, `repair attempt ledger`, `promotion readiness proof`, `gateway repair-aware routing` | Kill one provider-daemon during retrieval and assert reads stay available while repair starts. |
| [`subsidy-farming`](subsidy-farming/report.md) | `implementation planning` | base reward compliance tests | Add tests proving idle or non-compliant responsibility cannot farm base rewards profitably. | `compliance-gated base rewards`, `subsidy leakage metrics`, `operator concentration checks` | No process e2e until keeper reward gating is complete. |
| [`sustained-non-response`](sustained-non-response/report.md) | `implementation planning` | keeper delinquency repair | Add per-slot delinquency tests for repeated non-response, reward exclusion, repair start, and replacement selection. | `non-response accumulator`, `delinquency reason codes`, `reward exclusion event` | Provider timeout/blackhole e2e after keeper state is deterministic. |
| [`underpriced-storage`](underpriced-storage/report.md) | `further simulation review` | economic policy calibration | Compare storage floors, base rewards, and provider cost assumptions before encoding governance defaults. | `dynamic pricing state`, `provider cost assumptions`, `profitability dashboards` | No process e2e yet; this is a parameter-calibration fixture. |
| [`viral-public-retrieval`](viral-public-retrieval/report.md) | `further simulation review` | sponsored retrieval accounting | Add sponsored-session tests proving public demand pays providers without draining owner escrow unexpectedly. | `sponsored session funding`, `owner escrow isolation`, `hot route observability` | Public retrieval spike against one deal with requester/sponsor funding. |
| [`wash-retrieval`](wash-retrieval/report.md) | `further simulation review` | session fee and credit-cap keeper tests | Add retrieval fee, burn, credit-cap, and requester-paid session accounting tests. | `requester-paid session accounting`, `burn ledger`, `credit cap enforcement` | Synthetic wash traffic e2e only after keeper accounting exists. |
| [`withholding`](withholding/report.md) | `implementation planning` | gateway fallback plus keeper evidence | Add tests for threshold non-response evidence and deputy-served miss accounting before punitive policy. | `threshold evidence case`, `deputy transcript accounting`, `gateway fallback telemetry` | Provider refuses retrieval responses; gateway routes around and records attributable failure. |

## Recommended Near-Term Keeper/E2E Slices

- `ideal`: Add no-op epoch tests proving healthy providers do not accrue evidence, repair, reward exclusion, jail, or slash state.
- `single-outage`: Add a keeper test where a slot crosses missed-epoch threshold, enters repair, selects a deterministic pending provider, and later promotes.
- `sustained-non-response`: Add per-slot delinquency tests for repeated non-response, reward exclusion, repair start, and replacement selection.
- `corrupt-provider`: Add invalid-proof or wrong-data keeper tests proving no corrupt payment, repair start, and slash/jail simulation gates.
- `lazy-provider`: Add quota shortfall and synthetic-fill tests proving lazy responsibility is excluded from base rewards without soft-fault slashing.
- `setup-failure`: Add setup-phase replacement tests proving failed initial upload selects a system provider and does not imply fraud.
- `repair-candidate-exhaustion`: Add tests proving no eligible replacement emits backoff, preserves capacity constraints, and does not over-assign providers.
- `high-bandwidth-promotion`: Add capability-tier keeper/runtime tests proving measured providers can become high-bandwidth eligible and hot retrieval routing prefers them without over-capacity assignment.

## Missing Surfaces By Component

| Surface | Scenario Count |
|---|---:|
| `candidate exclusion reasons` | 2 |
| `capability demotion rule` | 2 |
| `CI artifact retention` | 1 |
| `MsgSignalSaturation hardening` | 1 |
| `audit backlog query` | 1 |
| `audit budget state` | 1 |
| `bandwidth probe telemetry` | 1 |
| `burn ledger` | 1 |
| `compliance-gated base rewards` | 1 |
| `corrupt-byte reward exclusion` | 1 |
| `credit cap enforcement` | 1 |
| `deal spend window` | 1 |
| `delinquency reason codes` | 1 |
| `deputy transcript accounting` | 1 |
| `dynamic pricing params` | 1 |
| `dynamic pricing state` | 1 |
| `evidence bounty accounting` | 1 |
| `gateway fallback telemetry` | 1 |
| `gateway repair-aware routing` | 1 |
| `hard evidence submission` | 1 |
| `hot route observability` | 1 |
| `hot-route failover telemetry` | 1 |
| `hot-route preference query` | 1 |
| `jail/slash params` | 1 |
| `keeper epoch hooks` | 1 |
| `nightly stress harness` | 1 |
| `non-response accumulator` | 1 |
| `operator concentration analysis` | 1 |
| `operator concentration checks` | 1 |
| `operator concentration limits` | 1 |
| `operator health query` | 1 |
| `operator regression alert` | 1 |
| `overlay accountability` | 1 |
| `owner escrow isolation` | 1 |
| `per-slot suspect state` | 1 |
| `placement diversity params` | 1 |
| `profitability dashboards` | 1 |
| `promotion readiness proof` | 1 |
| `provider capability tier state` | 1 |
| `provider cost assumptions` | 1 |
| `quota miss ledger` | 1 |
| `regional/provider-class placement metadata` | 1 |
| `repair attempt caps` | 1 |
| `repair attempt ledger` | 1 |
| `replacement capacity query` | 1 |
| `requester-paid session accounting` | 1 |
| `retrieval demand accumulator` | 1 |
| `reward eligibility queries` | 1 |
| `reward exclusion event` | 1 |
| `reward exclusion reason query` | 1 |
| `saturation evidence accumulator` | 1 |
| `scale sweep corpus` | 1 |
| `setup bump event` | 1 |
| `setup slot state` | 1 |
| `slot health state` | 1 |
| `soft fault consequence ceiling` | 1 |
| `soft-fault decay` | 1 |
| `sponsored session funding` | 1 |
| `storage utilization accumulator` | 1 |
| `subsidy leakage metrics` | 1 |
| `threshold evidence case` | 1 |

## Review Rule

Use this map to choose implementation work only after the linked scenario report, risk register, and assertion contract have been reviewed. A passing simulator fixture is evidence for planning, not permission to enable live punitive enforcement.
