# Mainnet Parity + Devnet/Testnet Launch Checklist

## A) Well-defined high-level steps (implementation)
- [ ] Implement storage lock-in pricing on `UpdateDealContent*` with deterministic debits and spend window enforcement (`nilchain/`).
- [ ] Implement retrieval session fee lifecycle (open burns base fee, locks variable fee, confirm settles, cancel refunds) (`nilchain/`, `nil_gateway/`).
- [ ] Implement deterministic challenge derivation + quota accounting + synthetic fill scheduling (`nilchain/`).
- [ ] Implement evidence/fraud proof taxonomy, verification, replay protection, and penalty wiring (slash/evict/jail) (`nilchain/`).
- [ ] Implement Mode 2 repair + make-before-break replacement: slot status transitions, repair target gen, promotion; reads avoid repairing slots (`nilchain/`, `nil_gateway/`).
- [ ] Implement HealthState tracking per (deal, provider/slot) with eviction curve and hooks into repair workflow (`nilchain/`).
- [ ] Add end-to-end econ test suite: create deal → upload → retrieve → verify balances/fees/burns (`scripts/`, `tests/`).
- [ ] Add multi-SP repair e2e: slot failure → candidate catch-up → promotion; reads succeed throughout (`scripts/`, `tests/`).

## B) Underspecified items (resolve + implement)
- [ ] Define slashing policy + parameters (thresholds, amounts, jailing rules) and encode in params (`nilchain/`, RFC update).
- [ ] Define provider staking/bond requirements (minimums, lock periods, slash linkage) and implement staking checks (`nilchain/`).
- [ ] Define pricing parameters + equilibrium targets (storage price, base retrieval fee, variable fee, burn bps, halving interval) and add governance update path (`nilchain/`).
- [ ] Define repair/replacement selection policy (candidate choice rules, churn/griefing controls) and implement selection logic (`nilchain/`, `nil_p2p/`).
- [ ] Define deputy market compensation rules (proxy retrieval payment, evidence incentives, audit debt funding) and implement accounting (`nil_p2p/`, `nilchain/`).
- [ ] Define challenge economics for organic retrieval credits (accrual, caps, phase-in) and implement credit accounting (`nilchain/`).
- [ ] Update docs/RFCs to reflect final policies and parameter defaults (`rfcs/`, `spec.md`).

## Test gates
- [ ] Chain-level econ e2e with multiple parameter sets (`scripts/`, `tests/`).
- [ ] Adversarial sim for challenge determinism + anti-grind properties (`scripts/`, `performance/`).
- [ ] Ghosting-provider e2e for deputy retrieval market (`scripts/`).
- [ ] Health/repair e2e (replacement without read outage) (`scripts/`).
