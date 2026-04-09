# Mainnet Parity + Devnet/Testnet Launch Checklist

Companion docs:
- `notes/mainnet_policy_resolution_jan2026.md` (concrete proposal for “B” + staged plan)
- `MAINNET_GAP_TRACKER.md` (canonical gap tracking + DoDs + test gates)

## Stage 0 — Policy freeze → params + interfaces (unblocks engineering)
- [ ] Extend `polystorechain/proto/polystorechain/polystorechain/v1/params.proto` to encode B1/B2/B4/B5/B6 (with validation + genesis defaults).
- [ ] Encode audit budget sizing/caps (Option A): `audit_budget_bps`, `audit_budget_cap_bps`, and bounded carryover (≤2 epochs) for unused budget.
- [ ] Document chosen defaults + rationale in `notes/mainnet_policy_resolution_jan2026.md` and reference from `MAINNET_GAP_TRACKER.md`.

## Stage 0.5 — Wallet-first chain writes (MetaMask / EVM bridge)
- [ ] Ensure all user actions land via EVM bridge/precompile (no gateway relayer in production mode).
- [ ] Disable auto-faucet behavior by default; keep faucet as dev-only toggle (`POLYSTORE_AUTO_FAUCET_EVM=0` by default).
- [ ] UI: implement MetaMask flows for create/top-up/commit/extend/open/confirm/cancel (no server-side signing).

## Stage 1 — Storage lock-in pricing + escrow accounting (A1)
- [ ] Implement pay-at-ingest lock-in pricing on `UpdateDealContent*` per `rfcs/rfc-pricing-and-escrow-accounting.md` (`polystorechain/`).
- [ ] Implement deterministic spend window reset + deterministic elasticity debits (`polystorechain/`).
- [ ] Add econ e2e: create deal → upload/commit → verify escrow and module account flows (`scripts/`, `tests/`).


## Stage 1.5 — Deal expiry + renewal (ExtendDeal) (CHAIN-104)
- [ ] Add `deal_extension_grace_blocks` param + defaults (`polystorechain/proto/.../params.proto`).
- [ ] Implement `MsgExtendDeal` with spot `storage_price` at extension time; extend `end_block` deterministically (`polystorechain/`).
- [ ] Enforce expiry: reject `UpdateDealContent*`, `OpenRetrievalSession`, `ProveLiveness` after `end_block` (`polystorechain/`).
- [ ] Enforce `expires_at <= end_block` on retrieval sessions (`polystorechain/`).
- [ ] Exclude expired deals from quotas/challenge derivation and rewards (`polystorechain/`).
- [ ] Provider + gateway: stop serving expired deals; GC after `end_block + grace` (`nil_provider/`, `polystore_gateway/`).
- [ ] Add e2e: expire → renew → read; expire → GC delete (`scripts/`, `tests/`).
## Stage 2 — Retrieval session economics (A2)
- [ ] Enforce session open burns base fee + locks variable fee; rejects insufficient escrow (`polystorechain/`).
- [ ] Enforce **mandatory sessions for all served bytes**: provider + gateway reject out-of-session reads (`X-PolyStore-Session-Id` required); blob alignment + session range subset enforced; segmented/batched downloads within one session supported (`nil-provider/`, `polystore_gateway/`, `polystore-website/`).
- [ ] Enforce completion settlement: burn cut + provider payout; cancel/expiry refunds locked fee only (`polystorechain/`).
- [ ] Extend econ e2e: open → complete; open → cancel/expire; verify burns/payouts/refunds (`scripts/`, `tests/`).

## Stage 2b — Retrieval access control & public deals (A2b)
- [ ] Add `Deal.retrieval_policy` (enum + `allowlist_root` + `voucher_signer`), defaulting to `OwnerOnly` for existing deals (`polystorechain/`).
- [ ] Enforce `MsgOpenRetrievalSession` is **owner-only** (`polystorechain/`).
- [ ] Implement `MsgOpenRetrievalSessionSponsored` (requester-funded; does not touch `Deal.escrow_balance`; refunds to requester on non-completion) so public/third-party retrieval cannot drain long-term deal escrow (`polystorechain/`).
- [ ] Implement `MsgOpenProtocolRetrievalSession` (protocol-funded sessions) for audit/repair/healing so restricted deals still allow liveness + repairs (`polystorechain/`).
- [ ] Add retrieval session fields `purpose` + `funding` + `payer` and enforce refund routing:
      - `DEAL_ESCROW` → refund to deal escrow
      - `REQUESTER`  → refund to payer
      - `PROTOCOL`   → refund to protocol audit budget module account
- [ ] Allowlist mode: merkle root + proof verification (`polystorechain/`, `polystore-website/`).
- [ ] Voucher mode: EIP-712 (recommended) signature verification + one-time nonce tracking (`polystorechain/`, `polystore-website/`).
- [ ] Add query/index support for public deals (at minimum expose retrieval_policy in Deal query; ideally add `QueryPublicDeals`) (`polystorechain/`).
- [ ] UI/UX: deal creation includes retrieval policy selection; allowlist manager; voucher generator; retrieval flow uses sponsored open when requester != owner (`polystore-website/`).
- [ ] E2E gates: owner-only deal rejects non-owner; public deal allows non-owner sponsored open; voucher replay fails; allowlist proof required (`tests/`, `scripts/`).

