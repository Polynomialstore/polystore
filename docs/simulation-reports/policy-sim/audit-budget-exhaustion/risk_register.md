# Risk Register: Audit Budget Exhaustion

Model many soft failures with an intentionally tight audit budget. The policy concern is whether audit spending remains capped instead of becoming an unbounded protocol subsidy.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider economic churn pressure | `medium` | 4 of 60 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |

## Evidence Counters

- Evidence events: `64`
- Repair events: `96`
- Failed assertions: `0`
- Providers with negative P&L: `4`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Repair backoffs: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
