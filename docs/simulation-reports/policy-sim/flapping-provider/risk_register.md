# Risk Register: Flapping Provider

Model a provider with intermittent outages that recover before the delinquency threshold. This is the anti-thrash fixture: normal infrastructure jitter should create evidence and operator visibility without needless slot churn.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Evidence without repair | `high` | 46 evidence events and 0 repair events. | The simulator may be measuring bad behavior without enforcing recovery. | Review enforcement mode and repair thresholds. |

## Evidence Counters

- Evidence events: `46`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Suspect slot-epochs: `24`
- Delinquent slot-epochs: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
