# Risk Register: Lazy Provider

Model a provider that does not satisfy liveness quota even when user-facing reads may still succeed. This tests whether the network detects free-riding on redundancy instead of only detecting outright retrieval failures.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider economic churn pressure | `medium` | 1 of 48 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |

## Evidence Counters

- Evidence events: `12`
- Repair events: `18`
- Failed assertions: `0`
- Providers with negative P&L: `1`
- Elasticity rejections: `0`
- Elasticity overlay activations/serves/expired: `0` / `0` / `0`
- Elasticity overlay rejections/final active/peak ready: `0` / `0` / `0`
- Sponsored retrieval attempts/spend: `0` / `0.0000`
- Owner retrieval escrow debited: `0.0000`
- Storage escrow locked/earned/refunded/outstanding: `0.0000` / `0.0000` / `0.0000` / `0.0000`
- Storage fee provider payout/burned: `0.0000` / `0.0000`
- Final open/closed deals: `24` / `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `2.08%`
- Top operator assignment share: `2.43%`
- Operator cap violations: `0`
- Suspect slot-epochs: `6`
- Delinquent slot-epochs: `12`
- Repair attempts: `6`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`
- Repair readiness timeouts: `0`
- Audit budget demand: `0.0600`
- Audit budget spent: `0.0600`
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
- Final active/exited/reserve provider capacity: `768` / `0` / `0`
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
