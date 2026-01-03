# RFC: Pricing & Escrow Accounting (Lock-in + Retrieval Fees + Elasticity Caps)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain economics (`nilchain/`) + gateway/UI intent fields
**Motivation:** `spec.md` §6.1–§6.2, §7.2.1; Appendix B #5
**Depends on:** `rfcs/rfc-data-granularity-and-economics.md`

---

## 0. Executive Summary

This RFC freezes the **economic accounting contracts** required for mainnet hardening:
- **Storage lock-in pricing** at ingest (`UpdateDealContent*`) using `storage_price` (Dec per byte per block)
- **Retrieval fees** via session-based settlement (base fee burn + per-blob variable fee lock, then burn cut + provider payout)
- **User-funded elasticity caps** enforced via `Deal.max_monthly_spend` and a deterministic spend window

This RFC intentionally does **not** introduce retrieval “credits” for Gamma‑4. Credits may be introduced later once quota enforcement exists (see `rfcs/rfc-challenge-derivation-and-quotas.md`).

---

## 1. Canonical Denoms & Accounts (Frozen)

### 1.1 Denom
- All fees/deposits are in `sdk.DefaultBondDenom` (devnet: `stake`).

### 1.2 Module accounts
- `authtypes.FeeCollectorName`: receives `deal_creation_fee`.
- `types.ModuleName` (`nilchain` module account): holds escrow and performs burns/transfers for retrieval settlement.

---

## 2. Parameters (Frozen)

From `nilchain/nilchain/v1/params.proto`:
- `deal_creation_fee: Coin`
- `min_duration_blocks: uint64`
- `storage_price: Dec` (per byte per block)
- `base_retrieval_fee: Coin` (burned at session open)
- `retrieval_price_per_blob: Coin` (locked at session open)
- `retrieval_burn_bps: uint64` (basis points of variable fee burned on completion)
- `base_stripe_cost: uint64` (unit cost used for elasticity budgeting; denom = bond denom)

From Deal state:
- `max_monthly_spend: Int` (cap for user-funded elasticity)
- `escrow_balance: Int` (remaining funds available to pay protocol-defined charges)

---

## 3. Deal Lifecycle Charges (Frozen)

### 3.1 CreateDeal (`MsgCreateDeal*`)
**Inputs:** `duration_blocks`, `initial_escrow_amount`, `max_monthly_spend`, `service_hint`

**Validation:**
- `duration_blocks >= min_duration_blocks`
- `initial_escrow_amount >= 0`
- `max_monthly_spend >= 0`

**Accounting:**
1. If `deal_creation_fee > 0`, transfer `deal_creation_fee` from creator → fee collector.
2. If `initial_escrow_amount > 0`, transfer `initial_escrow_amount` from creator → module account.
3. Initialize deal with:
   - `manifest_root = empty`
   - `size_bytes = 0`
   - `total_mdus = 0` (until first commit; see `rfcs/rfc-mode2-onchain-state.md`)
   - `escrow_balance = initial_escrow_amount`

### 3.2 AddCredit (`MsgAddCredit`)
Transfers `amount` from sender → module account and increments `Deal.escrow_balance += amount`.

---

## 4. Storage Lock-in Pricing (Frozen)

### 4.1 UpdateDealContent (`MsgUpdateDealContent*`)
When content is committed and `size_bytes` increases, the protocol charges a **term deposit** at the current `storage_price`.

Let:
- `old_size = Deal.size_bytes`
- `new_size = msg.size_bytes`
- `delta = max(0, new_size - old_size)`
- `duration = Deal.end_block - Deal.start_block` (fixed at deal creation for v1)

**Cost function:**
```
storage_cost = ceil(storage_price * delta * duration)
```

**Accounting:**
- If `storage_cost > 0`, transfer `storage_cost` from owner → module account.
- Update `Deal.escrow_balance += storage_cost`.

**Normative properties:**
- Only incremental bytes are charged at the new spot price.
- Previously committed bytes are not repriced.

### 4.2 Future extension (out of scope)
Extending lifetime past `end_block` requires a `MsgExtendDeal` (or equivalent) and a lock-in charge using the spot `storage_price` at extension time.

---

## 5. Retrieval Fees (Gamma‑4, Frozen)

This section is normative and matches `spec.md` §7.2.1.

### 5.1 Session open (`MsgOpenRetrievalSession`)
Let:
- `blob_count` be the requested contiguous blob-range length (128 KiB units)
- `base_fee = Params.base_retrieval_fee`
- `variable_fee = Params.retrieval_price_per_blob * blob_count`
- `total = base_fee + variable_fee`

**Must-fail conditions:**
- `Deal.escrow_balance < total` → reject
- `manifest_root` must match `Deal.manifest_root` (pin)

**Accounting at open:**
1. Burn `base_fee` from module account (non-refundable).
2. Lock `variable_fee` against the session and decrement deal escrow:
   - `Deal.escrow_balance -= (base_fee + variable_fee)`
   - `session.locked_fee = variable_fee` (store on session object)

### 5.2 Completion (`MsgConfirmRetrievalSession` + proof present)
On transition to `COMPLETED`, settle the locked variable fee:

```
burn_cut = ceil(variable_fee * retrieval_burn_bps / 10_000)
payout   = variable_fee - burn_cut
```

**Accounting:**
- Burn `burn_cut` from module account.
- Transfer `payout` from module account → provider account.

### 5.3 Expiry/cancel (refund path)
If a session expires without completion, the owner may cancel:
- `MsgCancelRetrievalSession` unlocks the remaining `session.locked_fee` and refunds it to `Deal.escrow_balance`.
- Base fee is never refunded.

---

## 6. Elasticity Spend Caps (Freeze)

Elasticity is user-funded and must be bounded by `Deal.max_monthly_spend` (a cap) and `Deal.escrow_balance` (available funds).

### 6.1 Spend window
Define:
- `MONTH_LEN_BLOCKS` (param; e.g. 30 days worth of blocks)

Add per-deal accounting fields:
- `spend_window_start_height: uint64`
- `spend_window_spent: Int`

Window logic (deterministic):
- If `height >= spend_window_start_height + MONTH_LEN_BLOCKS`, reset:
  - `spend_window_start_height = height`
  - `spend_window_spent = 0`

### 6.2 Scaling event cost
For any elasticity action that increases replication/overlays by `delta_replication`:

```
elasticity_cost = base_stripe_cost * delta_replication
```

**Must-fail:**
- `spend_window_spent + elasticity_cost > max_monthly_spend`
- `Deal.escrow_balance < elasticity_cost`

**Accounting:**
- `Deal.escrow_balance -= elasticity_cost`
- `spend_window_spent += elasticity_cost`

**Implementation note:** current devnet `MsgSignalSaturation` enforces the cap but does not debit; mainnet requires the debit.

---

## 7. Required Interface/State Changes (for implementation sprints)

1. `Deal` fields (if not already present):
   - `spend_window_start_height`
   - `spend_window_spent`
2. Ensure `UpdateDealContent*` continues to carry `size_bytes` (and, per Sprint‑0 naming freeze, also carries `total_mdus` + `witness_mdus`; see `rfcs/rfc-mode2-onchain-state.md`).
3. Ensure retrieval session settlement burns/transfers use module account funds and update `Deal.escrow_balance` deterministically.

---

## 8. Test Gates (for later sprints)

- Storage lock-in: update content with increasing size charges `delta*duration*price` and rejects if insufficient funds.
- Retrieval fees: open burns base fee, locks variable, completion burns cut + pays provider, cancel refunds variable.
- Elasticity: scaling denied when exceeding `max_monthly_spend` or `escrow_balance`.

