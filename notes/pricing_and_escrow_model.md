# Pricing & Escrow Model (Gamma-4 Economics)

**Date:** 2025-12-15
**Status:** Revised Draft / Partially Implemented (Devnet)
**Context:** Devnet economics for deal creation fees, term deposits on ingest, and escrow accounting.

## 1. Executive Summary

Instead of a continuously draining balance, Devnet treats storage as a **term deposit**: when content is committed to a deal, the user prepays for the full deal duration based on the current `storage_price`.

*   **Creation Fee:** Fixed cost to initialize a Deal (`MsgCreateDeal` / `MsgCreateDealFromEvm`).
*   **Initial Escrow:** Optional upfront escrow deposit at deal creation (in base denom).
*   **Ingest Payment (Term Deposit):** When `MsgUpdateDealContent*` increases `deal.size`, the user prepays for `delta_size_bytes * deal_duration_blocks * storage_price`.

This lock-in model ensures new storage capacity is paid for immediately at the spot price, without retroactively changing the cost of already-committed bytes.

---

## 2. Global Parameters (Chain State)

| Parameter | Type | Default (Devnet) | Description |
| :--- | :--- | :--- | :--- |
| `deal_creation_fee` | `Coin` | `0stake` | Fixed cost to execute `MsgCreateDeal` / `MsgCreateDealFromEvm` (sent to fee collector). |
| `storage_price` | `Dec` | `0` | Price per byte per block, charged when increasing `deal.size` via `MsgUpdateDealContent*`. |
| `min_duration_blocks` | `uint64` | `10` | Minimum `duration_blocks` accepted by `MsgCreateDeal` / `MsgCreateDealFromEvm`. |

**Denom:** Devnet uses the Cosmos bond denom (`sdk.DefaultBondDenom`, currently `stake`) for fees, escrow, and term deposits.

---

## 3. The "Lock-in" Lifecycle

### 3.1 Drive Initialization (`MsgCreateDeal`)
The user initializes a "Drive" (Deal container). This action reserves the Deal ID and assigns storage providers.

*   **Validation:** `duration_blocks >= min_duration_blocks`.
*   **Cost:** `deal_creation_fee` (base denom) + optional `initial_escrow_amount` (base denom).
*   **Action:**
    *   Transfer `deal_creation_fee` from user to fee collector (if non-zero).
    *   Transfer `initial_escrow_amount` from user to the `nilchain` module account.
    *   Create `Deal` with `size = 0`, `manifest_root` empty, `start_block = now`, `end_block = now + duration_blocks`.

### 3.2 Ingest / Commit Content (`MsgUpdateDealContent`)
The user uploads files (e.g., 1 GB) and commits them to the Drive. At this moment, they must fund this new data.

*   **Input:**
    *   `new_size_bytes`: total deal size after commit (bytes).
    *   `cid`: 48-byte `manifest_root` (hex).
*   **Pricing Logic (Chain):**
    *   `delta_size = max(0, new_size_bytes - old_size_bytes)`.
    *   `duration_blocks = deal.end_block - deal.start_block`.
    *   `cost = ceil(storage_price * delta_size * duration_blocks)`.
*   **Action:**
    *   Transfer `cost` from user to the `nilchain` module account (if `cost > 0`).
    *   Increase `deal.escrow_balance` by `cost` (accounting / TVL).
    *   Update `deal.manifest_root` and `deal.size`.

### 3.3 Adding More Data (Expansion)
The user adds another 2 GB file, 6 months later.

*   **Scenario:** `storage_price` has increased since the first commit.
*   **Cost:** Only the *additional bytes* are charged at the new price:
    *   `delta_size = new_size_bytes - old_size_bytes`
    *   `cost = ceil(storage_price * delta_size * duration_blocks)`
*   **Action:** User pays the higher rate only for the newly-added bytes.

### 3.4 Extending Life (Refueling)
The user wants to extend the Drive's life beyond `end_block`.

**Not implemented in Devnet yet.** A future `MsgExtendDeal` (or equivalent) should charge at the current `storage_price` to push `end_block` forward.

---

## 4. Escrow vs. Term Payments

In this model, `Deal.escrow_balance` behaves differently:

*   **Old Model:** A draining battery.
*   **New Model (Devnet):** An accounting value for escrow + term deposits. Storage term deposits are transferred immediately on `MsgUpdateDealContent*` (when `deal.size` increases). Deal expiry (`end_block`) is currently set at creation time and does not change yet.

