# Policy Simulation Graduation Map

This report converts the committed simulator corpus into implementation planning targets. It is intentionally higher-level than per-scenario `graduation.md` files: this is the artifact to use when choosing the next keeper, gateway/provider, or e2e test slice.

## Readiness Summary

| Status | Count | Meaning |
|---|---:|---|
| `implementation planning` | 25 | The fixture passed and maps to a concrete keeper, gateway/provider, or e2e artifact. |
| `further simulation review` | 12 | The fixture passed but should inform parameter or product policy before implementation work. |
| `blocked` | 0 | The fixture failed assertions or durability safety and should not graduate. |

## Scenario-to-Implementation Map

| Scenario | Status | Target | Next Test Slice | Missing Surfaces | E2E Posture |
|---|---|---|---|---|---|
| [`audit-budget-exhaustion`](audit-budget-exhaustion/report.md) | `implementation planning` | audit budget keeper tests | Add audit-budget demand/spend/backlog tests proving audit demand is capped and backlog is explicit. | `audit budget state`, `audit backlog query`, `evidence bounty accounting` | No process e2e until audit sessions are wired through provider-daemon. |
| [`coordinated-regional-outage`](coordinated-regional-outage/report.md) | `further simulation review` | placement diversity and nightly stress | Keep as simulator calibration until placement-diversity params exist, then add keeper candidate-selection tests. | `regional/provider-class placement metadata`, `operator concentration limits`, `nightly stress harness` | Manual or nightly multi-provider outage, not PR-blocking CI. |
| [`corrupt-provider`](corrupt-provider/report.md) | `implementation planning` | hard-fault keeper path | Add invalid-proof or wrong-data keeper tests proving no corrupt payment, repair start, and slash/jail simulation gates. | `hard evidence submission`, `corrupt-byte reward exclusion`, `jail/slash params` | Provider returns corrupt bytes or invalid proof and user-gateway rejects the response. |
| [`demand-elasticity-recovery`](demand-elasticity-recovery/report.md) | `further simulation review` | economic policy calibration | Compare elasticity slope, reference price, price-step timing, and demand recovery before encoding governance defaults. | `quote rejection telemetry`, `affordability dashboards`, `demand forecasting` | No process e2e yet; this is a parameter-calibration fixture. |
| [`deputy-evidence-spam`](deputy-evidence-spam/report.md) | `implementation planning` | evidence-market keeper tests | Add evidence-bond escrow, burn-on-expiry, conviction gating, bounty payout, spam-throttle, and deputy-reputation tests. | `evidence bond escrow`, `conviction state`, `bounty payout ledger`, `deputy reputation` | No process e2e until MsgSubmitEvidence and protocol retrieval sessions exist. |
| [`elasticity-cap-hit`](elasticity-cap-hit/report.md) | `further simulation review` | elasticity spend-window tests | Add spend-window tests for saturation signaling, fail-closed expansion, TTL, and cap-bound rejection. | `MsgSignalSaturation hardening`, `overlay accountability`, `deal spend window` | Burst traffic e2e after overlay semantics are implemented. |
| [`elasticity-overlay-scaleup`](elasticity-overlay-scaleup/report.md) | `implementation planning` | elasticity overlay keeper/gateway/provider-daemon tests | Add tests proving saturation signals can buy bounded temporary overlay routes, providers prove readiness before routing, routes expire by TTL, and spend caps fail closed. | `MsgSignalSaturation`, `overlay readiness proof`, `overlay TTL`, `overlay route telemetry`, `spend-window accounting` | Drive hot retrieval pressure, trigger funded overflow capacity, assert overlay routes serve reads after readiness and expire without changing base slot durability. |
| [`flapping-provider`](flapping-provider/report.md) | `implementation planning` | keeper soft-fault window | Add missed-epoch window tests proving intermittent failures create health evidence without triggering repair churn. | `soft-fault decay`, `per-slot suspect state`, `operator health query` | Optional provider restart e2e; keeper coverage should be the first artifact. |
| [`high-bandwidth-promotion`](high-bandwidth-promotion/report.md) | `implementation planning` | provider capability and hot-route policy tests | Add capability-tier keeper/runtime tests proving measured providers can become high-bandwidth eligible and hot retrieval routing prefers them without over-capacity assignment. | `provider capability tier state`, `bandwidth probe telemetry`, `hot-route preference query`, `capability demotion rule` | Hot retrieval burst against heterogeneous providers after gateway/provider telemetry exists; assert promoted providers receive hot traffic and can later demote on regression. |
| [`high-bandwidth-regression`](high-bandwidth-regression/report.md) | `implementation planning` | capability demotion and hot-route failover tests | Add keeper/runtime tests proving promoted providers demote after sustained saturation and hot routing falls back without data-loss or over-capacity assignment. | `capability demotion rule`, `saturation evidence accumulator`, `hot-route failover telemetry`, `operator regression alert` | Hot retrieval burst that intentionally saturates promoted providers; assert demotion events fire and retrievals continue through fallback capacity. |
| [`ideal`](ideal/report.md) | `implementation planning` | keeper control tests | Add no-op epoch tests proving healthy providers do not accrue evidence, repair, reward exclusion, jail, or slash state. | `keeper epoch hooks`, `reward eligibility queries` | Gateway happy-path smoke remains sufficient; do not add a slow failure e2e for the control case. |
| [`invalid-synthetic-proof`](invalid-synthetic-proof/report.md) | `implementation planning` | invalid-proof keeper path | Add keeper tests proving invalid liveness proofs create hard evidence, trigger repair, and apply slash/jail gates without requiring corrupt retrieval bytes. | `proof validation error attribution`, `hard evidence submission`, `jail/slash params` | Provider submits an invalid liveness proof while retrieval bytes remain clean; assert proof rejection and repair. |
| [`large-scale-regional-stress`](large-scale-regional-stress/report.md) | `further simulation review` | scale calibration and regression reporting | Use sweep reports to tune repair throughput, placement headroom, retrieval pricing, and provider P&L before keeper defaults. | `scale sweep corpus`, `placement diversity params`, `operator concentration analysis`, `CI artifact retention` | Do not mirror this as process e2e; keep it as simulator/CI artifact work. |
| [`lazy-provider`](lazy-provider/report.md) | `implementation planning` | reward eligibility keeper tests | Add quota shortfall and synthetic-fill tests proving lazy responsibility is excluded from base rewards without soft-fault slashing. | `quota miss ledger`, `reward exclusion reason query`, `soft fault consequence ceiling` | Slow-path only after keeper reward accounting is stable. |
| [`operator-concentration-cap`](operator-concentration-cap/report.md) | `implementation planning` | operator identity and assignment cap keeper tests | Add keeper/runtime tests proving deterministic placement and repair candidate selection respect per-deal operator caps while surfacing fallback reasons. | `operator identity registry`, `per-deal operator cap params`, `candidate diversity diagnostics`, `Sybil concentration alerts` | Provider set with one dominant operator; assert hot and normal deal placement stay within operator caps and replacement falls back only with explicit evidence. |
| [`overpriced-storage`](overpriced-storage/report.md) | `further simulation review` | economic policy calibration | Compare quote affordability bounds, price-step timing, and demand rejection semantics before encoding governance defaults. | `quote rejection telemetry`, `affordability dashboards` | No process e2e yet; this is a parameter-calibration fixture. |
| [`performance-market-latency`](performance-market-latency/report.md) | `implementation planning` | service-class and latency-tier keeper tests | Add keeper/runtime tests proving retrieval telemetry maps to Platinum/Gold/Silver/Fail tiers, tiered rewards are deterministic, and Fail-tier QoS does not become slashable hard evidence. | `service-class params`, `latency telemetry accumulator`, `tiered reward multipliers`, `QoS-only health notes` | Hot-service retrieval burst after telemetry exists; assert tier counts and provider payouts reflect latency without breaking read availability. |
| [`price-controller-bounds`](price-controller-bounds/report.md) | `implementation planning` | dynamic pricing keeper tests | Add epoch pricing tests for floors, ceilings, utilization target, retrieval-demand target, and max step bps. | `dynamic pricing params`, `storage utilization accumulator`, `retrieval demand accumulator` | No process e2e; validate with keeper tests and simulator sweeps first. |
| [`provider-bond-headroom`](provider-bond-headroom/report.md) | `further simulation review` | provider bond and assignment collateral calibration | Compare minimum bond, per-slot collateral, slash sizing, and underbonded repair urgency before keeper bond state or provider top-up UX is implemented. | `provider bond state`, `assignment collateral formula`, `underbonded provider events`, `bond top-up flow` | No process e2e yet; validate collateral policy with simulator scenarios before provider bond keeper tests. |
| [`provider-cost-shock`](provider-cost-shock/report.md) | `further simulation review` | economic policy calibration | Compare provider cost assumptions, price floors, reward buffers, and whether cost telemetry should trigger governance review before encoding market defaults. | `provider cost telemetry`, `profitability dashboards`, `price-floor governance policy` | No process e2e yet; this is a parameter-calibration fixture. |
| [`provider-economic-churn`](provider-economic-churn/report.md) | `further simulation review` | economic churn and replacement calibration | Compare churn caps, minimum active-provider floor, draining notice, replacement throughput, and price-floor response before keeper drain semantics are implemented. | `draining provider state`, `provider exit telemetry`, `churn caps`, `replacement capacity dashboards` | No process e2e yet; validate churn policy with simulator sweeps and then add keeper drain/replacement tests. |
| [`provider-supply-entry`](provider-supply-entry/report.md) | `further simulation review` | provider lifecycle and supply recovery calibration | Compare reserve sizing, entry caps, probation windows, utilization triggers, and readiness semantics before keeper provider lifecycle state is implemented. | `provider lifecycle state`, `probation readiness checks`, `reserve supply telemetry`, `entry and promotion caps` | No process e2e yet; validate supply recovery with simulator scenarios before provider registration or promotion keeper tests. |
| [`repair-candidate-exhaustion`](repair-candidate-exhaustion/report.md) | `implementation planning` | candidate selection and repair backoff keeper tests | Add tests proving no eligible replacement emits backoff, preserves capacity constraints, and does not over-assign providers. | `candidate exclusion reasons`, `repair attempt caps`, `replacement capacity query` | Small devnet with no spare provider capacity after keeper behavior is stable. |
| [`replacement-grinding`](replacement-grinding/report.md) | `implementation planning` | pending-provider readiness and retry keeper tests | Add tests proving pending replacements must submit readiness before promotion, time out when they fail catch-up, and respect retry cooldown and attempt caps. | `pending-provider readiness proof`, `repair timeout ledger`, `retry cooldown state`, `failed catch-up reputation signal` | Provider replacement with a pending SP that never catches up; assert timeout/retry state before process-level promotion. |
| [`retrieval-demand-shock`](retrieval-demand-shock/report.md) | `further simulation review` | dynamic pricing calibration | Compare retrieval demand targets, price-step clamps, smoothing windows, and burst response before encoding retrieval pricing defaults. | `retrieval demand accumulator`, `pricing smoothing params`, `burst-demand dashboards` | No process e2e yet; validate with keeper pricing tests and simulator sweeps first. |
| [`setup-failure`](setup-failure/report.md) | `implementation planning` | setup bump and deterministic replacement | Add setup-phase replacement tests proving failed initial upload selects a system provider and does not imply fraud. | `setup slot state`, `setup bump event`, `candidate exclusion reasons` | Create deal with one failing provider upload and verify replacement before first content commit. |
| [`single-outage`](single-outage/report.md) | `implementation planning` | keeper repair and gateway route-around | Add a keeper test where a slot crosses missed-epoch threshold, enters repair, selects a deterministic pending provider, and later promotes. | `slot health state`, `repair attempt ledger`, `promotion readiness proof`, `gateway repair-aware routing` | Kill one provider-daemon during retrieval and assert reads stay available while repair starts. |
| [`staged-upload-grief`](staged-upload-grief/report.md) | `implementation planning` | provider-daemon staged cleanup and gateway preflight | Add provider-daemon and user-gateway tests proving abandoned provisional generations are capped, cleaned after TTL, and surfaced through dry-run/apply cleanup UX without affecting committed deal state. | `staged generation TTL`, `pending generation cap`, `cleanup events`, `gateway preflight rejection` | Client repeatedly stages uploads without commit; assert provider-daemon cleanup bounds disk pressure and committed reads remain available. |
| [`storage-escrow-close-refund`](storage-escrow-close-refund/report.md) | `implementation planning` | storage escrow close/refund accounting | Add keeper and gateway tests proving storage quote parity, upfront lock-in, earned-fee payout, early close refund, expiry auto-close, and zero hidden outstanding escrow. | `storage escrow state`, `deal close message`, `earned-fee payout ledger`, `refund rounding`, `expiry auto-close` | Create, commit, close early, and assert unearned storage escrow is refunded while earned fees remain paid to eligible providers. |
| [`storage-escrow-expiry`](storage-escrow-expiry/report.md) | `implementation planning` | storage escrow expiry accounting | Add keeper and gateway tests proving fully earned deals auto-expire, stop serving active responsibility, leave no hidden escrow, and expose final query state. | `expiry auto-close`, `deal GC state`, `final earned-fee settlement`, `post-expiry retrieval behavior`, `expired deal queries` | Create, commit, wait through duration, assert the deal expires with no outstanding escrow and no active slots. |
| [`storage-escrow-noncompliance-burn`](storage-escrow-noncompliance-burn/report.md) | `implementation planning` | storage fee reward-exclusion accounting | Add keeper and gateway tests proving delinquent storage responsibility loses earned-fee payout and records a burn without confusing storage lock-in, repair, or availability accounting. | `storage fee payout eligibility`, `burn ledger attribution`, `delinquency-to-payout gate`, `repair interaction`, `provider payout queries` | Commit content, force one provider through quota delinquency, assert earned fees for non-compliant responsibility are burned while compliant providers are paid and reads remain available. |
| [`subsidy-farming`](subsidy-farming/report.md) | `implementation planning` | base reward compliance tests | Add tests proving idle or non-compliant responsibility cannot farm base rewards profitably. | `compliance-gated base rewards`, `subsidy leakage metrics`, `operator concentration checks` | No process e2e until keeper reward gating is complete. |
| [`sustained-non-response`](sustained-non-response/report.md) | `implementation planning` | keeper delinquency repair | Add per-slot delinquency tests for repeated non-response, reward exclusion, repair start, and replacement selection. | `non-response accumulator`, `delinquency reason codes`, `reward exclusion event` | Provider timeout/blackhole e2e after keeper state is deterministic. |
| [`underpriced-storage`](underpriced-storage/report.md) | `further simulation review` | economic policy calibration | Compare storage floors, base rewards, and provider cost assumptions before encoding governance defaults. | `dynamic pricing state`, `provider cost assumptions`, `profitability dashboards` | No process e2e yet; this is a parameter-calibration fixture. |
| [`viral-public-retrieval`](viral-public-retrieval/report.md) | `implementation planning` | sponsored retrieval accounting | Add sponsored-session tests proving public demand pays providers without draining owner escrow unexpectedly. | `sponsored session funding`, `owner escrow isolation`, `hot route observability` | Public retrieval spike against one deal with requester/sponsor funding. |
| [`wash-retrieval`](wash-retrieval/report.md) | `further simulation review` | session fee and credit-cap keeper tests | Add retrieval fee, burn, credit-cap, and requester-paid session accounting tests. | `requester-paid session accounting`, `burn ledger`, `credit cap enforcement` | Synthetic wash traffic e2e only after keeper accounting exists. |
| [`withholding`](withholding/report.md) | `implementation planning` | gateway fallback plus keeper evidence | Add tests for threshold non-response evidence and deputy-served miss accounting before punitive policy. | `threshold evidence case`, `deputy transcript accounting`, `gateway fallback telemetry` | Provider refuses retrieval responses; gateway routes around and records attributable failure. |

