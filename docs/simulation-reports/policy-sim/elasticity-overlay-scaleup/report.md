# Policy Simulation Report: Elasticity Overlay Scale-Up

## Executive Summary

**Verdict:** `PASS`. This run simulates `elasticity-overlay-scaleup` with `36` providers, `120` data users, `3` deals, and an RS `8+4` layout for `8` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model the positive path for user-funded overflow capacity. Sustained hot retrieval pressure buys temporary overlay routes, the routes become ready after a delay, serve reads, and expire instead of becoming permanent unpaid responsibility.

Expected policy behavior: Overlay activations, spend, ready routes, serves, and expirations are visible; spend caps do not reject this fixture; durable slot repair and data-loss paths stay quiet.

Observed result: retrieval success was `94.32%`, reward coverage was `100.00%`, repairs started/ready/completed were `0` / `0` / `0`, and `0` providers ended with negative modeled P&L. The run recorded `109` unavailable reads, `0` expired retrieval rejections, `0` modeled data-loss events, `2463` bandwidth saturation responses and `0` repair backoffs across `0` repair attempts, with `0` pending-repair readiness timeouts. Slot health recorded `0` suspect slot-epochs and `0` delinquent slot-epochs. High-bandwidth promotions were `5` and final high-bandwidth providers were `5`.

## Review Focus

Use this before implementing MsgSignalSaturation, overlay readiness, overlay TTL, and gateway routing expansion in the live stack.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `71` |
| Providers | `36` |
| Data users | `120` |
| Deals | `3` |
| Epochs | `8` |
| Erasure coding | `K=8`, `M=4`, `N=12` |
| User MDUs per deal | `16` |
| Retrievals/user/epoch | `2` |
| Liveness quota | `2`-`8` blobs/slot/epoch |
| Repair delay | `2` epochs |
| Repair attempt cap/slot | `0` (`0` means unlimited) |
| Repair backoff window | `0` epochs |
| Repair pending timeout | `0` epochs (`0` means disabled) |
| Dynamic pricing | `false` |
| Storage price | `1.0000` |
| Storage lock-in | `false`; duration `0` epochs |
| Deal expiry | `false` |
| Deal close policy | epoch `0`; count `0`; share `0.00%` |
| New deal requests/epoch | `0` |
| Storage demand price ceiling | `0.0000` (`0` means disabled) |
| Storage demand reference price | `0.0000` (`0` disables elasticity) |
| Storage demand elasticity | `0.00%` |
| Elasticity trigger | `200` retrievals/epoch (`0` disables) |
| Elasticity spend cap | `60.0000` total |
| Elasticity overlay | `true`; `6` providers/epoch; max `10`/deal |
| Elasticity overlay timing | ready delay `1` epochs; TTL `5` epochs (`0` means no expiry) |
| Staged uploads/epoch | `0` provisional attempts |
| Staged upload retention | `0` epochs (`0` disables age cleanup) |
| Staged upload pending cap | `0` generations (`0` means unlimited) |
| Retrieval price/slot | `0.0100` |
| Sponsored retrieval share | `0.00%` |
| Owner retrieval debit share | `0.00%` |
| Provider capacity range | `16`-`16` slots |
| Provider bandwidth range | `45`-`65` serves/epoch (`0` means unlimited) |
| Service class | `General` |
| Performance market | `false` |
| Provider latency range | `0`-`0` ms |
| Latency tier windows | Platinum <= `100` ms, Gold <= `250` ms, Silver <= `500` ms |
| High-bandwidth promotion | `true` |
| High-bandwidth capacity threshold | `60` serves/epoch |
| Hot retrieval share | `80.00%` |
| Operators | `36` |
| Dominant operator provider share | `0.00%` |
| Operator assignment cap/deal | `0` (`0` means disabled) |
| Provider regions | `global` |

## Economic Assumptions

The economic model is intentionally simple and deterministic. It is useful for comparing policy directions, not for setting final token economics without external market data.

