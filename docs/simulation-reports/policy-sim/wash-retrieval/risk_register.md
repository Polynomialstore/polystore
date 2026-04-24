# Risk Register: Wash Retrieval Demand

Model artificial retrieval demand. The policy question is whether fake activity can farm rewards for free, or whether requester/session fees and burns make the attack costly.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| No material risk surfaced | `low` | Assertions passed, no negative provider P&L, no elasticity cap hit, and no availability loss. | This run is suitable as a control or candidate for deeper implementation planning. | Compare against adjacent scenarios and confirm assertion thresholds. |

## Evidence Counters

- Evidence events: `0`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Repair backoffs: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
