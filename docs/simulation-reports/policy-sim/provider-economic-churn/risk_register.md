# Risk Register: Provider Economic Churn

Model rational provider exit after sustained negative P&L. The policy question is whether bounded churn converts economic distress into visible capacity exit and repair pressure without causing durability loss.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider economic churn pressure | `medium` | 8 of 80 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |
| Provider cost shock exposure | `medium` | Cost shocks were active for 10 shock-epochs and affected up to 8 providers. | A technically healthy network may have delayed economic instability if prices and rewards do not react to operator cost pressure. | Review provider cost telemetry assumptions, pricing floors, reward buffers, and whether cost shocks should remain monitoring-only or feed governance recommendations. |
| Provider capacity exit | `medium` | 8 provider exits removed 102 capacity slots; peak assigned slots on churned providers was 24. | Economic exits can turn a pricing problem into repair pressure and capacity scarcity. | Review churn caps, minimum replacement capacity, price-floor response, and whether draining exits need longer notice periods. |

## Evidence Counters

- Evidence events: `97`
- Repair events: `144`
- Failed assertions: `0`
- Providers with negative P&L: `8`
- Elasticity rejections: `0`
- Elasticity overlay activations/serves/expired: `0` / `0` / `0`
- Elasticity overlay rejections/final active/peak ready: `0` / `0` / `0`
- Sponsored retrieval attempts/spend: `0` / `0.0000`
- Owner retrieval escrow debited: `0.0000`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `1.25%`
- Top operator assignment share: `1.85%`
- Operator cap violations: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `48`
- Repair attempts: `48`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`
- Repair readiness timeouts: `0`
- Audit budget demand: `0.4450`
- Audit budget spent: `0.4450`
- Audit budget backlog: `0.0000`
- Audit budget exhausted epochs: `0`
- Evidence spam claims: `0`
- Evidence spam bond burned: `0.0000`
- Evidence spam bounty paid: `0.0000`
- Evidence spam net gain: `0.0000`
- Provider cost shock active epochs: `10`
- Max cost-shocked providers: `8`
- Provider churn events: `8`
- Churned providers: `8`
- Provider entries/promotions: `0` / `0`
- Reserve/probationary/entered-active providers: `0` / `0` / `0`
- Underbonded repairs: `0`
- Final/peak underbonded providers: `0` / `0`
- Final/peak underbonded assigned slots: `0` / `0`
- Final active/exited/reserve provider capacity: `854` / `102` / `0`
- Retrieval demand shock active epochs: `0`
- Retrieval price direction changes: `0`
- Latent new deal requests: `0`
- Effective new deal requests: `0`
- New deals accepted: `0`
- New deals suppressed by price elasticity: `0`
- New deals rejected by price: `0`
- New deals rejected by capacity: `0`
- Staged upload attempts/accepted/committed: `0` / `0` / `0`
- Staged upload rejections/cleaned: `0` / `0`
- Final/peak staged pending generations: `0` / `0`
- Final/peak staged pending MDUs: `0` / `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
