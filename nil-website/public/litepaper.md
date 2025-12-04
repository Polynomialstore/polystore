# NilStore Litepaper: The Sealing-Free Storage Network
**Technical Overview v2.6**

## 1. Introduction & Value Proposition
NilStore is a high-throughput, verifiable decentralized storage network designed to democratize access to the storage economy while delivering cloud-grade performance.

By utilizing a **Performance Market** (Tiered Rewards) and **System-Defined Placement**, NilStore enables a diverse marketplace of Storage Providers (SPs) to provide instant, verifiable data retrieval. This architecture ensures data is always available for high-performance workloads without the latency or hardware overhead of legacy "Sealing" protocols.

### Value for Storage Providers
*   **Commodity Hardware Access:** No GPU sealing. Providers are judged on **Response Time**, incentivizing standard NVMe/SSD storage.
*   **Fair Competition:** Deterministic placement ensures that even small providers get assigned deals, preventing monopolies.
*   **Unified Revenue:** Earn rewards for both **Storage** (Liveness) and **Bandwidth** (Traffic) in a single flow.

### Value for Data Owners
*   **Instant Availability:** Data is stored in 8 MiB Mega-Data Units (MDUs) for efficient retrieval.
*   **User-Funded Elasticity:** Viral content automatically scales using **Stripe-Aligned Scaling** to meet demand, funded by the deal's escrow.
*   **Configurable Resilience:** Users define `ServiceHints` (Hot/Cold) to optimize placement for cost (Archive) or speed (Edge).
*   **Enterprise Privacy:** Data is encrypted client-side. Scaling is "Zero-Touch" (network replicates ciphertext). Deletion is guaranteed via **Crypto-Erasure**.

---

## 2. The Core Innovation: Unified Liveness
Instead of separate "Storage Audits" and "Retrieval Requests," NilStore unifies them.

### A. The "User is the Auditor"
*   **Hot Data:** When a user downloads a file, they sign a receipt. This receipt **counts as the Storage Proof** for that epoch. The SP gets paid double (Storage Reward + Bandwidth Fee).
*   **Cold Data:** If no user asks for the file, the **System** acts as the "User of Last Resort," issuing a random challenge. The SP responds to prove liveness.

### B. The Performance Market (Tiered Rewards)
We don't ban S3. We just pay for speed.
*   **Platinum (Block H+1):** 100% Reward. (Requires Local NVMe).
*   **Gold (Block H+5):** 80% Reward.
*   **Fail (>H+20):** 0% Reward + Slash. (Glacier/Offline).

---

## 3. The Architecture: A Hybrid Approach

### Layer 1: Consensus (Cosmos-SDK)
*   **Role:** The "Dispatcher."
*   **Function:** Manages the **Active Provider List**, executes **System-Defined Placement**, and verifies **KZG Proofs**. It calculates reward tiers based on proof inclusion height.

### Layer 2: Settlement (EVM)
*   **Role:** The "Bank."
*   **Function:** Hosts the **$STOR** token, Deal NFTs, and DAO governance.

---

## 4. The Lifecycle of a File

### Step 1: Ingestion
1.  **Deal:** User sends `MsgCreateDeal(Hint: "Hot", MaxSpend: 100)`.
2.  **Placement:** The Chain deterministically assigns 12 Providers for **8 MiB MDUs**.
3.  **Upload:** User streams data to the assigned nodes.

### Step 2: The Loop
*   **Traffic:** Users request data. SPs serve it and submit receipts.
*   **Silence:** Chain issues challenges. SPs submit proofs.

### Step 3: Scaling
*   **Saturation:** If a Platinum node is overwhelmed, it signals the chain.
*   **Action:** The Chain checks the User's `MaxSpend` budget. If funds exist, it spawns **Hot Replicas** using **Stripe-Aligned Scaling** on new Edge nodes to absorb the load.

---

## 5. The Economy ($STOR-Only)
*   **$STOR Token:** The single medium for Staking (Security) and Bandwidth (Utility).
*   **Burn Mechanism:** A portion of every retrieval fee is **burned**.
*   **Real Pricing:** Storage and bandwidth are priced by the market to reflect physical infrastructure costs.

---

## 6. Enterprise Features
*   **Zero-Knowledge Cloud:** Providers store encrypted 8 MiB MDUs (`AES-256`). They cannot read your data.
*   **Proof of Deletion:** You hold the key. Destroy the key, and the data is globally erased (Crypto-Erasure).