# RFC: Decentralized Placement & Knapsack Solver

**Status:** Draft / Non‑normative  
**Scope:** Off‑chain / committee‑driven placement optimization (Macro-Optimizer)  
**Depends on:** `spec.md` (Mode 1), `metaspec.md` §7, `rfcs/rfc-heat-and-dynamic-placement.md`

---

## 1. Motivation & Problem Statement

NilStore faces a "Map vs. Territory" problem. The on-chain "Map" (Deals, heat scores, reported capacity) is a lagged, low-resolution approximation of the physical "Territory" (real-time bandwidth, node health, viral spikes).

Attempting to solve the "Knapsack Problem" (optimal data placement) in real-time on-chain is theoretically flawed because:
1.  **Micro-Management Fail:** The chain cannot react fast enough to viral events without thrashing. (This is the job of the **Elasticity Layer**, where users pay for immediate replicas).
2.  **Subjectivity:** "Optimal" placement depends on subjective metrics (Quality of Service, Latency) that cannot be perfectly proven on-chain.
3.  **Data Inertia:** Moving data is heavy. A system that chases a 1% optimization gain by moving Petabytes of data is a failed system.

Therefore, this RFC proposes a **Decentralized Macro-Optimizer**.

### 1.1 The "Janitor" Philosophy
The Placement Committee is not a "Traffic Controller" (making split-second decisions). It is a **Janitor**.
-   **Role:** Periodically sweeps the network to clean up gross inefficiencies.
-   **Goal:** "Kind of Pretty Good." The system targets a stable, 80/20 optimization, not a perfect solution.
-   **Cadence:** Slow. Optimization cycles (Epochs) happen over days/weeks, not blocks.

---

## 2. Core Invariants

1.  **Safety First (Constraints > Objectives):**
    The system is a **Constraint Solver** first, and an **Optimizer** second.
    *   *Hard Constraint:* Redundancy $r_{min}$, Diversity (ASN), Storage Capacity.
    *   *Soft Objective:* Heat Match, Latency Optimization.
    *   *Rule:* Never sacrifice a Constraint to improve an Objective.

2.  **Inertia (Stability > Speed):**
    The Objective Function must penalize **Change**.
    *   $$ Score = Performance + Health - Cost(Migration) $$
    *   If the current placement is "Good Enough" (above a Satisfaction Threshold), the Committee does nothing.

3.  **Epistemic Modesty (History > Promise):**
    Optimization inputs must be derived from **Cryptographic History** (Proof Volume, slashing record), not **Promised Futures** (Self-reported latency claims). We optimize for the weather we *had*, assuming the climate is stable.

---

## 3. The Optimization Cycle (Macro-Scale)

To avoid computational overload, the optimization is **Sharded** and **Rotated**.

### 3.1 Sharded Cycle
The Deal Space is divided into $N$ shards (e.g., 256).
*   **Block $T$:** Optimization Window opens for Shard $S_0$.
*   **Block $T+K$:** Window closes. Best proposal is committed.
*   **Block $T+K+1$:** Optimization Window opens for Shard $S_1$.

This ensures the Committee only solves a small, manageable sub-problem at any time.

### 3.2 The Bounty Hunter Model (Anti-Lazy)
Committees are rational and lazy. Solving NP-Hard problems is expensive.
*   **Default Behavior:** The Committee proposes "No Change" (Empty Diff) or a minimal cleanup.
*   **The Challenger:** Any external actor ("Bounty Hunter") can run a better solver.
*   **The Game:**
    *   Committee proposes Placement $P_c$ with Score $S_c$.
    *   Hunter proposes Placement $P_h$ with Score $S_h$.
    *   If $S_h > S_c + \epsilon$ (where $\epsilon$ is the cost of switch), the Hunter claims the reward, and the Committee is slashed/penalized.

This shifts the model from "Trusted Planning" to **"Competitive Solutions"**.

---

## 4. The Objective Function (Heuristic)

The function should be simple, verifiable, and inertia-heavy.

$$ J_{total} = \sum_{Deals} (J_{health} + J_{perf}) - \sum_{Moves} J_{cost} $$

1.  **$J_{health}$ (Diversity):** 1.0 if replicas are in distinct ASNs, decaying if concentrated.
2.  **$J_{perf}$ (Heat Match):**
    *   If $Heat(D) > Threshold$: Reward presence on "High-Throughput" nodes (defined by past Proof Volume).
    *   If $Heat(D) \approx 0$: Reward presence on "Archive" nodes (defined by low cost).
3.  **$J_{cost}$ (Inertia):** A flat penalty for every `Add(D, P)` operation.
    *   *Effect:* The solver only moves data if the Health/Performance gain > The Cost of bandwidth.

---

## 5. Safe Transitions (Handoff)

We cannot blindly swap providers. We use a **Make-Before-Break** state machine.

1.  **Active:** Current stable state.
2.  **Pending ($P_{new}$):**
    *   Assigned by the Solver.
    *   **Obligation:** Must download data and submit `MsgProveLiveness` (First Proof).
    *   **Reward:** 0 until First Proof.
3.  **Draining ($P_{old}$):**
    *   Marked for removal by the Solver.
    *   **Constraint:** Cannot be removed from `providers(D)` until $P_{new}$ becomes **Active** IF removing them would violate $r_{min}$.
    *   **Reward:** Reduced (or standard) during handoff.

---

## 6. Open Questions & Future Work

1.  **Defining "Good Enough":** How do we set the $\epsilon$ (epsilon) for challenges? If it's too low, we thrash. If too high, we stagnate.
2.  **Sourcing Bandwidth:** Can we use a "Download Bond"? $P_{new}$ posts a bond to cover the download bandwidth, which they earn back via future storage rewards?
3.  **Emergency Mode:** Does this slow cycle handle catastrophic failure (e.g., AWS East goes down)?
    *   *Theory:* No. That is the job of the **Replication Repair** job (a separate, high-priority safety mechanism), not the **Knapsack Optimizer**. The Optimizer focuses on *efficiency*, not *survival*.