# Risk Register: High-Bandwidth Capability Regression

Model hot retrieval demand after providers have become high-bandwidth eligible. The policy question is whether the system can revoke hot-path eligibility when promoted providers begin saturating under concentrated traffic.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider bandwidth saturation | `medium` | 21 provider responses saturated before serving. | Retrieval demand may exceed heterogeneous provider bandwidth before the storage layer notices a hard fault. | Review bandwidth admission, route_attempt_limit, retrieval pricing, and elasticity policy. |

## Evidence Counters

- Evidence events: `0`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `21`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `1.38%`
- Top operator assignment share: `1.38%`
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

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
