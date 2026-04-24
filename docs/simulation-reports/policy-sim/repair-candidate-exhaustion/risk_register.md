# Risk Register: Repair Candidate Exhaustion

Model a network with no spare replacement capacity. The expected behavior is explicit repair backoff and operator visibility, not silent over-assignment.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Repair coordination bottleneck | `medium` | 40 repair backoffs across 8 attempts; 16 cooldowns and 16 attempt-cap events. | The network may detect bad slots faster than it can safely heal them. | Review max repair starts per epoch, replacement capacity, retry cooldowns, attempt caps, and catch-up probability assumptions. |

## Evidence Counters

- Evidence events: `80`
- Repair events: `40`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `40`
- Repair attempts: `8`
- Repair backoffs: `40`
- Repair cooldowns: `16`
- Repair attempt-cap events: `16`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
