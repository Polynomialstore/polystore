# PolyStore Litepaper: The Sealing-Free Storage Network
**Technical Overview v2.8**

## 1. Introduction & Value Proposition
PolyStore is a high-throughput, verifiable decentralized storage network designed to democratize access to the storage economy while delivering cloud-grade performance.

By utilizing a **Performance Market** (tiered rewards) and **System-Defined Placement**, PolyStore enables a diverse marketplace of Storage Providers (SPs) to provide instant, verifiable data retrieval. The network stores data in a canonical striped RS(`K`,`K+M`) layout, giving users cloud-grade throughput without the latency or hardware overhead of legacy "sealing" protocols.

### Value for Storage Providers
*   **Commodity Hardware Access:** No GPU sealing. Providers are judged on **Response Time**, incentivizing standard NVMe/SSD storage.
*   **Fair Competition:** Deterministic placement ensures that even small providers get assigned deals, preventing monopolies.
*   **Unified Revenue:** Earn rewards for both **Storage** (liveness) and **Bandwidth** (traffic) in a single flow.

### Value for Data Owners
*   **Instant Availability:** Data is stored in 8 MiB Mega-Data Units (MDUs) for efficient retrieval.
*   **User-Funded Elasticity:** Viral content automatically scales using **additional slot-aligned placements** funded by the deal's escrow.
*   **Configurable Resilience:** Users choose service intent and redundancy profile, and the network assigns an ordered slot map for RS(`K`,`K+M`) retrieval.
*   **Enterprise Privacy:** Data is encrypted client-side. Scaling is "Zero-Touch" because the network can replicate ciphertext. Deletion is handled via **Crypto-Erasure**.

---

## 2. The Core Innovation: Unified Liveness
Instead of separate "Storage Audits" and "Retrieval Requests," PolyStore unifies them.

### A. The "User is the Auditor"
*   **Hot Data:** When a user downloads a file, they open a **Retrieval Session** on-chain (MetaMask), fetch the data, and confirm completion. The Provider submits a session-bound proof; session completion becomes storage evidence for that retrieval.
*   **Pricing (Gamma-4):** A base fee is burned on session open and a per-blob fee is locked from escrow and paid to the Provider on completion (minus a protocol burn).
*   **Cold Data:** If no user asks for the file, the **System** acts as the "User of Last Resort," issuing a random challenge. The Provider responds to prove liveness.

### B. The Performance Market (Tiered Rewards)
We don't ban S3. We just pay for speed.
*   **Platinum (example: Block H+1):** 100% Reward. (Requires local NVMe).
*   **Gold (example: Block H+5):** 80% Reward.
*   **Fail (example: >H+20):** 0% Reward + Slash. (Glacier/Offline).

### C. Retrievability & Self-Healing (High-Level)

PolyStore's retrieval layer is designed so that:

*   For every `(Deal, Slot)` pair, either the data is retrievable under protocol rules, or there is verifiable evidence the accountable Provider failed (wrong data or non-response) and can be punished.
*   Providers who repeatedly fail retrievals are automatically pushed out of placements and replaced by healthier nodes over time.

Concretely, the architecture adds:

*   **Challenge Structure:** Each retrieval carries enough information (epoch randomness, nonce, deal and slot IDs) for the protocol to derive a deterministic KZG checkpoint inside the requested range, making every retrieval a potential storage proof.
*   **Synthetic Checks for Cold Data:** The chain periodically selects random chunks for each Deal/Slot and requires proofs even when no one is actively downloading the file.
*   **Provider Audit Debt:** Providers periodically act as mystery shoppers for other Providers, issuing retrievals and reporting misbehavior. The more data you store, the more audits you are expected to perform.
*   **Health & Eviction:** The protocol maintains simple health scores per Deal/Slot and uses them to decide when to add new placements and evict bad actors, so the network self-heals as it runs.

---

## 3. The Architecture: A Hybrid Approach

### Layer 1: Consensus (Cosmos-SDK)
*   **Role:** The "Dispatcher."
*   **Function:** Manages the **Active Provider List**, executes **System-Defined Placement**, verifies **KZG Proofs**, and tracks slot assignments and retrieval outcomes.

### Layer 2: EVM Compatibility (MetaMask)
*   **Role:** Wallet-facing execution inside PolyStore Chain (no separate settlement chain in devnet).
*   **Function:** Hosts EVM-compatible signatures and the PolyStore precompile used for retrieval sessions and future contracts.

### Client Layer: Browser + Gateway (Optional)
*   **Browser/WASM:** Generates stripes and proofs locally and stores slabs in OPFS.
*   **Gateway/CLI:** Optional routing + caching infrastructure (also powers the S3 adapter). Gateways never sign on behalf of users.

---

## 4. The Lifecycle of a File

### Step 1: Ingestion
1.  **Deal:** User sends `MsgCreateDeal`, creating a thin-provisioned container with service intent and budget controls.
2.  **Placement:** The chain deterministically assigns an ordered slot list of size `N = K+M`.
3.  **Upload:** The client performs RS(`K`,`K+M`) encoding per SP-MDU and uploads per-slot shards directly to the assigned Providers.
4.  **Commit:** User submits `MsgUpdateDealContent` to commit the `manifest_root`.

*Devnet note:* a gateway relay/faucet can sponsor gas for demos, but it is disabled by default in the mainnet-parity posture.

### Step 2: The Loop
*   **Traffic:** Users request data via retrieval sessions. After a successful download, the user confirms the session and the Provider submits the session proof for liveness and bandwidth fees.
*   **Silence:** When nobody requests the file, the chain issues synthetic challenges. Providers respond with proofs derived from their stored MDUs.

### Step 3: Scaling
*   **Saturation:** If a Platinum node is overwhelmed, it signals the chain.
*   **Action:** The chain checks the User's `MaxSpend` budget. If funds exist, it authorizes **additional slot-aligned placements** on new edge nodes to absorb the load.

---

## 5. The Economy (Token-Denominated)
*   **Token Denom:** The protocol uses the chain's bond denom (devnet defaults to `stake`; `$STOR` is a future branding choice).
*   **Burn Mechanism:** A portion of every retrieval fee is **burned** (base fee + configurable burn bps on the variable fee).
*   **Real Pricing:** Storage and bandwidth are priced by the market to reflect physical infrastructure costs.

---

## 6. Enterprise Features
*   **Zero-Knowledge Cloud:** Providers store encrypted 8 MiB MDUs (`AES-256-GCM`). They cannot read your data.
*   **Proof of Deletion:** You hold the key. Destroy the key, and the data becomes irretrievable everywhere it was stored (Crypto-Erasure).
