# RFC: Decentralized Placement & Knapsack Solver (Archived Draft)

**Status:** Archived (superseded by `rfcs/rfc-decentralized-placement-knapsack.md`)
**Scope:** Off‑chain / committee‑driven placement optimization
**Depends on:** `spec.md` (Mode 1), `spec.md` §7.0 + §7.9, `rfcs/rfc-heat-and-dynamic-placement.md`

---

## 1. Motivation & Problem Statement

NilStore must balance two conflicting requirements:
1.  **Anti-Cherry-Picking:** Storage Providers (SPs) must not choose their own data to prevent "generating" favorable data for attacks or ignoring cold data.
2.  **Performance Optimization:** The network must place "Hot" data on high-performance (Edge/SSD) nodes and "Cold" data on efficient (Archive/HDD) nodes, while respecting geographic diversity and bandwidth constraints.

This requires a **Global Optimization Problem** (a variation of the Multi-Knapsack Problem or Bin Packing Problem) to be solved continuously. Since this computation is too heavy for on-chain consensus, we introduce a **Decentralized Placement Committee** architecture.

This RFC specifies:
- The **Optimization Objective** (what we are solving for).
- The **Committee Protocol** (who solves it and how we agree).
- The **Transition State Machine** (how we safely move data without data loss).

---

## 2. System Model

### 2.1 The Assignment Graph
The system state is a bipartite graph of **Deals** ($D$) and **Providers** ($P$).
-   Edges $(D, P)$ imply $P$ is assigned to store $D$.
-   **Hard Constraints:**
    -   $\forall D: |Providers(D)| \ge r_{min}(D)$ (Minimum Redundancy).
    -   $\forall D: |Providers(D)| \le r_{max}(D)$ (Maximum Redundancy).
    -   $\forall P: \sum Size(D_{i}) \le Capacity(P)$ (Storage Constraint).
-   **Soft Objectives:**
    -   Match $Heat(D)$ to $Bandwidth(P)$.
    -   Maximize $Diversity(D)$ (ASNs, Geolocation).
    -   Minimize $MigrationCost$ (Data movement).

### 2.2 Roles
1.  **Solver Committees:** Off-chain actors (randomly selected Validators or specialized nodes) that compute optimal placements.
2.  **Verifiers:** The L1 Chain (NilChain) checks validity proofs (Constraints).
3.  **Challengers:** Any actor can submit a fraud proof against an invalid proposal.

---

## 3. The Optimization Cycle (Sharded)

Optimizing the entire network (millions of deals) in one block is impossible. We divide the Deal Space into $N$ **Placement Shards** (e.g., 256 buckets based on `Hash(DealID) % 256`).

The cycle proceeds round-robin:
-   **Block $T$:** Open Optimization for Shard $S_0$.
-   **Block $T+K$:** Commit Proposal for $S_0$. Start Shard $S_1$.

### 3.1 Phase 1: Snapshot & Solve
At the start of the epoch for Shard $S_i$:
-   Committee captures state: $Heat(D)$ for $D \in S_i$, $Load(P)$ for all $P$.
-   Run Solver to generate `Diff`:
    -   `Add(D, P)`
    -   `Remove(D, P)`

### 3.2 Phase 2: Proposal (Commit-Reveal)
Solvers submit a compact **Placement Proposal**:
```protobuf
message PlacementProposal {
  uint64 epoch = 1;
  uint64 shard_id = 2;
  bytes diff_merkle_root = 3; // Root of the added/removed edges
  bytes objective_score = 4; // Claimed improvement score
  bytes signature = 5;
}
```
*Note: The full diff data is published to a DA layer (or NilStore itself) and availability is guaranteed by the committee.*

### 3.3 Phase 3: Challenge Game
For a window of $W$ blocks, anyone can challenge:
1.  **Constraint Violation:** Prove that an edge addition violates $Capacity(P)$ or $r_{max}$.
2.  **Availability Failure:** Prove the diff data is not retrievable.
3.  **Score Fraud:** (Optional) Prove the claimed `objective_score` is miscalculated (requires ZK or optimistic execution).