## Stage 2c — Content encoding / compression (A2c)
- [ ] Implement PolyCEv1 header (`POLC`) + `ContentEncoding` enum and zstd (level 3) compress-before-encrypt pipeline in both gateway and WASM (`polystore_gateway/`, `polystore_core/`).
- [ ] Retrieval path parses header and decompresses after decrypt; partial reads fetch header blobs first (`polystore_gateway/`, `polystore_core/`).
- [ ] UI shows original vs stored size and cost delta; compression default ON with opt-out (`polystore-website/`).
- [ ] Tests: round-trip equality; corrupt header fails safely; zip-bomb defense; gateway vs WASM parity (`tests/`).

## Stage 3 — Deterministic challenge derivation + quotas + synthetic fill (A3)
- [ ] Implement deterministic challenge derivation + quota accounting (SPECIFIED in `rfcs/rfc-challenge-derivation-and-quotas.md`) (`polystorechain/`).
- [ ] Implement enforcement outcomes: invalid proof → hard fault; quota shortfall → HealthState decay (no slash by default) (`polystorechain/`).
- [ ] Add keeper unit tests for determinism + exclusions (REPAIRING slots excluded).
- [ ] Add adversarial sim test gate for anti-grind properties (`scripts/`, `performance/`).

## Stage 4 — HealthState + eviction curve (A6)
- [ ] Implement per-(deal, provider/slot) HealthState updates from hard/soft failures (`polystorechain/`).
- [ ] Implement eviction triggers (`evict_after_missed_epochs_hot/cold`) and hook into Mode 2 repair start (`polystorechain/`).
- [ ] Add queries/events for observability; add unit tests.

## Stage 5 — Mode 2 repair + make-before-break replacement (A5)
- [ ] Implement make-before-break replacement per `rfcs/rfc-mode2-onchain-state.md` (`polystorechain/`).
- [ ] Implement deterministic candidate selection + churn controls (B4) (`polystorechain/`).
- [ ] Ensure reads avoid `REPAIRING` slots; synthetic challenges ignore `REPAIRING`; repairing slots do not earn rewards (`polystorechain/`, `polystore_gateway/`).
- [ ] Ensure repair catch-up transfers are **session-accounted** via protocol repair sessions (`MsgOpenProtocolRetrievalSession`, `purpose=PROTOCOL_REPAIR`) (`polystorechain/`, `polystore_gateway/`, `nil-provider/`).
- [ ] Add multi-SP repair e2e: slot failure → candidate catch-up → promotion; reads succeed throughout (`scripts/`, `tests/`).

## Stage 6 — Evidence / fraud proofs pipeline (A4)
- [ ] Implement evidence taxonomy + verification + replay protection (`polystorechain/`).
- [ ] Wire penalties (slash/jail/evict) to B1 params; integrate with repair start (`polystorechain/`).
- [ ] Add unit tests per evidence type + e2e demonstrating slash on proven bad data (`scripts/`, `tests/`).

## Stage 7 — Deputy market + proxy retrieval + audit debt (P0-P2P-001)
- [ ] Implement deputy/proxy retrieval end-to-end: selection, routing, and settlement (B5) (`polystore_p2p/`, `polystorechain/`, `polystore_gateway/`).
- [ ] Implement proof-of-failure aggregation with threshold/window (B1) and anti-griefing (B5) (`polystorechain/`).
- [ ] Add ghosting-provider e2e: still retrieve via deputy and record evidence (`scripts/`).

## B) Policy decisions to encode (proposal summary)

See `notes/mainnet_policy_resolution_jan2026.md` for full details.

- [ ] **B1 Slashing/jailing ladder:** hard faults slash immediately; non-response uses threshold/window; quota shortfall decays HealthState.
- [ ] **B2 Bonding:** base provider bond + assignment collateral scaled by slot bytes and `storage_price`.
- [ ] **B3 Pricing defaults:** derive `storage_price` from GiB-month target; define retrieval base + per-blob + burn bps; define halving interval policy.
- [ ] **B4 Replacement selection:** deterministic candidate ranking seeded by epoch randomness; cooldown + attempt caps.
- [ ] **B5 Deputy incentives:** proxy premium payout + evidence bond/bounty + audit debt funding choice (Option A vs B).
- [ ] **B6 Credits phase-in:** implement accounting first; enable quota reduction caps later (devnet→testnet→mainnet).

## Test gates (launch blockers)
- [ ] Chain econ e2e with multiple parameter sets (`scripts/`, `tests/`).
- [ ] Challenge determinism + anti-grind sim (`scripts/`, `performance/`).
- [ ] Ghosting-provider deputy e2e (`scripts/`).
- [ ] Health/repair e2e (replacement without read outage) (`scripts/`).
