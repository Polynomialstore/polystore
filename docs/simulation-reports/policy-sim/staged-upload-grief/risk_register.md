# Risk Register: Staged Upload Grief

Model a client or user-gateway repeatedly uploading provisional generations and never committing them. This is an operational/accounting grief case: local provider-daemon storage pressure must be bounded by retention cleanup and preflight caps, not by repair or punitive provider enforcement.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Staged upload retention pressure | `medium` | 96 provisional uploads were rejected at preflight and 108 abandoned generations were cleaned; peak pending was 36 generations / 72 MDUs. | Abandoned provisional generations can consume provider-daemon disk or operator attention if cleanup and preflight caps are missing. | Review staged-generation TTL, max pending cap, dry-run cleanup UX, and whether preflight rejection should be gateway-visible before upload. |

## Evidence Counters

- Evidence events: `10`
- Repair events: `0`
- Failed assertions: `0`
- Providers with negative P&L: `0`
- Elasticity rejections: `0`
- Elasticity overlay activations/serves/expired: `0` / `0` / `0`
- Elasticity overlay rejections/final active/peak ready: `0` / `0` / `0`
- Sponsored retrieval attempts/spend: `0` / `0.0000`
- Owner retrieval escrow debited: `0.0000`
- Data-loss events: `0`
- Saturated responses: `0`
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Top operator provider share: `2.08%`
- Top operator assignment share: `2.08%`
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
- Final active/exited/reserve provider capacity: `768` / `0` / `0`
- Retrieval demand shock active epochs: `0`
- Retrieval price direction changes: `0`
- Latent new deal requests: `0`
- Effective new deal requests: `0`
- New deals accepted: `0`
- New deals suppressed by price elasticity: `0`
- New deals rejected by price: `0`
- New deals rejected by capacity: `0`
- Staged upload attempts/accepted/committed: `240` / `144` / `0`
- Staged upload rejections/cleaned: `96` / `108`
- Final/peak staged pending generations: `36` / `36`
- Final/peak staged pending MDUs: `72` / `72`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?
