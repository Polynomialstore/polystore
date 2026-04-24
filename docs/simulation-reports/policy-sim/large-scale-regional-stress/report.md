# Policy Simulation Report: Large-Scale Regional Stress

## Executive Summary

**Verdict:** `PASS`. This run simulates `large-scale-regional-stress` with `1200` providers, `3000` data users, `1500` deals, and an RS `8+4` layout for `24` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model a population-scale network with more than one thousand storage providers and thousands of users. Providers have heterogeneous capacity, bandwidth, reliability, cost, region, and repair coordination probability. A correlated regional outage and dynamic pricing test whether network state, price, retrieval success, and healing remain stable under scale.

Expected policy behavior: Availability should stay above the configured floor, price should remain bounded, saturation and repair backoffs should be visible, and no provider should be assigned above modeled capacity.

Observed result: retrieval success was `99.26%`, reward coverage was `96.12%`, repairs started/ready/completed were `3624` / `3050` / `3050`, and `4` providers ended with negative modeled P&L. The run recorded `1065` unavailable reads, `0` modeled data-loss events, `15482` bandwidth saturation responses and `12436` repair backoffs across `16060` repair attempts. Slot health recorded `361` suspect slot-epochs and `25634` delinquent slot-epochs. High-bandwidth promotions were `0` and final high-bandwidth providers were `0`.

## Review Focus

Use this report to inspect aggregate network state rather than a single bad actor: utilization, price trajectory, bandwidth saturation, repair throughput, and provider P&L distribution.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `29` |
| Providers | `1200` |
| Data users | `3000` |
| Deals | `1500` |
| Epochs | `24` |
| Erasure coding | `K=8`, `M=4`, `N=12` |
| User MDUs per deal | `16` |
| Retrievals/user/epoch | `2` |
| Liveness quota | `2`-`8` blobs/slot/epoch |
| Repair delay | `3` epochs |
| Repair attempt cap/slot | `0` (`0` means unlimited) |
| Repair backoff window | `0` epochs |
| Dynamic pricing | `true` |
| Storage price | `1.0000` |
| New deal requests/epoch | `0` |
| Storage demand price ceiling | `0.0000` (`0` means disabled) |
| Storage demand reference price | `0.0000` (`0` disables elasticity) |
| Storage demand elasticity | `0.00%` |
| Retrieval price/slot | `0.0110` |
| Provider capacity range | `16`-`36` slots |
| Provider bandwidth range | `35`-`140` serves/epoch (`0` means unlimited) |
| Service class | `General` |
| Performance market | `false` |
| Provider latency range | `0`-`0` ms |
| Latency tier windows | Platinum <= `100` ms, Gold <= `250` ms, Silver <= `500` ms |
| High-bandwidth promotion | `false` |
| High-bandwidth capacity threshold | `0` serves/epoch |
| Hot retrieval share | `0.00%` |
| Operators | `1200` |
| Dominant operator provider share | `0.00%` |
| Operator assignment cap/deal | `0` (`0` means disabled) |
| Provider regions | `na, eu, apac, sa, af, oc` |

## Economic Assumptions

The economic model is intentionally simple and deterministic. It is useful for comparing policy directions, not for setting final token economics without external market data.