## Recommended Near-Term Keeper/E2E Slices

- `ideal`: Add no-op epoch tests proving healthy providers do not accrue evidence, repair, reward exclusion, jail, or slash state.
- `single-outage`: Add a keeper test where a slot crosses missed-epoch threshold, enters repair, selects a deterministic pending provider, and later promotes.
- `sustained-non-response`: Add per-slot delinquency tests for repeated non-response, reward exclusion, repair start, and replacement selection.
- `corrupt-provider`: Add invalid-proof or wrong-data keeper tests proving no corrupt payment, repair start, and slash/jail simulation gates.
- `invalid-synthetic-proof`: Add keeper tests proving invalid liveness proofs create hard evidence, trigger repair, and apply slash/jail gates without requiring corrupt retrieval bytes.
- `lazy-provider`: Add quota shortfall and synthetic-fill tests proving lazy responsibility is excluded from base rewards without soft-fault slashing.
- `setup-failure`: Add setup-phase replacement tests proving failed initial upload selects a system provider and does not imply fraud.
- `repair-candidate-exhaustion`: Add tests proving no eligible replacement emits backoff, preserves capacity constraints, and does not over-assign providers.

## Missing Surfaces By Component

| Surface | Scenario Count |
|---|---:|
| `affordability dashboards` | 2 |
| `candidate exclusion reasons` | 2 |
| `capability demotion rule` | 2 |
| `expiry auto-close` | 2 |
| `hard evidence submission` | 2 |
| `jail/slash params` | 2 |
| `profitability dashboards` | 2 |
| `quote rejection telemetry` | 2 |
| `retrieval demand accumulator` | 2 |
| `CI artifact retention` | 1 |
| `MsgSignalSaturation` | 1 |
| `MsgSignalSaturation hardening` | 1 |
| `QoS-only health notes` | 1 |
| `Sybil concentration alerts` | 1 |
| `assignment collateral formula` | 1 |
| `audit backlog query` | 1 |
| `audit budget state` | 1 |
| `bandwidth probe telemetry` | 1 |
| `bond top-up flow` | 1 |
| `bounty payout ledger` | 1 |
| `burn ledger` | 1 |
| `burn ledger attribution` | 1 |
| `burst-demand dashboards` | 1 |
| `candidate diversity diagnostics` | 1 |
| `churn caps` | 1 |
| `cleanup events` | 1 |
| `compliance-gated base rewards` | 1 |
| `conviction state` | 1 |
| `corrupt-byte reward exclusion` | 1 |
| `credit cap enforcement` | 1 |
| `deal GC state` | 1 |
| `deal close message` | 1 |
| `deal spend window` | 1 |
| `delinquency reason codes` | 1 |
| `delinquency-to-payout gate` | 1 |
| `demand forecasting` | 1 |
| `deputy reputation` | 1 |
| `deputy transcript accounting` | 1 |
| `draining provider state` | 1 |
| `dynamic pricing params` | 1 |
| `dynamic pricing state` | 1 |
| `earned-fee payout ledger` | 1 |
| `entry and promotion caps` | 1 |
| `evidence bond escrow` | 1 |
| `evidence bounty accounting` | 1 |
| `expired deal queries` | 1 |
| `failed catch-up reputation signal` | 1 |
| `final earned-fee settlement` | 1 |
| `gateway fallback telemetry` | 1 |
| `gateway preflight rejection` | 1 |
| `gateway repair-aware routing` | 1 |
| `hot route observability` | 1 |
| `hot-route failover telemetry` | 1 |
| `hot-route preference query` | 1 |
| `keeper epoch hooks` | 1 |
| `latency telemetry accumulator` | 1 |
| `nightly stress harness` | 1 |
| `non-response accumulator` | 1 |
| `operator concentration analysis` | 1 |
| `operator concentration checks` | 1 |
| `operator concentration limits` | 1 |
| `operator health query` | 1 |
| `operator identity registry` | 1 |
| `operator regression alert` | 1 |
| `overlay TTL` | 1 |
| `overlay accountability` | 1 |
| `overlay readiness proof` | 1 |
| `overlay route telemetry` | 1 |
| `owner escrow isolation` | 1 |
| `pending generation cap` | 1 |
| `pending-provider readiness proof` | 1 |
| `per-deal operator cap params` | 1 |
| `per-slot suspect state` | 1 |
| `placement diversity params` | 1 |
| `post-expiry retrieval behavior` | 1 |
| `price-floor governance policy` | 1 |
| `pricing smoothing params` | 1 |
| `probation readiness checks` | 1 |
| `promotion readiness proof` | 1 |
| `proof validation error attribution` | 1 |
| `provider bond state` | 1 |
| `provider capability tier state` | 1 |
| `provider cost assumptions` | 1 |
| `provider cost telemetry` | 1 |
| `provider exit telemetry` | 1 |
| `provider lifecycle state` | 1 |
| `provider payout queries` | 1 |
| `quota miss ledger` | 1 |
| `refund rounding` | 1 |
| `regional/provider-class placement metadata` | 1 |
| `repair attempt caps` | 1 |
| `repair attempt ledger` | 1 |
| `repair interaction` | 1 |
| `repair timeout ledger` | 1 |
| `replacement capacity dashboards` | 1 |
| `replacement capacity query` | 1 |
| `requester-paid session accounting` | 1 |
| `reserve supply telemetry` | 1 |
| `retry cooldown state` | 1 |
| `reward eligibility queries` | 1 |
| `reward exclusion event` | 1 |
| `reward exclusion reason query` | 1 |
| `saturation evidence accumulator` | 1 |
| `scale sweep corpus` | 1 |
| `service-class params` | 1 |
| `setup bump event` | 1 |
| `setup slot state` | 1 |
| `slot health state` | 1 |
| `soft fault consequence ceiling` | 1 |
| `soft-fault decay` | 1 |
| `spend-window accounting` | 1 |
| `sponsored session funding` | 1 |
| `staged generation TTL` | 1 |
| `storage escrow state` | 1 |
| `storage fee payout eligibility` | 1 |
| `storage utilization accumulator` | 1 |
| `subsidy leakage metrics` | 1 |
| `threshold evidence case` | 1 |
| `tiered reward multipliers` | 1 |
| `underbonded provider events` | 1 |

## Review Rule

Use this map to choose implementation work only after the linked scenario report, risk register, and assertion contract have been reviewed. A passing simulator fixture is evidence for planning, not permission to enable live punitive enforcement.
