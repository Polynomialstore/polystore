# Risk Register: Elasticity Cap Hit

Model demand above the user-funded elasticity budget. The desired behavior is fail-closed spending: the simulator should record rejections instead of silently exceeding the configured cap.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Elasticity demand rejected by spend cap | `medium` | 5 elasticity attempts were rejected. | The system correctly fails closed, but users may experience capacity limits during demand spikes. | Decide whether this is acceptable UX or whether user-funded burst budgets need product controls. |

## Evidence Counters

- Evidence events: `0`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `5`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
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