| Assumption | Value | Interpretation |
|---|---:|---|
| Storage price | `1.0000` | Unitless price applied by the controller, demand-elasticity curve, and optional affordability gate. |
| Storage lock-in | enabled `False`, duration `0` epochs | If enabled, committed deals lock storage escrow upfront at the quoted storage price and earn it over the modeled duration. |
| Deal expiry | enabled `False` | If enabled, deals auto-expire once their modeled duration has fully earned. |
| Deal close/refund | epoch `0`, count `0`, share `0.00%` | Optional early close refunds unearned storage escrow and removes closed deals from active responsibility. |
| New deal requests/epoch | `0` | Latent modeled write demand before optional price elasticity suppression. Effective requests are accepted only when price and capacity gates pass. |
| Storage demand price ceiling | `0.0000` | If non-zero, new deal demand above this storage price is rejected as unaffordable. |
| Storage demand reference price | `0.0000` | If non-zero with elasticity enabled, demand scales around this price before hard affordability rejection. |
| Storage demand elasticity | `0.00%` | Demand multiplier change for a 100% price move relative to the reference price, clamped by configured min/max demand bps. |
| Storage target utilization | `70.00%` | If dynamic pricing is enabled, utilization above this target steps storage price up, otherwise down. |
| Retrieval price per slot | `0.0100` | Paid per successful provider slot served, before the configured variable burn. |
| Retrieval target per epoch | `80` | If dynamic pricing is enabled, retrieval attempts above this target step retrieval price up, otherwise down. |
| Retrieval demand shocks | `[]` | Optional epoch-scoped retrieval demand multipliers used to test price shock response and oscillation. |
| Sponsored retrieval share | `0.00%` | Share of retrieval attempts paid by requester/sponsor session funds instead of owner deal escrow. |
| Owner retrieval escrow debit | `0.00%` | Share of non-sponsored retrieval base and variable cost debited to owner escrow in scenarios that explicitly model owner-paid reads. |
| Dynamic pricing max step | `5.00%` | Per-epoch controller movement cap. Lower values are safer but slower to equilibrate. |
| Base reward per slot | `0.0200` | Modeled issuance/subsidy paid only to reward-eligible active slots. |
| Provider storage cost/slot/epoch | `0.0100` | Simplified provider cost basis; jitter may create marginal-provider distress. |
| Provider bandwidth cost/retrieval | `0.0010` | Simplified egress cost basis for retrieval-heavy scenarios. |
| Provider initial/min bond | `100.0000` / `0.0000` | Simplified collateral model. Providers below the required bond are excluded from new responsibility and can trigger repair. |
| Provider bond per assigned slot | `0.0000` | Additional modeled collateral required for each assigned storage slot. |
| Provider cost shocks | `[]` | Optional epoch-scoped fixed/storage/bandwidth cost multipliers used to model sudden operator cost pressure. |
| Provider churn policy | enabled `False`, threshold `0.0000`, after `1` epochs, cap `0`/epoch | Converts sustained negative economics into draining exits; cap `0` means unbounded by this policy. |
| Provider churn floor | `0` providers | Prevents an economic shock fixture from exiting the entire active set unless intentionally configured. |
| Provider supply entry | enabled `False`, reserve `0`, cap `1`/epoch, probation `1` epochs | Moves reserve providers through probation before they become assignment-eligible active supply. |
| Supply entry triggers | utilization >= `0.00%` or storage price >= `disabled` | If both are zero, configured reserve supply enters as soon as the epoch window opens. |
| Performance reward per serve | `0.0000` | Optional tiered QoS reward. Multipliers are applied by latency tier and Fail tier receives the configured fail multiplier. |
| Elasticity trigger/spend | `200` retrievals/epoch / `60.0000` cap | User-funded overflow spending starts only after the configured demand trigger and must stay inside the spend cap. |
| Elasticity overlay policy | enabled `True`, `6` providers/epoch, max `10`/deal | Temporary overlay routes expand retrieval options without becoming durable base slots. |
| Elasticity overlay timing | ready delay `1` epochs, TTL `5` epochs | Models catch-up/readiness delay and scale-down expiration for overflow routes. |
| Staged upload attempts/epoch | `0` | Provisional generations that consume local provider-daemon staging space before content commit. |
| Staged upload commit rate | `100.00%` | Share of provisional uploads that become committed content instead of remaining abandoned local state. |
| Staged upload retention/cap | `0` epochs / `0` generations | Local cleanup and preflight limits used to bound abandoned provisional-generation storage pressure. |
| Audit budget per epoch | `1.0000` | Minted audit budget; spending is capped by available budget and unmet miss-driven demand carries forward as backlog. |
| Evidence spam claims/epoch | `0` | Synthetic low-quality deputy claims used to test bond burn and bounty gating economics. |
| Evidence bond / bounty | `0.0000` / `0.0000` | Spam claims burn bond unless convicted; bounty is paid only on convicted evidence. |
| Retrieval burn | `5.00%` | Fraction of variable retrieval fees burned before provider payout. |

