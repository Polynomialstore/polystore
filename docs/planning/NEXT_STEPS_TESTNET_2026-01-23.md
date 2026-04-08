# PolyStore testnet launch next steps (engineering + policy) — updated for deal expiry + renewal + wallet-first

Last updated: 2026-01-23

This is a practical checklist that turns the current drafts into code + test gates.

## A. Policy decisions to finalize (minimum set)

1) **Deal expiry + renewal semantics**
   - Adopt `rfcs/rfc-deal-expiry-and-extension.md` (draft):
     - define `deal_extension_grace_blocks` (recommend: `MONTH_LEN_BLOCKS`)
     - confirm “end_block is exclusive” semantics
     - confirm providers should GC after `end_block + grace`

2) **Base reward pool (protocol issuance)**
   - Adopt `rfcs/rfc-base-reward-pool-and-emissions.md` (draft) with an initial parameter set:
     - start bps / tail bps / halving interval / start height
   - Decide remainder handling: burn vs community pool.

3) **Provider exit / draining**
   - Adopt `rfcs/rfc-provider-exit-and-draining.md` (draft) at least for “no new assignments while draining”.
   - Set churn caps:
     - max drain bytes per epoch
     - max repairing bytes ratio

4) **Quota enforcement posture**
   - Confirm devnet/testnet values for:
     - quota_bps_hot/cold
     - quota_min_blobs / quota_max_blobs
     - credit_cap_bps
   - Confirm eviction thresholds (hot/cold) and non-response conviction ladder.

5) **Wallet-first posture**
   - Confirm the rule: “in production mode, gateway does not relay tx.”
   - Confirm UI uses MetaMask/EVM bridge for all user actions.
   - Keep faucet as dev/test tooling only (off by default in UI).

6) **Mandatory retrieval sessions (data-plane enforcement)**
   - Confirm: all served bytes require an on-chain retrieval session (`X-Nil-Session-Id` mandatory).
   - Confirm batching posture: segmented/range downloads within one session are supported; keep door open to future batching optimizations.

7) **Escrow end-of-life semantics**
   - The frozen RFC defines how escrow is charged at ingest and settled for retrieval.
   - A mainnet decision is still needed for **what happens to remaining escrow at deal expiry** (refund vs burn vs other).
     This materially affects long-term token sinks and emission farming risk.

8) **Retrieval access control (restricted / allowlist / voucher / public)**
   - Adopt `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers_PROTOCOL_HOOKS.md` (draft).
   - Confirm defaults:
     - `OwnerOnly` is default for all new deals unless explicitly set.
     - `Public` deals use **requester-paid** sponsored session opens (public retrieval must not drain long-term storage escrow).
   - Confirm voucher posture:
     - one-time nonces required
     - voucher expiry/TTL bounded (to cap state growth)
     - (recommended) vouchers are bound to a redeemer address for paid downloads.

9) **Compression / content-encoding**
   - Adopt `rfcs/rfc-content-encoding-and-compression.md` (draft).
   - Confirm codec set for v1 (recommend: NONE + ZSTD).
   - Confirm header stability and zip-bomb safety limits.

## B. Code implementation items (nilchain module)

### B1) Deal expiry + renewal (CHAIN-104)

- Add param:
  - `deal_extension_grace_blocks`
- Add message:
  - `MsgExtendDeal(deal_id, additional_duration_blocks)`
- Add Deal state:
  - `pricing_anchor_block` (pricing anchor updated on renewal)
- Enforce expiry gates:
  - reject `UpdateDealContent*` / `OpenRetrievalSession` / `ProveLiveness` once expired
  - enforce `RetrievalSession.expires_at <= Deal.end_block`
- Ensure quotas / challenge derivation exclude expired deals and expired slots do not earn rewards.

Test gates:
  - determinism + rounding parity
  - e2e: expire → renew → read
  - e2e: expire → provider GC delete

### B2) Emissions engine (base reward pool)

- Add params (proto + keeper):
  - `base_reward_bps_start`
  - `base_reward_bps_tail`
  - `base_reward_halving_interval_blocks`
  - `emission_start_height`
- Add state:
  - `TotalActiveSlotBytes` accumulator (updated whenever:
    - a deal is committed/expanded,
    - a slot changes ACTIVE ↔ REPAIRING,
    - a deal expires/cancels)
- Add epoch hook:
  - compute `epoch_slot_rent = storage_price * TotalActiveSlotBytes * epoch_len_blocks`
  - mint `base_reward_pool = ceil(bps/10_000 * epoch_slot_rent)`
  - compute per-slot compliance weights
  - distribute payouts, burn remainder

