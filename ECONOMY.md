# NilStore Economy & Tokenomics (Deal Expiry + Wallet-First + Sessions-First)

Last updated: 2026-02-05

This document is a synthesis of:
- the prior token flow narrative (pre-2026-01-23),
- the frozen pricing & escrow accounting RFC (`rfcs/rfc-pricing-and-escrow-accounting.md`),
- the proposed base reward pool / emission schedule design (`rfcs/rfc-base-reward-pool-and-emissions.md`),
- and the new deal expiry/renewal semantics (`rfcs/rfc-deal-expiry-and-extension.md`).

It is intentionally **parameterized**: policy knobs are explicit and governance-adjustable.

---

## 1. Role clarity: what pays for what?

NilStore has two funding sources for storage providers (SPs):

1) **User-funded fees (escrow accounting, deterministic)**
   - Users deposit NIL into a deal’s escrow.
   - Storage lock-in charges and retrieval session fees debit/lock/burn from that escrow according to the frozen accounting contract.

2) **Protocol-funded issuance (base reward pool, deterministic)**
   - The protocol mints NIL on a schedule to subsidize reliable storage during bootstrap.
   - Issuance decays into a bounded tail, so fees can dominate in a mature network.

**Fee-dominant steady state (“equilibrium”):**
- The marginal SP can cover operating costs primarily from user fees.
- Issuance becomes comparatively small, acting as an additional security/liveness budget rather than the primary income stream.

---

## 2. What actually happens when users upload (charging semantics)

NilStore’s upload flow is two-phase:

### 2.1 Data-plane upload (no chain charge by itself)
- The client uploads bytes to providers (often via `polystore_gateway`).
- This is an off-chain operation; it *prepares* commitment material but does not finalize economics.

### 2.2 On-chain commit (where storage is charged)
- The client submits `MsgUpdateDealContent*` to commit the new `manifest_root` and the new deal size/MDU counts.
- On `MsgUpdateDealContent*`, the chain computes a **storage lock-in charge** based on:
  - `storage_price` (Dec per byte per block, on-chain),
  - `delta_size_bytes` (new_bytes - old_bytes),
  - `duration` (per the pricing RFC; see note below),
  - and then transfers that amount from the deal owner to the `polystorechain` module account, increasing `Deal.escrow_balance`.

This means:
- Users experience a deterministic “commit costs X NIL” event (similar to a “write transaction” in other chains).
- UI/gateway must **quote** this expected cost before asking the user to sign.

**Important nuance (current contract):**
- The frozen RFC defines `duration` as `Deal.end_block - Deal.start_block` for v1 (fixed at deal creation).
- The new renewal RFC introduces `pricing_anchor_block` to avoid overcharging on bytes added after renewal.

---

### 2.3 Retrieval (where bandwidth is charged and liveness is proven)

NilStore’s retrieval market is **session-based** and (for testnet/mainnet parity) sessions are **mandatory for all served bytes**:

1) **Open retrieval session (on-chain, user wallet tx)**  
   The user opens a session for a blob-aligned range and the chain:
   - burns a non-refundable `base_retrieval_fee` (anti-spam),
   - locks `variable_fee = retrieval_price_per_blob * blob_count` against the deal escrow.

2) **Serve bytes (off-chain, provider/gateway)**  
   Providers (and any gateway proxy path) MUST refuse to serve Deal bytes unless the request carries `X-Nil-Session-Id = session_id`.  
   Batching is allowed: one session can be downloaded via many range requests, or via larger MDU-sized chunks, as long as all served bytes remain within the session’s blob-range.

3) **Complete settlement (on-chain)**  
   When the provider submits the required proof material and the user confirms completion, the chain:
   - burns `variable_fee * retrieval_burn_bps`,
   - pays the remainder to the provider.

Implications:
- There is no “free” retrieval path in production mode; every served byte is fee-accounted and attributable for liveness/quotas.
- Batching/segmentation choices primarily affect UX and base-fee amortization, not accounting semantics.