## What Happened

Availability was degraded: the run succeeded on `94.32%` of retrievals and recorded `109` unavailable reads.

The policy layer recorded `48` evidence events: `0` soft, `0` threshold, `0` hard, `0` economic, `48` market, `0` spam, and `0` operational events. Soft and economic evidence are suitable for repair and reward exclusion; hard or convicted threshold evidence is the category that can later justify slashing or stronger sanctions.

Elasticity overlay scaling was exercised: `48` temporary overlay routes were activated, `393` overlay serves completed, and `18` routes expired by TTL. Peak ready overlay routes were `24` and peak active routes were `30`.

No repair events occurred. For healthy or economic-only scenarios this is correct; for fault scenarios it may mean the policy is too passive.

Provider bandwidth constraints mattered: the run recorded `2463` saturated provider responses. That is a scale signal, not necessarily malicious behavior.

High-bandwidth capability policy was exercised: `5` providers were promoted, `0` were demoted, and hot retrievals received `1606` serves from high-bandwidth providers.

## Diagnostic Signals

These are derived from the raw CSV/JSON outputs and are intended to make scale behavior reviewable without manually scanning ledgers.

| Signal | Value | Why It Matters |
|---|---:|---|
| Worst epoch success | `91.25%` at epoch `1` | Identifies the availability cliff instead of hiding it in aggregate success. |
| Unavailable reads | `109` | Temporary read failures are a scale/reliability signal; they are not automatically permanent data loss. |
| Expired retrieval rejections | `0` | Post-expiry requests should be rejected explicitly instead of counted as live availability failures or billable retrievals. |
| Modeled data-loss events | `0` | Durability-loss signal. This should remain zero for current scale fixtures. |
| Degraded epochs | `8` | Counts epochs with unavailable reads or success below 99.9%. |
| Recovery epoch after worst | `not recovered` | Shows whether the network returned to clean steady state after the worst point. |
| Saturation rate | `128.28%` | Provider bandwidth saturation per retrieval attempt. |
| Peak saturation | `365` at epoch `8` | Reveals when bandwidth, not storage correctness, became the bottleneck. |
| Repair readiness ratio | `100.00%` | Measures whether pending providers catch up before promotion. |
| Repair completion ratio | `100.00%` | Measures whether healing catches up with detection. |
| Repair attempts | `0` | Counts bounded attempts to open a repair or discover replacement pressure. |
| Repair backoff pressure | `0` backoffs per started repair | Shows whether repair coordination is saturated. |
| Repair backoffs per attempt | `0` | Distinguishes capacity/cooldown pressure from successful repair starts. |
| Repair cooldowns / attempt caps / readiness timeouts | `0` / `0` / `0` | Shows whether throttling, rather than candidate selection alone, is bounding repair churn. |
| Suspect / delinquent slot-epochs | `0` / `0` | Separates early warning state from threshold-crossed delinquency. |
| Final repair backlog | `0` slots | Started repairs minus completed or timed-out repairs at run end. |
| High-bandwidth providers | `5` | Providers currently eligible for hot/high-bandwidth routing. |
| High-bandwidth promotions/demotions | `5` / `0` | Shows capability changes under measured demand. |
| Hot high-bandwidth serves/retrieval | `1.0449` | Measures whether hot retrievals actually use promoted providers. |
| Avg latency / Fail tier rate | `0` ms / `0.00%` | Separates correctness from QoS: slow-but-valid service can be available while still earning lower or no performance rewards. |
| Platinum / Gold / Silver / Fail serves | `0` / `0` / `0` / `0` | Shows the latency-tier distribution for performance-market policy. |
| Performance reward paid | `0.0000` | Quantifies the tiered QoS reward stream separately from baseline storage and retrieval settlement. |
| Provider latency p10 / p50 / p90 | `0` / `0` / `0` ms | Shows whether aggregate averages hide slow provider tails. |
| New deal latent/effective demand | `0` / `0` | Shows how much modeled write demand survived the price-elasticity curve. |
| New deal demand accepted/rejected/suppressed | `0` / `0` / `0` | Shows whether modeled write demand is entering the network, blocked by price/capacity, or never arriving because quotes are unattractive. |
| New deal effective/latent acceptance | `0.00%` / `0.00%` | Demand-side market health signal; a technically available network can still fail if users cannot afford storage. |
| Staged upload attempts/accepted/committed | `0` / `0` / `0` | Shows provisional upload pressure separately from committed storage demand. |
| Staged upload rejections/cleaned | `0` / `0` | Preflight rejection and retention cleanup should bound abandoned provisional generations. |
| Staged pending generations/MDUs peak | `0` / `0` | Detects whether local staged storage pressure exceeded configured caps. |
| Elasticity spend / rejections | `48.0000` / `0` | Shows whether user-funded overflow expansion stayed inside the spend window. |
| Elasticity overlays activated/served/expired | `48` / `393` / `18` | Confirms temporary overflow routes are created, actually used, and later removed. |
| Elasticity overlay ready/active peak | `24` / `30` | Shows catch-up/readiness lag and total temporary routing footprint. |
| Sponsored retrieval attempts/spend | `0` / `0.0000` | Shows public or requester-funded demand separately from owner-funded deal escrow. |
| Owner-funded attempts / owner escrow debit | `1920` / `0.0000` | Detects whether public demand is unexpectedly draining the deal owner's escrow. |
| Storage escrow locked/earned/refunded | `0.0000` / `0.0000` / `0.0000` | Shows quote-to-lock, provider earning, and close/refund accounting for committed storage. |
| Storage escrow outstanding | `0.0000` final; peak `0.0000` | Detects funds left locked after close/expiry semantics should have released them. |
| Storage fee provider payout/burned | `0.0000` / `0.0000` | Separates earned storage fees paid to eligible providers from fees withheld from non-compliant responsibility. |
| Deals open/closed/expired | `3` / `0` / `0` | Confirms close/refund/expiry semantics remove deals from active responsibility instead of continuing to accrue rewards. |
| Audit demand / spent | `0.0000` / `0.0000` | Shows whether enforcement evidence consumed the available audit budget. |
| Audit backlog / exhausted epochs | `0.0000` / `0` | Makes budget exhaustion explicit instead of hiding unmet audit work behind capped spending. |
| Evidence spam claims / convictions | `0` / `0` | Shows whether the evidence-market spam fixture exercised low-quality claims and any successful convictions. |
| Evidence spam bond / net gain | `0.0000` / `0.0000` | Spam should be negative-EV unless conviction-gated bounties justify the claim volume. |
| Top operator provider share | `2.77%` | Shows whether many SP identities are controlled by one operator. |
| Top operator assignment share | `2.77%` | Shows whether placement caps translate identity concentration into slot concentration. |
| Max operator slots/deal | `1` | Checks per-deal blast-radius limits against operator Sybil concentration. |
| Operator cap violations | `0` | Counts deals where operator slot concentration exceeded the configured cap. |
| Final storage utilization | `6.25%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `6.25%` / `6.25%` / `6.25%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `2.7825` / `3.0075` / `3.7400` | Shows whether aggregate P&L hides marginal-provider distress. |
| Provider cost shock epochs/providers | `0` / `0` | Shows when external cost pressure was active and how much of the provider population it affected. |
| Max cost shock fixed/storage/bandwidth | `100.00%` / `100.00%` / `100.00%` | Distinguishes fixed-cost, storage-cost, and egress-cost shocks. |
| Provider churn events / final churned | `0` / `0` | Shows whether sustained economic distress became modeled provider exits rather than only a warning label. |
| Provider entries / probation promotions | `0` / `0` | Shows whether reserve supply entered and cleared readiness gating before receiving normal placement. |
| Reserve / probationary / entered-active providers | `0` / `0` / `0` | Separates unused reserve supply, in-flight onboarding, and newly promoted active supply. |
| Underbonded repairs / peak underbonded providers | `0` / `0` | Shows whether insufficient provider collateral became placement/repair pressure. |
| Final underbonded assigned slots / bond deficit | `0` / `0.0000` | Checks whether repair removed responsibility from undercollateralized providers by run end. |
| Churn pressure provider-epochs / peak | `0` / `0` | Shows the breadth and duration of providers below the configured churn threshold. |
| Active / exited / reserve provider capacity | `576` / `0` / `0` slots | Measures supply remaining, removed, and still waiting outside normal placement. |
| Peak assigned slots on churned providers | `0` | Shows the maximum repair burden created by economic exits. |
| Storage price start/end/range | `1.0000` -> `1.0000` (`1.0000`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0100` -> `0.0100` (`0.0100`-`0.0100`) | Shows whether demand pressure moved retrieval pricing. |
| Retrieval latent/effective attempts | `1920` / `1920` | Shows how much retrieval load was added by demand-shock multipliers. |
| Retrieval demand shock epochs/multiplier | `0` / `100.00%` | Shows the size and duration of the modeled read-demand shock. |
| Price direction changes storage/retrieval | `0` / `0` | Detects controller oscillation rather than relying on visual inspection. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `global` | 36 | 6.25% | 0 | 2463 | 0 | 3.0886 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-017` | `global` | 1/16 | 6.25% | 64 | 691 | 0 | 187 | 3.9355 |
| `sp-014` | `global` | 1/16 | 6.25% | 62 | 654 | 0 | 173 | 3.7400 |
| `sp-008` | `global` | 1/16 | 6.25% | 65 | 671 | 0 | 166 | 3.9060 |
| `sp-011` | `global` | 1/16 | 6.25% | 65 | 657 | 0 | 154 | 3.8890 |
| `sp-033` | `global` | 1/16 | 6.25% | 45 | 465 | 0 | 108 | 2.6860 |
| `sp-025` | `global` | 1/16 | 6.25% | 49 | 485 | 0 | 94 | 3.0035 |
| `sp-010` | `global` | 1/16 | 6.25% | 46 | 452 | 0 | 87 | 2.7825 |
| `sp-027` | `global` | 1/16 | 6.25% | 46 | 451 | 0 | 86 | 2.7540 |

### Top Operators

| Operator | Providers | Provider Share | Assigned Slots | Assignment Share | Retrieval Attempts | Success | P&L |
|---|---:|---:|---:|---:|---:|---:|---:|
| `op-000` | 1 | 2.77% | 1 | 2.77% | 447 | 89.49% | 3.0230 |
| `op-001` | 1 | 2.77% | 1 | 2.77% | 462 | 90.48% | 3.1380 |
| `op-002` | 1 | 2.77% | 1 | 2.77% | 456 | 86.40% | 3.0290 |
| `op-003` | 1 | 2.77% | 1 | 2.77% | 449 | 83.96% | 2.8845 |
| `op-004` | 1 | 2.77% | 1 | 2.77% | 453 | 93.82% | 3.0075 |
| `op-005` | 1 | 2.77% | 1 | 2.77% | 496 | 91.13% | 3.2845 |
| `op-006` | 1 | 2.77% | 1 | 2.77% | 483 | 89.86% | 3.1885 |
| `op-007` | 1 | 2.77% | 1 | 2.77% | 437 | 81.46% | 2.7060 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 91.25% | 244 | 0 | 0 | 0 | 0.0000 | 13.3870 | 238 saturated, 6 overlay routes activated |
| 2 | 92.50% | 275 | 0 | 0 | 0 | 0.0000 | 13.5890 | 269 saturated, 6 overlay routes activated, 15 overlay serves |
| 3 | 92.50% | 341 | 0 | 0 | 0 | 0.0000 | 13.6010 | 335 saturated, 6 overlay routes activated, 58 overlay serves |
| 4 | 96.25% | 275 | 0 | 0 | 0 | 0.0000 | 14.2230 | 269 saturated, 6 overlay routes activated, 32 overlay serves |
| 5 | 95.42% | 332 | 0 | 0 | 0 | 0.0000 | 14.0810 | 326 saturated, 6 overlay routes activated, 62 overlay serves |
| 6 | 95.42% | 332 | 0 | 0 | 0 | 0.0000 | 14.0810 | 326 saturated, 6 overlay routes activated, 77 overlay serves, 6 overlay routes expired |
| 7 | 96.25% | 341 | 0 | 0 | 0 | 0.0000 | 14.2260 | 335 saturated, 6 overlay routes activated, 99 overlay serves, 6 overlay routes expired |
| 8 | 95.00% | 371 | 0 | 0 | 0 | 0.0000 | 14.0030 | 365 saturated, 6 overlay routes activated, 50 overlay serves, 6 overlay routes expired |

## Enforcement Interpretation

The simulator recorded `48` evidence events and `0` repair ledger events. The first evidence epoch was `1` and the first repair-start epoch was `none`.

Evidence by reason:

- `elasticity_overlay_activated`: `48`

Evidence by provider:

- `sp-011`: `4`
- `sp-031`: `4`
- `sp-008`: `4`
- `sp-017`: `4`
- `sp-014`: `4`
- `sp-026`: `4`
- `sp-016`: `4`
- `sp-018`: `4`

Repair summary:

- Repairs started: `0`
- Repairs marked ready: `0`
- Repairs completed: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldown backoffs: `0`
- Repair attempt-cap backoffs: `0`
- Repair readiness timeouts: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `0`
- Final active slots in last epoch: `36`

Candidate exclusion summary:

- No no-candidate repair backoffs were recorded.

### Repair Ledger Excerpt

- No repair ledger events were recorded.

## Economic Interpretation

The run minted `13.7600` reward/audit units and burned `9.1640` units, for a burn-to-mint ratio of `66.60%`.

Providers earned `143.3960` in modeled revenue against `32.2050` in modeled cost, ending with aggregate P&L `111.1910`.

Retrieval accounting paid providers `137.6360`, burned `1.9200` in base fees, and burned `7.2440` in variable retrieval fees.

Sponsored retrieval accounting spent `0.0000` across `0` sponsor-funded attempts; owner retrieval escrow debit was `0.0000`.

Storage escrow accounting locked `0.0000`, earned `0.0000`, refunded `0.0000`, paid providers `0.0000`, burned `0.0000`, and ended with outstanding escrow `0.0000`.

Performance-tier accounting paid `0.0000` in QoS rewards.

Audit accounting saw `0.0000` of demand, spent `0.0000`, and ended with `0.0000` backlog after `0` exhausted epochs.

Elasticity overlay accounting spent `48.0000` to activate `48` temporary routes, served `393` reads through overlay providers, rejected `0` expansion attempts, and expired `18` routes by TTL.

No provider ended with negative modeled P&L under the current assumptions.

Final modeled storage price was `1.0000` and retrieval price per slot was `0.0100`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-033` | 1 | 0.1600 + 3.3630 | 0.8370 | 0.0000 | 2.6860 | no |
| `sp-007` | 1 | 0.1600 + 3.3820 | 0.8360 | 0.0000 | 2.7060 | no |
| `sp-024` | 1 | 0.1600 + 3.4105 | 0.8490 | 0.0000 | 2.7215 | no |
| `sp-027` | 1 | 0.1600 + 3.4390 | 0.8450 | 0.0000 | 2.7540 | no |
| `sp-010` | 1 | 0.1600 + 3.4675 | 0.8450 | 0.0000 | 2.7825 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=0.943229167, required>=0.9 |
| `min_elasticity_overlay_activations` | `PASS` | Elasticity overlay fixture must activate temporary overflow routes. | elasticity_overlay_activations=48, required>=1 |
| `min_elasticity_overlay_serves` | `PASS` | Elasticity overlay routes must actually serve user reads after readiness. | elasticity_overlay_serves=393, required>=1 |
| `min_elasticity_overlay_expired` | `PASS` | Elasticity overlay TTL must remove temporary overflow routes. | elasticity_overlay_expired=18, required>=1 |
| `min_elasticity_spent` | `PASS` | Elasticity fixture must spend non-zero user-funded overflow budget. | elasticity_spent=48, required>=1 |
| `max_elasticity_overlay_rejections` | `PASS` | Positive-path overlay fixture should not hit spend-cap or candidate-selection rejection. | elasticity_overlay_rejections=0, required<=0 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |
| `max_providers_over_capacity` | `PASS` | Assignment must respect modeled provider capacity. | providers_over_capacity=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 1 | 3 | overlay | `sp-011` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 1 | 1 | overlay | `sp-031` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 1 | 2 | overlay | `sp-031` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 1 | 3 | overlay | `sp-008` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 1 | 1 | overlay | `sp-017` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 1 | 2 | overlay | `sp-011` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 2 | 3 | overlay | `sp-017` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 2 | 2 | overlay | `sp-008` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 2 | 1 | overlay | `sp-014` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 2 | 3 | overlay | `sp-014` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 2 | 2 | overlay | `sp-026` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| 2 | 1 | overlay | `sp-026` | `market` | `elasticity_overlay_activated` | `overflow_route` |
| ... | ... | ... | ... | ... | ... | `36` more events omitted |

## Generated Graphs

The following SVG graphs are generated beside this report and embedded here with relative Markdown links so the report is readable as a self-contained artifact in GitHub or a local Markdown viewer.

### Retrieval Success Rate

Should stay near 1.0 unless availability is actually lost.

![Retrieval Success Rate](graphs/retrieval_success_rate.svg)

### Slot State Transitions

Shows active slots and repair slots; spikes indicate reassignment churn.

![Slot State Transitions](graphs/slot_states.svg)

### Provider P&L

Shows aggregate provider economics over time.

![Provider P&L](graphs/provider_pnl.svg)

### Provider Cost Shock

Shows modeled provider cost pressure against provider revenue.

![Provider Cost Shock](graphs/provider_cost_shock.svg)

### Provider Churn

Shows modeled provider exits and per-epoch churn events.

![Provider Churn](graphs/provider_churn.svg)

### Provider Supply Entry

Shows reserve provider entry and probationary promotion into active supply.

![Provider Supply Entry](graphs/provider_supply.svg)

### Provider Bond Headroom

Shows underbonded providers and repairs triggered by insufficient assignment collateral.

![Provider Bond Headroom](graphs/provider_bond_headroom.svg)

### Burn / Mint Ratio

Shows whether burns are material relative to minted rewards and audit budget.

![Burn / Mint Ratio](graphs/burn_mint_ratio.svg)

### Storage Escrow Lifecycle

Shows storage escrow locked, earned, refunded, and still outstanding after close/refund semantics.

![Storage Escrow Lifecycle](graphs/storage_escrow_lifecycle.svg)

### Price Trajectory

Shows storage price and retrieval price movement under dynamic pricing.

![Price Trajectory](graphs/price_trajectory.svg)

### Retrieval Demand

Shows effective retrieval attempts against latent baseline demand.

![Retrieval Demand](graphs/retrieval_demand.svg)

### Storage Demand

Shows modeled new deal demand accepted versus rejected by price.

![Storage Demand](graphs/storage_demand.svg)

### Capacity Utilization

Shows active storage responsibility against modeled provider capacity.

![Capacity Utilization](graphs/capacity_utilization.svg)

### Saturation And Repair Pressure

Shows provider bandwidth saturation and repair backoffs, which are scale-specific stress signals.

![Saturation And Repair Pressure](graphs/saturation_and_repair.svg)

### Repair Backlog

Shows whether started repairs are accumulating faster than they complete.

![Repair Backlog](graphs/repair_backlog.svg)

### Repair Readiness

Shows pending-provider readiness timeouts against successful readiness events.

![Repair Readiness](graphs/repair_readiness.svg)

### High-Bandwidth Promotion

Shows capability promotion/demotion state over time for hot-path eligibility.

![High-Bandwidth Promotion](graphs/high_bandwidth_promotion.svg)

### Hot Retrieval Routing

Shows whether hot retrieval attempts are being served by promoted high-bandwidth providers.

![Hot Retrieval Routing](graphs/hot_retrieval_routing.svg)

### Performance Tiers

Shows the fast positive tier and Fail-tier service counts under the performance market.

![Performance Tiers](graphs/performance_tiers.svg)

### Operator Concentration

Shows whether operator assignment share is bounded despite provider identity concentration.

![Operator Concentration](graphs/operator_concentration.svg)

### Evidence Pressure

Shows soft liveness evidence and hard invalid-proof evidence by epoch.

![Evidence Pressure](graphs/evidence_pressure.svg)

### Evidence Spam Economics

Shows bond burn and bounty payout for low-quality deputy evidence claims.

![Evidence Spam Economics](graphs/evidence_spam.svg)

### Audit Budget

Shows whether miss-driven audit demand is spending budget or accumulating carryover.

![Audit Budget](graphs/audit_budget.svg)

### Audit Backlog

Shows unmet audit demand and exhausted-budget epochs when evidence exceeds available enforcement budget.

![Audit Backlog](graphs/audit_backlog.svg)

### Sponsored Retrieval Accounting

Shows sponsor-funded public retrieval spend against any owner deal-escrow debit.

![Sponsored Retrieval Accounting](graphs/sponsored_retrieval_accounting.svg)

### Elasticity Spend

Shows demand-funded elasticity spend and rejected expansion attempts.

![Elasticity Spend](graphs/elasticity_spend.svg)

### Elasticity Overlay Routes

Shows temporary overflow routes that are active or serving reads after user-funded elasticity scale-up.

![Elasticity Overlay Routes](graphs/elasticity_overlay_routes.svg)

### Staged Upload Pressure

Shows provisional-generation preflight rejections and retention cleanup for abandoned staged uploads.

![Staged Upload Pressure](graphs/staged_upload_pressure.svg)

## Raw Artifacts

- `summary.json`: compact machine-readable run summary.
- `epochs.csv`: per-epoch availability, liveness, reward, repair, and economics metrics.
- `providers.csv`: final provider-level economics, fault counters, and capability tier.
- `operators.csv`: final operator-level provider count, assignment share, success, and P&L metrics.
- `slots.csv`: per-slot epoch ledger, including health state and reason.
- `evidence.csv`: policy evidence events.
- `repairs.csv`: repair start, pending-provider readiness, readiness timeout, completion, attempt-count, cooldown, candidate-exclusion, attempt-cap, and backoff events.
- `economy.csv`: per-epoch market, elasticity overlay, staged upload, and accounting ledger.
- `signals.json`: derived availability, saturation, repair, capacity, economic, elasticity overlay, staged upload, regional, concentration, and provider bottleneck signals.
