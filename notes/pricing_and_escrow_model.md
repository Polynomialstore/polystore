# Pricing & Escrow Model (Market-Rate Lock-in)

**Date:** 2025-12-15
**Status:** Revised Draft / Proposal
**Context:** Defining dynamic economic mechanics where storage is purchased at the **current market rate** at the moment of ingest or extension.

## 1. Executive Summary

Instead of a generic prepaid balance that drains at a variable rate, this model treats storage as a **Term Deposit**. Users pay up-front for specific capacity/duration slices at the *market price at that moment*.

*   **Creation Fee:** Fixed cost to initialize a Drive (Deal ID).
*   **Ingest Payment:** When uploading files, the user prepays for the storage duration at the **current spot price**.
*   **Extension Payment:** Extending the life of data happens at the **new spot price**.

This protects users from sudden price hikes for *already paid* data, while ensuring the network captures value if demand rises for *new* storage.

---

## 2. Global Parameters (Chain State)

| Parameter | Type | Default (Devnet) | Description |
| :--- | :--- | :--- | :--- |
| `base_creation_fee` | `uint64` | `1_000_000` (1 NIL) | Fixed cost to execute `MsgCreateDeal`. |
| `spot_price_per_gb_epoch` | `uint64` | `100` | **Dynamic.** The current market price to buy 1 GB of storage for 1 Epoch. |

*Note: In Devnet, `spot_price` is a fixed param. In Mainnet, this is an algorithmic curve based on network utilization.*

---

## 3. The "Lock-in" Lifecycle

### 3.1 Drive Initialization (`MsgCreateDeal`)
The user initializes a "Drive" (Container). This action reserves the Deal ID and the initial Metadata MDU (MDU #0).

*   **Cost:** `base_creation_fee`.
*   **Action:**
    *   User pays 1 NIL.
    *   Chain creates `Deal` with `size = 0` and `end_block = 0` (or a small initial grace period).
    *   *Result:* An empty "Drive" exists.

### 3.2 Ingest / Commit Content (`MsgUpdateDealContent`)
The user uploads files (e.g., 1 GB) and commits them to the Drive. At this moment, they must fund this new data.

*   **Input:**
    *   `new_size`: 1 GB.
    *   `duration_epochs`: e.g., 525,600 (1 year).
*   **Pricing Logic (Chain):**
    *   `rate = Params.spot_price_per_gb_epoch` (e.g., 100).
    *   `cost = new_size_gb * duration_epochs * rate`.
    *   `cost = 1 * 525,600 * 100 = 52,560,000` (52.5 NIL).
*   **Action:**
    *   User pays 52.5 NIL immediately.
    *   Chain updates `Deal.end_block` to reflect the paid duration.
    *   *Result:* This specific 1 GB is strictly paid for until `end_block`.

### 3.3 Adding More Data (Expansion)
The user adds another 2 GB file, 6 months later.

*   **Scenario:** Spot price has doubled (`rate = 200`).
*   **Input:** `added_size`: 2 GB. `remaining_epochs`: 262,800 (6 months).
*   **Cost:** `2 * 262,800 * 200 = 105,120,000` (105.1 NIL).
*   **Action:** User pays the higher rate for the *new* data. The *old* data remains paid for at the old rate (effectively, because `end_block` covers the aggregate).

### 3.4 Extending Life (Refueling)
The user wants to extend the Drive's life by another year (`MsgExtendDeal`).

*   **Scenario:** Spot price is now `rate = 200`.
*   **Input:** `extension_epochs`: 525,600.
*   **Total Size:** 3 GB.
*   **Cost:** `3 * 525,600 * 200`.
*   **Observation:** Extensions are priced at the **current market rate** for the **entire volume**.

---

## 4. Escrow vs. Term Payments

In this model, `Deal.escrow_balance` behaves differently:

*   **Old Model:** A draining battery.
*   **New Model:** A holding tank for *future* extensions or *bandwidth* fees. The storage fees are **deducted immediately** upon `MsgUpdateDealContent` or `MsgExtendDeal` to push out `end_block`.

### Why this is better?
1.  **Certainty:** Users know exactly when their data expires (`end_block`). They don't have to guess "how long will my balance last if price fluctuates?".
2.  **Incentives:** Users are incentivized to buy long-term storage when prices are low (locking in the rate).
3.  **Simplicity:** No continuous on-chain calculation of "burn rate". Settlement is instant per transaction.

---

## 5. User Journey Example (Revised)

1.  **"New Drive":** User clicks "New Drive".
    *   Prompt: "Pay 1 NIL to initialize Drive."
    *   Tx: `MsgCreateDeal`. Status: Empty.
2.  **Upload:** User stages 1 GB file.
    *   UI Prompt: "Market Rate is 100/epoch. To store this 1 GB for 1 Year, pay 52.5 NIL."
    *   User approves.
    *   Tx: `MsgUpdateDealContent` (transfers 52.5 NIL).
    *   Status: "Paid until Dec 2026".
3.  **Price Spike:** Market rate doubles to 200/epoch.
4.  **Upload 2:** User stages 100 MB.
    *   UI Prompt: "Market Rate is 200/epoch. Cost for remaining 6 months: ~5 NIL."
    *   User pays. The old 1 GB is unaffected.
5.  **Refuel:** In Dec 2026, user extends for 1 more year.
    *   UI Prompt: "Market Rate is 200/epoch. Total Drive Size 1.1 GB. Cost to extend: ~115 NIL."
    *   User pays the *new* rate for the extension.

---

## 6. Implementation Plan

1.  **Proto:** Remove `escrow_balance` drain logic from EndBlocker. Keep `escrow` for bandwidth (retrieval) only.
2.  **Msg:** Update `MsgUpdateDealContent` to accept an optional `extension_epochs` or enforce alignment with existing `end_block`.
3.  **Msg:** Add `MsgExtendDeal` to push `end_block` forward by paying `current_size * duration * spot_price`.
4.  **UI:** Dashboard displays "Lease Expires: [Date]" instead of "Fuel Low".

---

## 7. Retrieval Economics (Bandwidth & Credits)

In addition to storage costs, the protocol charges for data egress (retrieval). This prevents network abuse and compensates providers for bandwidth.

### 7.1 Global Parameters (Chain State)

| Parameter | Type | Default (Devnet) | Description |
| :--- | :--- | :--- | :--- |
| `base_retrieval_fee` | `uint64` | `100` | Fixed cost per `RetrievalSession` (anti-spam). |
| `price_per_retrieval_byte` | `uint64` | `1` | Cost per byte downloaded. |

### 7.2 Built-in Retrieval Credit
To improve UX, purchasing storage includes a "Free Tier" for retrieval.

*   **Logic:** Every `1 GB-Month` of storage purchased grants `X` GB of retrieval credit.
*   **State:** `Deal` struct gains a `retrieval_credit` field (bytes).
*   **Accrual:**
    *   When `MsgUpdateDealContent` or `MsgExtendDeal` is called:
    *   `credit_earned = (new_duration_epochs * size_bytes * credit_multiplier)`.
    *   `Deal.retrieval_credit += credit_earned`.

### 7.3 Consumption Hierarchy
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

### 7.4 Top-Up (Retrieval Balance)
Users can fund retrieval beyond the free tier using `MsgAddCredit`.
*   Since `escrow_balance` is no longer used for storage rent (which is paid via Term Deposits), `escrow_balance` **effectively becomes the "Retrieval/Gas Tank"**.
*   **UX:** "Add Fuel for Downloads".