| Assumption | Value | Interpretation |
|---|---:|---|
| Storage price | `1.0000` | Unitless price applied by the controller, demand-elasticity curve, and optional affordability gate. |
| New deal requests/epoch | `0` | Latent modeled write demand before optional price elasticity suppression. Effective requests are accepted only when price and capacity gates pass. |
| Storage demand price ceiling | `0.0000` | If non-zero, new deal demand above this storage price is rejected as unaffordable. |
| Storage demand reference price | `0.0000` | If non-zero with elasticity enabled, demand scales around this price before hard affordability rejection. |
| Storage demand elasticity | `0.00%` | Demand multiplier change for a 100% price move relative to the reference price, clamped by configured min/max demand bps. |
| Storage target utilization | `65.00%` | If dynamic pricing is enabled, utilization above this target steps storage price up, otherwise down. |
| Retrieval price per slot | `0.0110` | Paid per successful provider slot served, before the configured variable burn. |
| Retrieval target per epoch | `5000` | If dynamic pricing is enabled, retrieval attempts above this target step retrieval price up, otherwise down. |
| Retrieval demand shocks | `[]` | Optional epoch-scoped retrieval demand multipliers used to test price shock response and oscillation. |
| Dynamic pricing max step | `3.50%` | Per-epoch controller movement cap. Lower values are safer but slower to equilibrate. |
| Base reward per slot | `0.0180` | Modeled issuance/subsidy paid only to reward-eligible active slots. |
| Provider storage cost/slot/epoch | `0.0120` | Simplified provider cost basis; jitter may create marginal-provider distress. |
| Provider bandwidth cost/retrieval | `0.0015` | Simplified egress cost basis for retrieval-heavy scenarios. |
| Provider initial/min bond | `100.0000` / `0.0000` | Simplified collateral model. Providers below the required bond are excluded from new responsibility and can trigger repair. |
| Provider bond per assigned slot | `0.0000` | Additional modeled collateral required for each assigned storage slot. |
| Provider cost shocks | `[]` | Optional epoch-scoped fixed/storage/bandwidth cost multipliers used to model sudden operator cost pressure. |
| Provider churn policy | enabled `False`, threshold `0.0000`, after `1` epochs, cap `0`/epoch | Converts sustained negative economics into draining exits; cap `0` means unbounded by this policy. |
| Provider churn floor | `0` providers | Prevents an economic shock fixture from exiting the entire active set unless intentionally configured. |
| Provider supply entry | enabled `False`, reserve `0`, cap `1`/epoch, probation `1` epochs | Moves reserve providers through probation before they become assignment-eligible active supply. |
| Supply entry triggers | utilization >= `0.00%` or storage price >= `disabled` | If both are zero, configured reserve supply enters as soon as the epoch window opens. |
| Performance reward per serve | `0.0000` | Optional tiered QoS reward. Multipliers are applied by latency tier and Fail tier receives the configured fail multiplier. |
| Audit budget per epoch | `25.0000` | Minted audit budget; spending is capped by available budget and unmet miss-driven demand carries forward as backlog. |
| Evidence spam claims/epoch | `0` | Synthetic low-quality deputy claims used to test bond burn and bounty gating economics. |
| Evidence bond / bounty | `0.0000` / `0.0000` | Spam claims burn bond unless convicted; bounty is paid only on convicted evidence. |
| Retrieval burn | `7.50%` | Fraction of variable retrieval fees burned before provider payout. |

## What Happened

Availability was degraded: the run succeeded on `99.26%` of retrievals and recorded `1065` unavailable reads.

The policy layer recorded `31338` evidence events: `31338` soft, `0` threshold, `0` hard, `0` economic, `0` market, and `0` spam events. Soft and economic evidence are suitable for repair and reward exclusion; hard or convicted threshold evidence is the category that can later justify slashing or stronger sanctions.

Repair was exercised: `3624` repair operations started, `3050` produced pending-provider readiness evidence, and `3050` completed. The simulator models this as make-before-break reassignment, so the old assignment remains visible until replacement work catches up and the readiness gate is satisfied.

Reward exclusion was active: `292.9860` modeled reward units were burned instead of paid to non-compliant slots.

Provider bandwidth constraints mattered: the run recorded `15482` saturated provider responses. That is a scale signal, not necessarily malicious behavior.

Repair coordination was constrained: `12436` repair backoffs occurred across `16060` repair attempts. Cooldown backoffs accounted for `0` events and attempt-cap backoffs accounted for `0` events.

The directly implicated provider set begins with: `sp-001, sp-007, sp-008, sp-012, sp-013`.

## Diagnostic Signals

These are derived from the raw CSV/JSON outputs and are intended to make scale behavior reviewable without manually scanning ledgers.

