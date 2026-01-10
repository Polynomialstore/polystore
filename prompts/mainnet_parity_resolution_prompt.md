# Prompt: Mainnet Parity + Devnet/Testnet Launch Resolution

You are tasked with proposing concrete resolutions for all **underspecified items** and turning the **well-defined items** into an executable plan. Use the brief in `assets_for_prompt.md` as the source of truth.

## A) Well-defined high-level steps (must produce an implementation plan)
- Storage lock-in + escrow accounting (pay-at-ingest, deterministic debits, spend windows)
- Retrieval session economics (base fee burn, variable fee lock, settlement, refunds)
- Deterministic challenge derivation + quotas (synthetic fill, penalties)
- Evidence / fraud proofs pipeline (verify, replay-protect, slash/evict/jail)
- Mode 2 repair + make-before-break replacement (slot status, catch-up, promotion)
- HealthState + eviction curve (per-(deal, provider/slot) health tracking)

## B) Underspecified items (you must propose and clarify)
- Exact slashing policy + parameters (thresholds, amounts, jailing)
- Staking/bond requirements (minimums, lock periods, slashing linkage)
- Pricing parameterization + equilibrium targets (storage price, retrieval fees, burn bps, halving)
- Repair/replacement selection policy (candidate choice, churn/griefing controls)
- Deputy market compensation (proxy retrieval payment, evidence incentives, audit debt funding)
- Challenge economics (organic retrieval credits: accrual rules, caps, phase-in)

## Required outputs
1. A **proposal** that resolves every item in B with clear parameters or decision options (include pros/cons where relevant).
2. A **delivery plan** that turns A into a staged implementation roadmap with test gates, repo areas, and dependencies.
3. A short **risk list** (top 5) if any item in B is deferred.

Keep it crisp and actionable for engineering.