### 2.3.1 Dynamic pricing (devnet experiment; optional)

NilStore’s devnet includes an **optional**, deterministic, **epoch-based** dynamic pricing controller.
When enabled, the chain may update:

- `storage_price` each epoch based on **storage utilization** (active slot bytes vs. active provider capacity)
- `retrieval_price_per_blob` each epoch based on **prior-epoch retrieval demand** (blobs requested in session opens)

The controller is bounded by on-chain parameters:
- Storage: `storage_price_min`, `storage_price_max`, `storage_target_utilization_bps`
- Retrieval: `retrieval_price_per_blob_min`, `retrieval_price_per_blob_max`, `retrieval_target_blobs_per_epoch`
- Step limit: `dynamic_pricing_max_step_bps` (max per-epoch change; `0` disables the step clamp)

Defaults are conservative: `dynamic_pricing_enabled=false` and targets set to `0` (no dynamic updates).



## 3. Deal expiry and renewal

### 3.1 Deal expiry (enforced)
- Deals have an `end_block` (exclusive).
- After `current_height >= end_block`:
  - content updates are rejected,
  - retrieval sessions cannot be opened,
  - liveness proofs cannot be submitted,
  - quota accounting and rewards exclude the deal.

### 3.2 Renewal / “ExtendDeal” (spot price at extension time)
NilStore adds `MsgExtendDeal(deal_id, additional_duration_blocks)`.

At extension time, the chain charges:
- `extension_cost = ceil(storage_price * current_size_bytes * additional_duration_blocks)`

Then it extends:
- `end_block = max(end_block, current_height) + additional_duration_blocks`

A renewal grace window (`deal_extension_grace_blocks`) allows renewal shortly after expiry and gives providers a clear retention horizon.

---

## 4. Wallet-first mainnet parity (MetaMask is the wallet)

### 4.1 Rule
All user-initiated chain writes MUST be paid and signed by the user’s wallet (MetaMask) and land via the EVM bridge / precompile.

The gateway is not a relayer in production mode.

### 4.2 What this changes operationally
- UI must stop “auto-faucet” behavior in non-dev mode.
- Any gateway endpoints that relay user tx must be dev-only and disabled by default.
- Users must be able to:
  - create deals,
  - add credit,
  - commit content,
  - extend deals,
  - open/confirm/cancel retrieval sessions
  directly from MetaMask.

---

## 5. Base rewards and distribution (summary)

(unchanged from prior draft; see RFC)

- Mint per epoch as a bps fraction of epoch slot rent:
  `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`
  `base_reward_pool = ceil(base_reward_bps(epoch)/10_000 * epoch_slot_rent)`

- Distribute by active slot bytes, gated by quota compliance, excluding REPAIRING and jailed providers.

---

## 6. Open questions (non-blocking defaults)

1) **Is storage lock-in escrow refundable at deal end?**
   - The frozen RFC specifies transfers into escrow but does not fully specify end-of-deal refund/close semantics.
   - Default for pre-alpha: escrow is withdrawable only via explicit close/cancel flows (to be specified), not automatic.

2) **When fees are high, should issuance dampen automatically?**
   - Deterministic dampeners can use on-chain fee totals (no oracle), but add coupling; stage this later.

3) **Rotation/draining policies**
   - Provider ephemerality is handled by drain/repair; ensure churn caps are enforced before enabling aggressive rotation.


## 2.4 Retrieval access control (restricted / allowlist / voucher / public)

NilStore distinguishes **who may open a retrieval session** from **who pays**.

### 2.4.1 Deal retrieval policy (who may request retrieval)

Each deal has a `retrieval_policy` (conceptual field in `Deal`):

- **OwnerOnly (default):** only the deal owner can open **user** retrieval sessions (`MsgOpenRetrievalSession`).
  - **Protocol audit/repair/healing sessions are still permitted** via `MsgOpenProtocolRetrievalSession` under deterministic authorization rules.