### Why this is better?
1.  **Certainty:** Users know exactly when their data expires (`end_block`). They don't have to guess "how long will my balance last if price fluctuates?".
2.  **Incentives:** Users are incentivized to buy long-term storage when prices are low (locking in the rate).
3.  **Simplicity:** No continuous on-chain calculation of "burn rate". Settlement is instant per transaction.

---

## 5. User Journey Example (Illustrative)

1.  **Create Deal:** User executes `MsgCreateDeal` with `duration_blocks`.
    *   Chain enforces `duration_blocks >= min_duration_blocks`.
    *   Chain collects `deal_creation_fee` (if non-zero) and locks `initial_escrow_amount` in the module account.
2.  **Commit Content:** User uploads data off-chain, then executes `MsgUpdateDealContent` with `cid` + `new_size_bytes`.
    *   If `new_size_bytes` increased, chain charges `ceil(storage_price * delta_size * duration_blocks)` and credits it into `deal.escrow_balance`.
3.  **Add More Files Later:** User commits a larger `new_size_bytes`.
    *   Only the additional bytes are charged (delta-based).

---

## 6. Implementation Plan

1.  **Future:** Add `MsgExtendDeal` or allow updating `end_block` by paying for extension at current `storage_price`.
2.  **Future:** Split accounting so retrieval credits / bandwidth and storage term deposits are tracked separately.
3.  **UI:** Display "Lease Expires" derived from `end_block`.

---

## 7. TODO (Spec-Only): Deal Expiry Cleanup / GC

Devnet currently does **not** implement automatic cleanup when `end_block` is reached.

**TODO:** Specify and implement a cleanup process (likely in EndBlocker) that:
1. Marks deals as expired and stops rewarding proofs past expiry (if applicable).
2. Defines retention / grace period rules.
3. Cleans up on-chain state (or archives it) and coordinates with gateway/SP local storage lifecycle.

This is intentionally **not implemented** yet; it will be required for mainnet-grade lifecycle management.

---

## 8. Retrieval Economics (Bandwidth & Credits)

In addition to storage costs, the protocol charges for data egress (retrieval). This prevents network abuse and compensates providers for bandwidth.

### 8.1 Global Parameters (Chain State)

| Parameter | Type | Default (Devnet) | Description |
| :--- | :--- | :--- | :--- |
| `base_retrieval_fee` | `uint64` | `100` | Fixed cost per `RetrievalSession` (anti-spam). |
| `price_per_retrieval_byte` | `uint64` | `1` | Cost per byte downloaded. |

### 8.2 Built-in Retrieval Credit
To improve UX, purchasing storage includes a "Free Tier" for retrieval.

*   **Logic:** Every `1 GB-Month` of storage purchased grants `X` GB of retrieval credit.
*   **State:** `Deal` struct gains a `retrieval_credit` field (bytes).
*   **Accrual:**
    *   When `MsgUpdateDealContent` or `MsgExtendDeal` is called:
    *   `credit_earned = f(delta_size_bytes, duration_blocks)` (exact function TBD).
    *   `Deal.retrieval_credit += credit_earned`.

### 8.3 Consumption Hierarchy
When a `RetrievalSession` is completed (`MsgConfirmRetrievalSession` + Proof):

1.  **Calculate Cost:** `total_cost = base_retrieval_fee + (bytes_served * price_per_retrieval_byte)`.
2.  **Deduct Credit:**
    *   If `Deal.retrieval_credit >= total_cost`:
        *   `Deal.retrieval_credit -= total_cost`.
        *   `paid_from_escrow = 0`.
    *   Else:
        *   `remaining_cost = total_cost - Deal.retrieval_credit`.
        *   `Deal.retrieval_credit = 0`.
        *   `paid_from_escrow = remaining_cost`.
3.  **Deduct Escrow:**
    *   `Deal.escrow_balance -= paid_from_escrow`.
    *   If `escrow_balance` < 0, the retrieval debt is recorded or the session fails (if checked at open time).

### 8.4 Top-Up (Retrieval Balance)
Users can fund retrieval beyond the free tier using `MsgAddCredit`.
*   Since `escrow_balance` is no longer used for storage rent (which is paid via Term Deposits), `escrow_balance` **effectively becomes the "Retrieval/Gas Tank"**.
*   **UX:** "Add Fuel for Downloads".
