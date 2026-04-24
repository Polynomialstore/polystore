# Risk Register: Subsidy Farming

Model providers attempting to collect base rewards while skipping useful liveness work. The policy concern is reward leakage, not retrieval correctness alone.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider economic churn pressure | `medium` | 6 of 72 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |

## Evidence Counters

- Evidence events: `96`
- Repair events: `144`
- Failed assertions: `0`
- Providers with negative P&L: `6`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `1.38%`
- Top operator assignment share: `2.08%`
- Operator cap violations: `0`
- Suspect slot-epochs: `48`
- Delinquent slot-epochs: `96`
- Repair attempts: `48`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
