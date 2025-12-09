# Specification: Data Granularity & Economic Model (v1.0)

**Status:** Approved Normative
**Scope:** Core Protocol / Economics
**Depends on:** `spec.md`, `nil_core`
**Supersedes:** `metaspec.md` (Deal Size definitions), `rfc_granularity_v1`

---

## 1. Motivation & Problem Statement
NilStore faces a fundamental architectural tension between Scalability and Performance.

* **The Scalability Constraint:** To store Exabytes of data without halting the blockchain, the ledger must track large aggregations of data. If the chain tracks small chunks individually, the state database will explode ("State Bloat").
* **The Performance Constraint:** To serve "Hot" data with sub-second latency, the system must allow users to retrieve specific, granular chunks instantly without waiting hours to "unseal" a large volume.

**Decision:** We adopt a **Dual-Unit Architecture**. We separate the Financial Ledger Unit (`DEAL_SIZE`) from the Physical Retrieval Unit (`MDU_SIZE`).

---

## 2. The Financial Container: DEAL_SIZE
The Deal Size is the unit of accounting on the blockchain. It represents a commitment to store a specific volume of capacity.

### 2.1 Governance Policy
**Status:** GOVERNANCE PARAMETER (SET)

The network will not allow arbitrary deal sizes. To prevent database dust, users must purchase capacity in specific, governance-approved increments.

**Approved Tiers:**
* **Tier 1: Developer Slab (4 GiB):** Entry-level capacity for testing. Priced at a premium.
* **Tier 2: Standard Slab (32 GiB):** The baseline network unit. **Note:** This size is strictly aligned with Filecoin sectors to facilitate future bridging and interoperability.
* **Tier 3: Wholesale Slab (512 GiB):** High-volume tier for Enterprise/Archive use cases.

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
| **Batch (Max Range)** | `DEAL_SIZE` | Low % Orchestration | **Low (Efficient)** |

---

## 5. Batch Limit Policy
**Decision:** **Option 1 (Natural Limit)**.

The maximum batch size is implicitly `DEAL_SIZE`. Since we already cap the `DEAL_SIZE` via Governance (max 512 GiB), we rely on that mechanism as the safety valve.

> **Design Note: Rejection of Artificial Caps**
> During the architectural review (v8), we considered implementing an artificial "Step Function" cap (e.g., forcing a new request every 64 GiB).
>
> This was **rejected** for the following reasons:
> 1.  **Arbitrary Friction:** It introduces unnecessary latency for legitimate archive retrievals.
> 2.  **Pricing Distortion:** Re-introducing $\text{Gas}_{Orch}$ fees every 64 GB creates a "step function" in pricing that penalizes large-scale enterprise users.
> 3.  **Simplicity:** Relying on the `DEAL_SIZE` natural limit simplifies the state machine and reduces parameter complexity.

---

## 6. Implementation Directives
1.  **Core Cryptography:** Hardcode `MDU_SIZE = 8,388,608` in `nil_core`.
2.  **Chain Logic:** Implement `MsgCreateDeal` to accept a `DealSize` enum corresponding strictly to the approved tiers in Section 2.1.
3.  **Client SDK:** Implement `GetRange()` as the primary retrieval method. The SDK should default to requesting the largest necessary range (up to the full `DEAL_SIZE`) to minimize $\text{Gas}_{Orch}$ costs for the user.

---

### Suggested Next Step
Now that the Data Granularity Spec is finalized, would you like me to draft the **`nil_core` Rust struct definitions** for the `DealSize` enum and the `Gas` calculation logic to match this spec?