- **Allowlist:** owner + allowlisted accounts can open retrieval sessions.
- **Voucher:** owner + anyone presenting a valid one-time owner-signed voucher can open retrieval sessions (“buy to download once” building block).
- **AllowlistOrVoucher:** union of allowlist and voucher.
- **Public:** anyone can open retrieval sessions.

**Important:** this is not privacy. If confidentiality matters, the client MUST encrypt before upload.

### 2.4.2 Requester-paid sessions (avoid draining owner escrow)

Because the frozen accounting contract charges **owner-paid** session fees against `Deal.escrow_balance`, a naïve “public deal” would allow strangers to burn the owner’s long-term escrow.

To prevent this, NilStore adds an **additive** requester-funded open path:

- `MsgOpenRetrievalSession` remains **owner-only** and is “owner pays from deal escrow” (frozen semantics).
- `MsgOpenRetrievalSessionSponsored` is the public/third-party path and works as:

  1) Chain computes `total = base_fee + retrieval_price_per_blob * blob_count` (same fee schedule and rounding).
  2) Chain transfers `total` from the requester to the `polystorechain` module account.
  3) Chain creates a retrieval session with `funding=REQUESTER` and `payer=requester`.
  4) On completion: burn `retrieval_burn_bps` of `variable_fee` and pay the provider the remainder.
  5) On expiry/cancel (non-completion): refund any refundable `variable_fee` to the **payer** (requester), not to deal escrow. Base fee remains burned.

Net effect:
- the requester pays,
- the deal escrow remains unchanged,
- and public retrieval cannot drain long-term storage funding.

This sponsored open is used for:
- **Public deals** (anyone pays),
- **Allowlist deals** (allowlisted requesters pay),
- **Voucher deals** (voucher redeemers pay).

See: `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`.

### 2.4.3 Protocol retrieval sessions (close the “restricted deals still allow audit/repair” story)

Restricted deals MUST still allow protocol operations that keep the network healthy:

- **audit / liveness checking** (when clients are inactive),
- **repair / healing** (catch-up reconstruction, make-before-break replacement).

NilStore therefore adds a protocol-funded session open path:

- `MsgOpenProtocolRetrievalSession` opens a retrieval session with `funding=PROTOCOL`.
- Authorization is **deterministic**:
  - `PROTOCOL_REPAIR`: only the `pending_provider` of a REPAIRING slot may open repair sessions for that deal/slot.
  - `PROTOCOL_AUDIT`: only the assignee of a chain-derived audit task may open audit sessions.
- Funding is from a deterministic **audit budget** (Option A):

  - `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`
  - `audit_budget_mint = ceil(audit_budget_bps/10_000 * epoch_slot_rent)`, capped by `audit_budget_cap_bps`
  - unused budget may carry over up to 2 epochs

Defaults (from the baseline economy posture):
- Devnet/testnet: `audit_budget_bps=200`, `audit_budget_cap_bps=500`, carryover≤2 epochs
- Mainnet: `audit_budget_bps=100`, `audit_budget_cap_bps=200`, carryover≤2 epochs

This makes protocol audit/repair possible even for owner-only deals without conflating access control with privacy.

---

## 2.5 Public data explorer side project (ecosystem pattern)

A public explorer can:
1) Query chain state for deals with `retrieval_policy == Public`.
2) For each public deal, open a paid session to fetch **metadata MDUs** (MDU #0 + witness) and parse PolyFS.
3) Host metadata (file lists, sizes, hashes, previews) and facilitate broad public retrieval demand.

This creates:
- organic retrieval traffic (good for liveness),
- and community mirroring without requiring the deal owner to subsidize downloads.

---

## 2.6 Compression and content-encoding (charging on compressed bytes)

NilStore charges on stored bytes (ciphertext). Therefore:

- Clients SHOULD compress plaintext **before encryption** when beneficial.
- Compression metadata should be recorded in-band (inside the file bytes) so the client can decompress after decrypt.
- Storage and retrieval pricing apply to the resulting ciphertext bytes; compression reduces both storage lock-in and retrieval variable fees.

See: `rfcs/rfc-content-encoding-and-compression.md`.
