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
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `8.33%`
- Top operator assignment share: `8.33%`
- Operator cap violations: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `40`
- Repair attempts: `8`
- Repair backoffs: `40`
- Repair cooldowns: `16`
- Repair attempt-cap events: `16`
- Audit budget demand: `0.4000`
- Audit budget spent: `0.4000`
- Audit budget backlog: `0.0000`
- Audit budget exhausted epochs: `0`
- Evidence spam claims: `0`
- Evidence spam bond burned: `0.0000`
- Evidence spam bounty paid: `0.0000`
- Evidence spam net gain: `0.0000`
- Provider cost shock active epochs: `0`
- Max cost-shocked providers: `0`
- Latent new deal requests: `0`
- Effective new deal requests: `0`
- New deals accepted: `0`
- New deals suppressed by price elasticity: `0`
- New deals rejected by price: `0`
- New deals rejected by capacity: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
