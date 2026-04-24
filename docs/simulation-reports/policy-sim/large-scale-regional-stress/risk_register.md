# Risk Register: Large-Scale Regional Stress

Model a population-scale network with more than one thousand storage providers and thousands of users. Providers have heterogeneous capacity, bandwidth, reliability, cost, region, and repair coordination probability. A correlated regional outage and dynamic pricing test whether network state, price, retrieval success, and healing remain stable under scale.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| User-facing availability loss | `medium` | 1065 unavailable reads; success rate 99.26%. | Temporary read misses are acceptable only when explicitly allowed by the scenario contract and data loss remains zero. | If this is a scale fixture, track it as an availability tuning item. Otherwise block graduation and investigate routing, redundancy, repair timing, and provider selection. |
| Provider economic churn pressure | `medium` | 4 of 1200 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |
| Provider bandwidth saturation | `medium` | 15482 provider responses saturated before serving. | Retrieval demand may exceed heterogeneous provider bandwidth before the storage layer notices a hard fault. | Review bandwidth admission, route_attempt_limit, retrieval pricing, and elasticity policy. |
| Repair coordination bottleneck | `medium` | 12436 repair backoffs across 16060 attempts; 0 cooldowns and 0 attempt-cap events. | The network may detect bad slots faster than it can safely heal them. | Review max repair starts per epoch, replacement capacity, retry cooldowns, attempt caps, and catch-up probability assumptions. |

## Evidence Counters

- Evidence events: `31338`
- Repair events: `22160`
- Failed assertions: `0`
- Providers with negative P&L: `4`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `15482`
- Suspect slot-epochs: `361`
- Delinquent slot-epochs: `25634`
- Repair attempts: `16060`
- Repair backoffs: `12436`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
