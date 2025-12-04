# Website Upgrade Plan: The "Market-Driven" Architecture (v2)

**Status:** Approved for Execution
**Target:** Transform `nil-website` from a "Crypto-Verification" showcase into a "Cloud Performance" showcase, aligning with Core v2.6.

---

## 1. The Core Narrative Shift
*   **Old Story:** "We catch lazy providers using math (PoDE)."
*   **New Story:** "We pay for performance. Speed is revenue. Users are auditors."
*   **Key Concept:** **Unified Liveness.** Every download is a proof. This eliminates overhead and aligns incentives perfectly.

---

## 2. Detailed Implementation Strategy

### A. Home Page (`src/pages/Home.tsx`)
*   **Hero Section:**
    *   *Tagline:* "The Self-Healing Performance Market."
    *   *Subtext:* "A decentralized storage network where **Speed is Consensus**. Data flows fluidly across a homogeneous Nilmanifold, scaling instantly to meet demand."
*   **Feature Grid (Rewrite):**
    *   **Card 1: Unified Liveness.**
        *   *Icon:* `Zap` (Lightning).
        *   *Copy:* "Zero Wasted Work. User retrievals *are* the storage proofs. We don't separate 'auditing' from 'serving'. High traffic = High security."
    *   **Card 2: The Performance Market.**
        *   *Icon:* `Trophy` (Ranking).
        *   *Copy:* "Tiered Rewards. Responses in Block H+1 earn Platinum rewards. Slow adapters earn dust. We don't ban S3; we just make it unprofitable."
    *   **Card 3: Elasticity & Privacy.**
        *   *Icon:* `Scale` (Scaling).
        *   *Copy:* "Stripe-Aligned Scaling. Viral content spawns 'Hot Replicas' automatically, funded by user escrow. Zero-Knowledge encryption ensures privacy even during replication."

### B. Technology Page (`src/pages/Technology.tsx`)
*   **Visual Refactor:** Change the 1-2-3 flow to: **Ingest (8MiB)** -> **Bind (KZG)** -> **Compete (Tiers)**.
*   **Sub-Component Overhauls:**
    1.  **`ShardingDeepDive.tsx`:**
        *   **Major Update:** Switch from 128KB to **8 MiB Mega-Data Units (MDUs)**.
        *   **Add:** Explanation of **"System-Defined Placement"**. Show how the chain assigns slots deterministically (`Hash(DealID + Block)`) to prevent Sybil attacks.
    2.  **`KZGDeepDive.tsx`:**
        *   **Refine:** Clarify that KZG proofs are attached to *Retrieval Receipts*.
    3.  **`PerformanceDeepDive.tsx` (Replaces `ArgonDeepDive`):**
        *   **Concept:** "The Latency Racer".
        *   **Interactive:** A visualization showing three lanes (NVMe, HDD, S3).
        *   **Animation:** A "Request" signal fires.
            *   NVMe Node finishes in **Block H+1** (Platinum Reward).
            *   HDD Node finishes in **Block H+5** (Gold Reward).
            *   S3 Node finishes in **Block H+20** (Fail/Slash).
        *   **Takeaway:** "Physics dictates the payout."

### C. Security Page: "The Bankruptcy Simulation" (`src/pages/AdversarialSimulation.tsx`)
*   **Shift Focus:** Move from "Pass/Fail" to "Profit/Loss".
*   **New Simulation Script (`simulate_economics_attack.py`):**
    *   **Inputs:** Storage Cost ($/GB), Bandwidth Cost ($/GB), Latency Distribution (ms).
    *   **Agent A (Local NVMe):** High Storage Cost, Low Latency. -> High Rewards. **Result: Profitable.**
    *   **Agent B (S3 Wrapper):** Low Storage Cost, High Latency (Network Fetch). -> Low/Zero Rewards. **Result: Bankrupt.**
*   **Visual:** A line chart showing the cumulative bank balance of both agents over 100 epochs. The Attacker's line goes to zero.

### D. New Component: "Viral Elasticity" (in `EconomyDashboard` or new page)
*   **Concept:** Visualize **"Stripe-Aligned Scaling"**.
*   **Interactive:** "Trigger Viral Spike" button.
*   **Visual:**
    1.  Show a file with 12 Replicas (Base).
    2.  Traffic meter spikes.
    3.  **Saturation Signal** fires.
    4.  System spawns 12 *new* replicas (Overlay Stripe).
    5.  User Escrow drains faster (Cost), but Latency stays low (Performance).

### E. FAQ (`src/pages/FAQ.tsx`)
*   **Q:** "Why 8 MiB Units?" -> *A: To optimize throughput and batch verification overhead.*
*   **Q:** "What is Unified Liveness?" -> *A: Converting useful work (serving users) into consensus proofs.*
*   **Q:** "Can I delete data?" -> *A: Yes, via Crypto-Erasure. Destroy the key, and the data becomes noise.*

---

## 3. Execution Order

1.  **Infrastructure:** Update `simulate_adversarial.py` to model the P&L scenarios.
2.  **Components:** Build `PerformanceDeepDive` (The Racer) and update `ShardingDeepDive`.
3.  **Pages:** Refactor Home and Security pages with new copy and simulations.
4.  **Docs:** Update FAQ and S3 Adapter docs (to mention 8MiB chunking).