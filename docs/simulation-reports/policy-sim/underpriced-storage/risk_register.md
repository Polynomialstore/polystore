# Risk Register: Underpriced Storage Market

Model a technically healthy network whose prices do not cover provider costs. This is not an availability failure; it is a market-equilibrium warning that rational providers would churn even though the protocol appears healthy.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider economic churn pressure | `high` | 48 of 48 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |

## Evidence Counters

- Evidence events: `0`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `48`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