### B3) Draining & controlled exit

- Add provider field: `draining bool`
- Implement:
  - `MsgSetProviderDraining(draining=true)`
  - placement filter: draining providers are ineligible for new slots
- Implement deterministic drain scheduler (epoch hook):
  - mark selected slots REPAIRING (bounded by churn caps)
  - attach pending_provider candidate per existing repair policy

### B4) Wallet-first bridge surface (EVM)

- Ensure the EVM bridge/precompile supports:
  - create deal, add credit, update content, extend deal,
  - open/confirm/cancel retrieval sessions
- Ensure no server-side “relayer key” is required in production mode.

Test gates:
  - UI can complete lifecycle with only MetaMask and a funded account
  - gateway relay endpoints disabled by default

### B5) Retrieval access control + requester-paid sponsored sessions (CHAIN-107)

- Add Deal state:
  - `retrieval_policy` (mode + allowlist_root + voucher_signer)
- Enforce:
  - `MsgOpenRetrievalSession` is owner-only
- Add message:
  - `MsgOpenRetrievalSessionSponsored` (requester-funded; does not touch deal escrow; refunds to payer on non-completion)

- Add message:
  - `MsgOpenProtocolRetrievalSession` (protocol-funded sessions for audit/repair/healing; restricted deals still allow these)
- Implement allowlist proof verification (merkle root)
- Implement voucher verification:
  - signature verification
  - expiry enforcement
  - one-time nonce tracking (replay protection)
- Add query/index support for public deals (optional but recommended for explorers):
  - `QueryPublicDeals` with pagination

Test gates:
  - restricted/public/allowlist/voucher e2e
  - verify sponsored open does not change deal escrow balance
  - voucher replay fails

### B6) Compression / content-encoding (CORE-403 + GW-205)

- Implement NilCEv1 header and codecs (NONE + ZSTD) in:
  - `polystore_core` (WASM client)
  - `polystore_gateway` ingest path
- Ensure download returns original bytes (decompress after decrypt).
- Add UI quoting:
  - show estimated stored bytes and cost delta
- Add safety limits:
  - max uncompressed size
  - zip-bomb abort thresholds

Test gates:
  - compressible file reduces stored size
  - round-trip equality
  - corrupt header fails safely

### B7) Public data explorer (optional side project for testnet)

- Create a small reference implementation that:
  - lists public deals,
  - retrieves MDU #0 metadata via sponsored sessions,
  - hosts file lists and enables paid retrieval.

## C. Integration / end-to-end test plan

1) Bring up a local multi-node testnet.
2) Create deals (hot and cold), commit data, verify:
   - escrow lock-in charges at ingest
   - expiry enforcement works (no ops after end_block)
   - renewal works (extend + continue service)
3) Retrieval sessions:
   - open/complete → verify burns/payouts
   - open/expire/cancel → verify refunds
   - enforce `expires_at <= end_block`
   - enforce mandatory session gating: out-of-session reads fail; segmented/batched downloads within one session succeed
   - access control: non-owner cannot open sessions for owner-only deals; non-owner can open **sponsored** sessions for public deals
   - allowlist: proof required; voucher: one-time redeem + replay fails
4) Trigger non-response and ensure:
   - conviction threshold logic behaves
   - repair triggers and replacement completes
5) Mark a provider draining and ensure:
   - it stops getting new assignments
   - it is rotated out without punitive slashing (unless it stops serving early)
6) Run a stress test:
   - high churn + high retrieval load + quota compliance
7) Compression/content-encoding:
   - upload compressible file: stored bytes drop; download returns original bytes
   - upload incompressible file: encoding NONE; download identical

## D. Documentation updates in repo

- Promote the following drafts into the repository:
  - `docs/spec_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION.md` → `docs/spec.md` (after review)
  - `docs/ECONOMY_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION.md` → `docs/ECONOMY.md` (after review)
  - `docs/rfcs/rfc-deal-expiry-and-extension.md`
  - `docs/rfcs/rfc-base-reward-pool-and-emissions.md`
  - `docs/rfcs/rfc-provider-exit-and-draining_UPDATED.md` → `docs/rfcs/rfc-provider-exit-and-draining.md` (after review)
  - `docs/rfcs/rfc-mandatory-retrieval-sessions-and-batching_ACCESS_CONTROL.md`
  - `docs/rfcs/rfc-retrieval-access-control-public-deals-and-vouchers_PROTOCOL_HOOKS.md`
  - `docs/rfcs/rfc-content-encoding-and-compression.md`
