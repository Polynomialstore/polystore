# Specification: Data Granularity & Economic Model (v2.0)

**Status:** Approved Normative (Updated)
**Scope:** Core Protocol / Economics
**Depends on:** `spec.md`, `nil_core`
**Supersedes:** `metaspec.md` (legacy deal sizing language), `rfc_granularity_v1`

**Changelog (v2.0):**
*   Removes capacity tiers (`DealSize` / `size_tier`).
*   Clarifies **thin provisioning**: deals start at `size = 0` and grow only via content commits, up to a hard cap.

---

## 1. Motivation & Problem Statement
NilStore faces a fundamental architectural tension between Scalability and Performance.

* **The Scalability Constraint:** To store Exabytes of data without halting the blockchain, the ledger must track large aggregations of data. If the chain tracks small chunks individually, the state database will explode ("State Bloat").
* **The Performance Constraint:** To serve "Hot" data with sub-second latency, the system must allow users to retrieve specific, granular chunks instantly without waiting hours to "unseal" a large volume.

**Decision:** We adopt a **Dual-Unit Architecture**. We separate the Financial Ledger Unit (the **Deal** container, thin-provisioned up to `MAX_DEAL_BYTES`) from the Physical Retrieval Unit (`MDU_SIZE`).

---

## 2. The Financial Container: Thin-Provisioned Deals (No Tiers)
NilStore uses a **thin-provisioned** Deal container model:

*   `MsgCreateDeal*` creates a Deal with `manifest_root = empty`, `size = 0` (and `total_mdus = 0` until first commit).
*   `MsgUpdateDealContent*` commits content and advances the Deal’s `manifest_root`, `size`, and `total_mdus`.
*   There is **no user-selected capacity tier** and no on-chain `DealSize` enum.

### 2.1 Governance Policy
**Status:** PROTOCOL / PARAMETER (SET)

To prevent state bloat and manage failure domains, the protocol enforces a hard maximum capacity per Deal ID.

**Hard Cap (Normative):**
* **`MAX_DEAL_BYTES = 512 GiB`** per Deal ID.
* Large datasets should be split across multiple deals.

### 2.2 Scale Analysis
Adopting this aggregation strategy keeps the state size manageable. At a network size of 3 Exabytes (EiB):
* **Without Aggregation:** Chain tracks ~412 Billion entries (~115 TB state). *Impossible.*
* **With Aggregation:** Chain tracks ~100 Million entries (~28 GB state). *Manageable in RAM.*

---

## 3. The Physical Constant: MDU_SIZE
The Mega-Data Unit (MDU) is the atomic unit of storage, retrieval, and cryptographic verification.

### 3.1 Definition
* **Value:** 8,388,608 bytes (8 MiB)
* **Status:** IMMUTABLE PROTOCOL CONSTANT

### 3.2 Rationale
* **Cryptographic Safety:** The KZG Trusted Setup is generated specifically for this polynomial degree ($2^{22}$).
* **Protocol Uniformity:** A uniform chunk size eliminates "Heap Fragmentation" in Storage Provider memory and P2P logic.

---

## 4. Retrieval Pricing & Unified Gas Model
To support both small random access and huge sequential downloads, we standardize on a Single Retrieval API governed by a Unified Gas Model.

### 4.1 The Single API: `GetRange()`
The network exposes one method for all retrieval operations:
`GetRange(DealID, StartMDU, EndMDU)`

### 4.2 The Unified Gas Formula
Retrieval cost is split into Orchestration (Setup) and Transfer (Bandwidth).

$$\text{Retrieval Cost} = \text{Gas}_{Orch} + (\text{Gas}_{Byte} \times \text{TotalBytes})$$

* **$\text{Gas}_{Orch}$ (The "Request Fee"):** A fixed overhead charged per API call.
    * *Purpose:* Pays for specific SP computational work (**Authentication, Disk Seek, Session Initialization**) and discourages DDoS.
* **$\text{Gas}_{Byte}$ (The "Transfer Fee"):** A variable fee charged per byte delivered.
    * *Purpose:* Pays for physical network egress.

### 4.3 Economic Incentives (The "Golden Path")
This model creates a native economic incentive for batching.

| Request Type | Total Bytes | Gas Breakdown | Effective Cost/MB |
| :--- | :--- | :--- | :--- |
| **Single MDU** | 8 MiB | High % Orchestration | **High (Premium)** |
| **Batch (Max Range)** | `Deal.size` (≤ `MAX_DEAL_BYTES`) | Low % Orchestration | **Low (Efficient)** |

---

## 5. Batch Limit Policy
**Decision:** **Option 1 (Natural Limit)**.

The maximum batch size is bounded by the Deal’s committed content (`Deal.size`) and the hard cap (`MAX_DEAL_BYTES`). We rely on that mechanism as the safety valve.

> **Design Note: Rejection of Artificial Caps**
> During the architectural review (v8), we considered implementing an artificial "Step Function" cap (e.g., forcing a new request every 64 GiB).
>
> This was **rejected** for the following reasons:
> 1.  **Arbitrary Friction:** It introduces unnecessary latency for legitimate archive retrievals.
> 2.  **Pricing Distortion:** Re-introducing $\text{Gas}_{Orch}$ fees every 64 GB creates a "step function" in pricing that penalizes large-scale enterprise users.
> 3.  **Simplicity:** Relying on the `MAX_DEAL_BYTES` natural limit simplifies the state machine and reduces parameter complexity.

---

## 6. Implementation Directives
1.  **Core Cryptography:** Hardcode `MDU_SIZE = 8,388,608` in `nil_core`.
2.  **Chain Logic (Thin Provisioning):**
    *   `MsgCreateDeal*` initializes `size = 0`, `manifest_root = empty`, `total_mdus = 0` (until first content commit).
    *   `MsgUpdateDealContent*` enforces `size ≤ MAX_DEAL_BYTES` and advances the committed state.
    *   Remove `DealSize` / `size_tier` from request payloads and EIP-712 typed-data in all clients.
3.  **Client SDK:** Implement `GetRange()` as the primary retrieval method. The SDK should default to requesting the largest necessary range (up to the remaining file span) to minimize $\text{Gas}_{Orch}$ costs for the user.

---

### Suggested Next Step
Add shared, cross-language test vectors for EIP-712 message hashes (CreateDealV2 + UpdateContent) and range-cost calculations so web/scripts and the chain verifier cannot drift.
