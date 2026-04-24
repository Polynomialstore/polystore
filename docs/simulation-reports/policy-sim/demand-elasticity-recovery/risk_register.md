# Risk Register: Storage Demand Elasticity Recovery

Model latent storage demand that initially pauses because storage price is above a reference willingness-to-pay level, then recovers as the utilization-based controller steps price down.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Storage demand suppressed by price elasticity | `medium` | 72 latent new deal requests were suppressed before requesting; latent-demand acceptance rate was 64.00%. | Demand may silently leave the market before a hard quote rejection appears in protocol telemetry. | Review reference price, elasticity assumptions, price-step timing, quote telemetry, and whether demand should recover as utilization falls. |

## Evidence Counters

- Evidence events: `0`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `1.25%`
- Top operator assignment share: `1.28%`
- Operator cap violations: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`
- Audit budget demand: `0.0000`
- Audit budget spent: `0.0000`
- Audit budget backlog: `0.0000`
- Audit budget exhausted epochs: `0`
- Evidence spam claims: `0`
- Evidence spam bond burned: `0.0000`
- Evidence spam bounty paid: `0.0000`
- Evidence spam net gain: `0.0000`
- Provider cost shock active epochs: `0`
- Max cost-shocked providers: `0`
- Retrieval demand shock active epochs: `0`
- Retrieval price direction changes: `0`
- Latent new deal requests: `200`
- Effective new deal requests: `128`
- New deals accepted: `128`
- New deals suppressed by price elasticity: `72`
- New deals rejected by price: `0`
- New deals rejected by capacity: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