### 3.4 Phase 4: Execution
If no challenges succeed, the `Diff` is applied to the on-chain state.

---

## 4. The Objective Function

The solver maximizes $J_{total} = J_{perf} + J_{health} - J_{cost}$.

### 4.1 Performance Term ($J_{perf}$)
Rewards matching hot data to high-bandwidth nodes.
$$ J_{perf} = \sum_{(D,P)} Heat(D) \times BandwidthScore(P) \times Proximity(User(D), P) $$

### 4.2 Health & Diversity Term ($J_{health}$)
Rewards spreading data across distinct failure domains.
$$ J_{health} = \sum_{D} (DiversityScore(Providers(D)) \times \min(1, \frac{r_{actual}}{r_{target}})) $$

### 4.3 Inertia / Migration Cost ($J_{cost}$)
Penalizes moving data to prevent thrashing.
$$ J_{cost} = \sum_{ops} Size(D) \times TransferCost $$
*This ensures we only move data if the Performance/Health gain outweighs the bandwidth cost of migration.*

---

## 5. Transition State Machine (Safe Migration)

We cannot atomic-swap 1TB of data. Updates happen in a **Pending** state.

### 5.1 The `PendingReplica` State
When `Add(D, P_new)` is committed:
1.  $P_{new}$ is added to $Providers(D)$ with status **Pending**.
2.  $P_{new}$ must retrieve data (from existing peers) and seal it.
3.  $P_{new}$ submits `MsgProveLiveness` (First Proof).
4.  **State Change:** $P_{new}$ status becomes **Active**.

### 5.2 The `Draining` State
When `Remove(D, P_old)` is committed:
1.  If $CurrentReplication(D) > r_{min}$, $P_{old}$ is removed immediately.
2.  If removing $P_{old}$ would drop redundancy below $r_{min}$ (e.g., during a swap):
    -   $P_{old}$ status becomes **Draining**.
    -   $P_{old}$ stays in the set until a corresponding **Pending** node becomes **Active**.
    -   Once safety is restored, $P_{old}$ is evicted.

---

## 6. Security & Incentives

### 6.1 Committee Selection
-   **Random Beacon (DRB):** Committee members are selected deeply randomly from the Validator set.
-   **Stake Weight:** Probability $\propto$ Stake.
-   **Slashing:** Signing an invalid proposal (Constraint Violation) results in slashing.

### 6.2 Sybil Resistance in Metrics
-   **Heat Faking:** Users can fake heat (wash trading) but it costs real $NIL (Bandwidth fees)$.
-   **Capacity Faking:** SPs must seal data (PoUD). Faking capacity is cryptographically hard.

### 6.3 "Lazy" Solver Problem
If the committee proposes "No Change" (Empty Diff) to save compute:
-   **Bounty Hunter:** Anyone can submit a "Better Proposal" (higher $J_{total}$ score).
-   If a challenger submits a valid proposal with $Score > CommitteeScore + \epsilon$, the committee is penalized and the challenger is rewarded.

---

## 7. Interaction with Heat RFC

This RFC consumes the metrics from `rfc-heat-and-dynamic-placement.md`:
-   It reads $H(D)$ (Heat) and $r_{target}(D)$.
-   It *executes* the replication strategy that Heat recommends.
-   While Heat RFC defines "Measurement", this RFC defines "Action".

## 8. Open Questions

1.  **DA for Diff Data:** Where exactly is the large "Diff" payload stored during the challenge window? (Likely a specialized NilStore topic or temporary blob transaction).
2.  **Solver Complexity:** Can we standardize a WASM-based solver so valid scores can be proven on-chain (or via ZK)?
3.  **Emergency Override:** How does the system handle "Panic Mode" (e.g., massive region failure) bypassing the slow epoch cycle?