| Signal | Value | Why It Matters |
|---|---:|---|
| Worst epoch success | `96.33%` at epoch `10` | Identifies the availability cliff instead of hiding it in aggregate success. |
| Unavailable reads | `1065` | Temporary read failures are a scale/reliability signal; they are not automatically permanent data loss. |
| Modeled data-loss events | `0` | Durability-loss signal. This should remain zero for current scale fixtures. |
| Degraded epochs | `19` | Counts epochs with unavailable reads or success below 99.9%. |
| Recovery epoch after worst | `18` | Shows whether the network returned to clean steady state after the worst point. |
| Saturation rate | `10.75%` | Provider bandwidth saturation per retrieval attempt. |
| Peak saturation | `1534` at epoch `10` | Reveals when bandwidth, not storage correctness, became the bottleneck. |
| Repair readiness ratio | `84.16%` | Measures whether pending providers catch up before promotion. |
| Repair completion ratio | `84.16%` | Measures whether healing catches up with detection. |
| Repair attempts | `16060` | Counts bounded attempts to open a repair or discover replacement pressure. |
| Repair backoff pressure | `3.4316` backoffs per started repair | Shows whether repair coordination is saturated. |
| Repair backoffs per attempt | `0.7743` | Distinguishes capacity/cooldown pressure from successful repair starts. |
| Repair cooldowns / attempt caps | `0` / `0` | Shows whether throttling, rather than candidate selection alone, is bounding repair churn. |
| Suspect / delinquent slot-epochs | `361` / `25634` | Separates early warning state from threshold-crossed delinquency. |
| Final repair backlog | `574` slots | Started repairs minus completed repairs at run end. |
| High-bandwidth providers | `0` | Providers currently eligible for hot/high-bandwidth routing. |
| High-bandwidth promotions/demotions | `0` / `0` | Shows capability changes under measured demand. |
| Hot high-bandwidth serves/retrieval | `0` | Measures whether hot retrievals actually use promoted providers. |
| Avg latency / Fail tier rate | `0` ms / `0.00%` | Separates correctness from QoS: slow-but-valid service can be available while still earning lower or no performance rewards. |
| Platinum / Gold / Silver / Fail serves | `0` / `0` / `0` / `0` | Shows the latency-tier distribution for performance-market policy. |
| Performance reward paid | `0.0000` | Quantifies the tiered QoS reward stream separately from baseline storage and retrieval settlement. |
| Provider latency p10 / p50 / p90 | `0` / `0` / `0` ms | Shows whether aggregate averages hide slow provider tails. |
| New deal latent/effective demand | `0` / `0` | Shows how much modeled write demand survived the price-elasticity curve. |
| New deal demand accepted/rejected/suppressed | `0` / `0` / `0` | Shows whether modeled write demand is entering the network, blocked by price/capacity, or never arriving because quotes are unattractive. |
| New deal effective/latent acceptance | `0.00%` / `0.00%` | Demand-side market health signal; a technically available network can still fail if users cannot afford storage. |
| Audit demand / spent | `313.3800` / `313.3800` | Shows whether enforcement evidence consumed the available audit budget. |
| Audit backlog / exhausted epochs | `0.0000` / `0` | Makes budget exhaustion explicit instead of hiding unmet audit work behind capped spending. |
| Evidence spam claims / convictions | `0` / `0` | Shows whether the evidence-market spam fixture exercised low-quality claims and any successful convictions. |
| Evidence spam bond / net gain | `0.0000` / `0.0000` | Spam should be negative-EV unless conviction-gated bounties justify the claim volume. |
| Top operator provider share | `0.08%` | Shows whether many SP identities are controlled by one operator. |
| Top operator assignment share | `0.13%` | Shows whether placement caps translate identity concentration into slot concentration. |
| Max operator slots/deal | `1` | Checks per-deal blast-radius limits against operator Sybil concentration. |
| Operator cap violations | `0` | Counts deals where operator slot concentration exceeded the configured cap. |
| Final storage utilization | `55.69%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `61.11%` / `94.44%` / `100.00%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `8.4821` / `15.7663` / `18.1663` | Shows whether aggregate P&L hides marginal-provider distress. |
| Provider cost shock epochs/providers | `0` / `0` | Shows when external cost pressure was active and how much of the provider population it affected. |
| Max cost shock fixed/storage/bandwidth | `100.00%` / `100.00%` / `100.00%` | Distinguishes fixed-cost, storage-cost, and egress-cost shocks. |
| Provider churn events / final churned | `0` / `0` | Shows whether sustained economic distress became modeled provider exits rather than only a warning label. |
| Provider entries / probation promotions | `0` / `0` | Shows whether reserve supply entered and cleared readiness gating before receiving normal placement. |
| Reserve / probationary / entered-active providers | `0` / `0` / `0` | Separates unused reserve supply, in-flight onboarding, and newly promoted active supply. |
| Underbonded repairs / peak underbonded providers | `0` / `0` | Shows whether insufficient provider collateral became placement/repair pressure. |
| Final underbonded assigned slots / bond deficit | `0` / `0.0000` | Checks whether repair removed responsibility from undercollateralized providers by run end. |
| Churn pressure provider-epochs / peak | `289` / `18` | Shows the breadth and duration of providers below the configured churn threshold. |
| Active / exited / reserve provider capacity | `31289` / `0` / `0` slots | Measures supply remaining, removed, and still waiting outside normal placement. |
| Peak assigned slots on churned providers | `0` | Shows the maximum repair burden created by economic exits. |
| Storage price start/end/range | `1.0000` -> `0.4407` (`0.4407`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0110` -> `0.0243` (`0.0110`-`0.0243`) | Shows whether demand pressure moved retrieval pricing. |
| Retrieval latent/effective attempts | `144000` / `144000` | Shows how much retrieval load was added by demand-shock multipliers. |
| Retrieval demand shock epochs/multiplier | `0` / `100.00%` | Shows the size and duration of the modeled read-demand shock. |
| Price direction changes storage/retrieval | `0` / `0` | Detects controller oscillation rather than relying on visual inspection. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `af` | 200 | 59.14% | 1781 | 3293 | 1 | 15.3142 |
| `apac` | 200 | 58.26% | 2116 | 3128 | 0 | 14.8904 |
| `eu` | 200 | 47.16% | 42126 | 585 | 3 | 8.9747 |
| `na` | 200 | 59.70% | 1434 | 3422 | 0 | 15.2489 |
| `oc` | 200 | 59.67% | 1701 | 2392 | 0 | 14.9955 |
| `sa` | 200 | 61.27% | 1235 | 2662 | 0 | 15.5311 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-127` | `eu` | 3/35 | 8.57% | 125 | 776 | 299 | 0 | 3.8598 |
| `sp-439` | `eu` | 14/31 | 45.16% | 39 | 962 | 242 | 47 | 9.4818 |
| `sp-901` | `eu` | 15/26 | 57.69% | 94 | 1083 | 287 | 0 | 10.5070 |
| `sp-595` | `eu` | 15/36 | 41.66% | 60 | 1085 | 286 | 0 | 10.7843 |
| `sp-109` | `eu` | 13/18 | 72.22% | 40 | 985 | 266 | 20 | 9.0032 |
| `sp-751` | `eu` | 22/26 | 84.61% | 110 | 1280 | 284 | 0 | 13.6805 |
| `sp-997` | `eu` | 14/31 | 45.16% | 38 | 944 | 206 | 70 | 9.0333 |
| `sp-949` | `eu` | 17/20 | 85.00% | 121 | 1129 | 272 | 0 | 12.2693 |

### Top Operators

| Operator | Providers | Provider Share | Assigned Slots | Assignment Share | Retrieval Attempts | Success | P&L |
|---|---:|---:|---:|---:|---:|---:|---:|
| `op-616` | 1 | 0.08% | 25 | 0.13% | 1402 | 100.00% | 21.9598 |
| `op-1043` | 1 | 0.08% | 23 | 0.12% | 1277 | 100.00% | 18.6942 |
| `op-368` | 1 | 0.08% | 23 | 0.12% | 1363 | 99.71% | 21.0388 |
| `op-670` | 1 | 0.08% | 23 | 0.12% | 1263 | 98.65% | 19.6036 |
| `op-928` | 1 | 0.08% | 23 | 0.12% | 1239 | 100.00% | 19.3200 |
| `op-056` | 1 | 0.08% | 22 | 0.12% | 1260 | 100.00% | 19.5548 |
| `op-1029` | 1 | 0.08% | 22 | 0.12% | 1259 | 100.00% | 18.7013 |
| `op-258` | 1 | 0.08% | 22 | 0.12% | 1351 | 100.00% | 21.2566 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 99.78% | 1379 | 180 | 0 | 0 | 3.6900 | 472.3180 | 511 offline responses, 497 saturated, 180 quota misses, 11 repair backoffs, 15 suspect slots, 190 delinquent slots |
| 2 | 100.00% | 1085 | 138 | 0 | 0 | 2.6640 | 488.1882 | 391 offline responses, 421 saturated, 135 quota misses, 180 slots repairing, 10 suspect slots, 318 delinquent slots |
| 3 | 100.00% | 1009 | 126 | 0 | 0 | 2.3940 | 503.6600 | 316 offline responses, 459 saturated, 108 quota misses, 318 slots repairing, 7 suspect slots, 444 delinquent slots |
| 4 | 100.00% | 958 | 121 | 102 | 102 | 2.3220 | 519.8743 | 267 offline responses, 468 saturated, 102 quota misses, 444 slots repairing, 8 suspect slots, 463 delinquent slots |
| 5 | 99.90% | 1204 | 168 | 121 | 121 | 3.1500 | 537.0365 | 452 offline responses, 434 saturated, 150 quota misses, 463 slots repairing, 7 suspect slots, 510 delinquent slots |
| 6 | 99.97% | 907 | 113 | 139 | 139 | 2.1960 | 556.9552 | 306 offline responses, 378 saturated, 110 quota misses, 510 slots repairing, 9 suspect slots, 484 delinquent slots |
| 7 | 99.75% | 1230 | 168 | 117 | 117 | 3.3120 | 575.4129 | 461 offline responses, 436 saturated, 165 quota misses, 484 slots repairing, 16 suspect slots, 535 delinquent slots |
| 8 | 96.65% | 16790 | 180 | 114 | 114 | 54.4680 | 525.4441 | 9595 offline responses, 1288 saturated, 3025 quota misses, 2703 repair backoffs, 535 slots repairing, 170 suspect slots, 3277 delinquent slots |
| 9 | 96.35% | 16131 | 180 | 108 | 108 | 51.1200 | 546.8025 | 9148 offline responses, 1413 saturated, 2836 quota misses, 2692 repair backoffs, 601 slots repairing, 5 suspect slots, 3328 delinquent slots |
| 10 | 96.33% | 15270 | 180 | 134 | 134 | 47.5380 | 570.5596 | 8585 offline responses, 1534 saturated, 2635 quota misses, 2485 repair backoffs, 673 slots repairing, 6 suspect slots, 3174 delinquent slots |
| 11 | 97.47% | 14159 | 180 | 127 | 127 | 44.7660 | 602.6376 | 7982 offline responses, 1340 saturated, 2475 quota misses, 2326 repair backoffs, 719 slots repairing, 3 suspect slots, 3076 delinquent slots |
| 12 | 97.65% | 13782 | 180 | 150 | 150 | 42.4800 | 628.6651 | 7827 offline responses, 1378 saturated, 2342 quota misses, 2197 repair backoffs, 772 slots repairing, 8 suspect slots, 2974 delinquent slots |
| 13 | 99.92% | 950 | 119 | 175 | 175 | 2.2140 | 709.0768 | 296 offline responses, 432 saturated, 105 quota misses, 802 slots repairing, 4 suspect slots, 746 delinquent slots |
| 14 | 99.25% | 1385 | 152 | 180 | 180 | 2.8620 | 730.3403 | 434 offline responses, 664 saturated, 135 quota misses, 746 slots repairing, 7 suspect slots, 718 delinquent slots |
| 15 | 99.93% | 1186 | 170 | 267 | 267 | 3.2760 | 762.3572 | 434 offline responses, 425 saturated, 157 quota misses, 718 slots repairing, 12 suspect slots, 621 delinquent slots |
| 16 | 99.87% | 952 | 111 | 168 | 168 | 2.2140 | 792.1959 | 283 offline responses, 451 saturated, 107 quota misses, 621 slots repairing, 12 suspect slots, 564 delinquent slots |
| 17 | 99.83% | 917 | 99 | 173 | 173 | 1.8540 | 821.7166 | 256 offline responses, 479 saturated, 83 quota misses, 564 slots repairing, 4 suspect slots, 490 delinquent slots |
| 18 | 100.00% | 971 | 153 | 157 | 157 | 2.8980 | 853.1627 | 388 offline responses, 287 saturated, 143 quota misses, 490 slots repairing, 8 suspect slots, 486 delinquent slots |
| 19 | 99.82% | 1285 | 157 | 138 | 138 | 3.0420 | 882.1683 | 420 offline responses, 562 saturated, 146 quota misses, 486 slots repairing, 12 suspect slots, 505 delinquent slots |
| 20 | 99.97% | 1239 | 164 | 111 | 111 | 3.0960 | 914.7988 | 455 offline responses, 461 saturated, 159 quota misses, 505 slots repairing, 8 suspect slots, 558 delinquent slots |
| 21 | 99.97% | 965 | 123 | 137 | 137 | 2.3760 | 947.3959 | 323 offline responses, 402 saturated, 117 quota misses, 558 slots repairing, 9 suspect slots, 544 delinquent slots |
| 22 | 99.88% | 893 | 118 | 156 | 156 | 2.1960 | 980.9474 | 268 offline responses, 411 saturated, 96 quota misses, 544 slots repairing, 4 suspect slots, 506 delinquent slots |
| 23 | 100.00% | 1137 | 164 | 141 | 141 | 3.1140 | 1017.0526 | 445 offline responses, 374 saturated, 154 quota misses, 506 slots repairing, 9 suspect slots, 529 delinquent slots |
| 24 | 99.97% | 1429 | 180 | 135 | 135 | 3.7440 | 1052.1894 | 550 offline responses, 488 saturated, 189 quota misses, 22 repair backoffs, 529 slots repairing, 8 suspect slots, 594 delinquent slots |

## Enforcement Interpretation

The simulator recorded `31338` evidence events and `22160` repair ledger events. The first evidence epoch was `1` and the first repair-start epoch was `1`.

Evidence by reason:

- `quota_shortfall`: `15854`
- `deputy_served_zero_direct`: `15484`

Evidence by provider:

- `sp-847`: `166`
- `sp-127`: `165`
- `sp-1015`: `158`
- `sp-289`: `156`
- `sp-751`: `155`
- `sp-769`: `154`
- `sp-667`: `153`
- `sp-1069`: `153`

Repair summary:

- Repairs started: `3624`
- Repairs marked ready: `3050`
- Repairs completed: `3050`
- Repair attempts: `16060`
- Repair backoffs: `12436`
- Repair cooldown backoffs: `0`
- Repair attempt-cap backoffs: `0`
- Suspect slot-epochs: `361`
- Delinquent slot-epochs: `25634`
- Final active slots in last epoch: `17426`

Candidate exclusion summary:

- No no-candidate repair backoffs were recorded.

### Repair Ledger Excerpt

| Epoch | Event | Deal | Slot | Old Provider | New Provider | Reason | Attempt | Cooldown Until |
|---:|---|---:|---:|---|---|---|---:|---:|
| 1 | `repair_started` | 2 | 0 | `sp-012` | `sp-973` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 11 | 2 | `sp-122` | `sp-970` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 14 | 7 | `sp-163` | `sp-1176` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 27 | 11 | `sp-323` | `sp-984` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 31 | 6 | `sp-366` | `sp-151` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 54 | 2 | `sp-638` | `sp-1195` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 62 | 8 | `sp-740` | `sp-1125` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 70 | 0 | `sp-828` | `sp-744` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 77 | 6 | `sp-918` | `sp-738` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 91 | 6 | `sp-1086` | `sp-000` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 96 | 7 | `sp-1147` | `sp-587` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 96 | 11 | `sp-1151` | `sp-372` | `deputy_served_zero_direct` | 1 | 0 |
| ... | ... | ... | ... | ... | ... | `22148` more events omitted | ... | ... |

## Economic Interpretation

The run minted `8146.1760` reward/audit units and burned `2023.2973` units, for a burn-to-mint ratio of `24.84%`.

Providers earned `25041.6965` in modeled revenue against `8050.7407` in modeled cost, ending with aggregate P&L `16990.9558`.

Retrieval accounting paid providers `17788.5065`, burned `288.0000` in base fees, and burned `1442.3113` in variable retrieval fees.

Performance-tier accounting paid `0.0000` in QoS rewards.

Audit accounting saw `313.3800` of demand, spent `313.3800`, and ended with `0.0000` backlog after `0` exhausted epochs.

`4` providers ended with negative P&L and `4` were marked as churn risk. That is economically important even when retrieval success is perfect.

Final modeled storage price was `0.4407` and retrieval price per slot was `0.0243`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-037` | 0 | 0.2700 + 0.2951 | 1.7698 | 0.0000 | -1.2047 | yes |
| `sp-1147` | 3 | 0.4500 + 1.5442 | 2.6191 | 0.0000 | -0.6249 | yes |
| `sp-163` | 3 | 0.4140 + 1.4410 | 2.3094 | 0.0000 | -0.4544 | yes |
| `sp-382` | 1 | 0.9360 + 1.6196 | 2.5611 | 0.0000 | -0.0056 | yes |
| `sp-1154` | 3 | 0.7020 + 2.0264 | 2.6792 | 0.0000 | 0.0493 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=0.992604167, required>=0.985 |
| `min_saturated_responses` | `PASS` | Scale fixture must expose provider bandwidth saturation. | saturated_responses=15482, required>=1 |
| `min_repairs_started` | `PASS` | Repair liveness: policy must start reassignment when evidence warrants it. | repairs_started=3624, required>=1 |
| `min_repairs_ready` | `PASS` | Repair readiness: pending providers must produce catch-up evidence before promotion. | repairs_ready=3050, required>=1 |
| `min_repairs_completed` | `PASS` | Repair completion: make-before-break reassignment must finish within the run. | repairs_completed=3050, required>=1 |
| `min_repair_backoffs` | `PASS` | Scale fixture must expose healing coordination pressure. | repair_backoffs=12436, required>=1 |
| `max_providers_over_capacity` | `PASS` | Assignment must respect modeled provider capacity. | providers_over_capacity=0, required<=0 |
| `min_final_storage_utilization_bps` | `PASS` | Network utilization should be high enough to make pricing/healing meaningful. | final_storage_utilization_bps=5569, required>=4500 |
| `max_final_storage_utilization_bps` | `PASS` | Network utilization should remain below the capacity cliff. | final_storage_utilization_bps=5569, required<=8500 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |
| `max_paid_corrupt_bytes` | `PASS` | Corrupt data must not earn payment. | paid_corrupt_bytes=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 1 | 2 | 0 | `sp-012` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 2 | 0 | `sp-012` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 11 | 2 | `sp-122` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 14 | 7 | `sp-163` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 14 | 7 | `sp-163` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 27 | 11 | `sp-323` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 27 | 11 | `sp-323` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 31 | 6 | `sp-366` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 31 | 6 | `sp-366` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 54 | 2 | `sp-638` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 54 | 2 | `sp-638` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 62 | 8 | `sp-740` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| ... | ... | ... | ... | ... | ... | `31326` more events omitted |

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

### Elasticity Spend

Shows demand-funded elasticity spend and rejected expansion attempts.

![Elasticity Spend](graphs/elasticity_spend.svg)

## Raw Artifacts

- `summary.json`: compact machine-readable run summary.
- `epochs.csv`: per-epoch availability, liveness, reward, repair, and economics metrics.
- `providers.csv`: final provider-level economics, fault counters, and capability tier.
- `operators.csv`: final operator-level provider count, assignment share, success, and P&L metrics.
- `slots.csv`: per-slot epoch ledger, including health state and reason.
- `evidence.csv`: policy evidence events.
- `repairs.csv`: repair start, pending-provider readiness, completion, attempt-count, cooldown, candidate-exclusion, attempt-cap, and backoff events.
- `economy.csv`: per-epoch market and accounting ledger.
- `signals.json`: derived availability, saturation, repair, capacity, economic, regional, concentration, and provider bottleneck signals.
