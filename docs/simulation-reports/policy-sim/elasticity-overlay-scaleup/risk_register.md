# Risk Register: Elasticity Overlay Scale-Up

Model the positive path for user-funded overflow capacity. Sustained hot retrieval pressure buys temporary overlay routes, the routes become ready after a delay, serve reads, and expire instead of becoming permanent unpaid responsibility.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| User-facing availability loss | `medium` | 109 unavailable reads; success rate 94.32%. | Temporary read misses are acceptable only when explicitly allowed by the scenario contract and data loss remains zero. | If this is a scale fixture, track it as an availability tuning item. Otherwise block graduation and investigate routing, redundancy, repair timing, and provider selection. |
| Elasticity overlay routing pressure | `low` | 48 overlays activated, 393 overlay serves completed, 18 overlays expired, and 0 overlay expansions were rejected. | Temporary overflow capacity can preserve reads under hot demand, but it needs explicit readiness, TTL, spend accounting, and routing visibility. | Review overlay readiness proofs, TTL defaults, spend-window UX, gateway route ordering, and whether overlay providers affect audit or reward eligibility. |
| Provider bandwidth saturation | `medium` | 2463 provider responses saturated before serving. | Retrieval demand may exceed heterogeneous provider bandwidth before the storage layer notices a hard fault. | Review bandwidth admission, route_attempt_limit, retrieval pricing, and elasticity policy. |

## Evidence Counters

- Evidence events: `48`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Elasticity overlay activations/serves/expired: `48` / `393` / `18`
- Elasticity overlay rejections/final active/peak ready: `0` / `30` / `24`
- Sponsored retrieval attempts/spend: `0` / `0.0000`
- Owner retrieval escrow debited: `0.0000`
- Storage escrow locked/earned/refunded/outstanding: `0.0000` / `0.0000` / `0.0000` / `0.0000`
- Storage fee provider payout/burned: `0.0000` / `0.0000`
- Final open/closed deals: `3` / `0`
- Data-loss events: `0`
- Saturated responses: `2463`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `2.77%`
- Top operator assignment share: `2.77%`
- Operator cap violations: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`
- Repair readiness timeouts: `0`
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
- Provider churn events: `0`
- Churned providers: `0`
- Provider entries/promotions: `0` / `0`
- Reserve/probationary/entered-active providers: `0` / `0` / `0`
- Underbonded repairs: `0`
- Final/peak underbonded providers: `0` / `0`
- Final/peak underbonded assigned slots: `0` / `0`
- Final active/exited/reserve provider capacity: `576` / `0` / `0`
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
