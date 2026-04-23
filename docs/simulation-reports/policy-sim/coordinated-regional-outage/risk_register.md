# Risk Register: Coordinated Regional Outage

Model a smaller correlated regional outage than the expensive scale case. This provides a cheaper fixture for placement diversity, repair, and regional risk analysis.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Repair coordination bottleneck | `medium` | 1144 repair attempts backed off. | The network may detect bad slots faster than it can safely heal them. | Review max repair starts per epoch, replacement capacity, and catch-up probability assumptions. |

## Evidence Counters

- Evidence events: `1540`
- Repair events: `1336`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Repair backoffs: `1144`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
