# NilStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper Draft v0.5)**

**Date:** 2025-09-15
**Status:** Working Draft (privacy‑mode default: ciphertext)
**Authors:** NilStore Core Team

## Abstract

NilStore is a decentralized storage network designed to provide high-throughput, verifiable data storage with significantly reduced operational overhead. It leverages a novel consensus mechanism based on Proof-of-Useful-Data (PoUD) and Proof-of-Delayed-Encode (PoDE), utilizing a canonical byte representation (plaintext or ciphertext) verified via KZG commitments and timed derivations. By employing a topological data placement strategy (Nil-Lattice), NilStore drastically lowers the hardware barrier to entry, enabling participation from edge devices to data centers. This paper details the system architecture, the NilFS data abstraction layer, the Nil-Mesh routing protocol, the $STOR-Only economic model, and the hybrid L1/L2 settlement architecture designed for EVM compatibility and robust governance.

## 1. Introduction

### 1.1 Motivation

While existing decentralized storage protocols have demonstrated the viability of incentive-driven storage, they often rely on computationally intensive Proof-of-Replication (PoRep) stacks requiring significant GPU investment. This centralizes the network around large-scale operators and increases the total cost per byte.

NilStore retains strong cryptographic guarantees while reducing the "sealing" process to minutes on standard CPUs. This democratization of access increases network resilience through geographic distribution and enables a more efficient storage marketplace.

### 1.2 Key Innovations

*   **Canonical byte‑accurate possession:** Storage providers (SPs) keep a canonical byte representation of assigned Data Units (DUs) on disk—either ciphertext or plaintext as selected per deal policy—and prove possession regularly with near‑certain full‑coverage over time.
    Deal parameter: `privacy_mode ∈ {"ciphertext" (default), "plaintext"}`. All commitments (`C_root`) and PoDE derivations operate strictly over the chosen canonical bytes.
*   **PoUD + PoDE:** **PoUD** (KZG‑based Provable Data Possession over DU canonical bytes) + **PoDE** (timed window derivations) are the **normative** per‑epoch proofs.
*   **Nil-Mesh Routing:** Heisenberg-lifted K-shortest paths for optimized latency and Sybil resistance.
*   **$STOR-Only Economy:** A unified economic model using $STOR for capacity commitment, bandwidth settlement, and governance.
*   **Hybrid Settlement:** A specialized L1 for efficient proof verification bridged via ZK-Rollup to an EVM L2 for liquidity and composability.

## 2. System Architecture
Manifest & crypto policy follow Core Appendix A (Root CID, DU CID, HPKE FMK wraps, HKDF‑derived CEKs, AES‑GCM per DU).


NilStore employs a hybrid architecture that decouples Data Availability (DA) consensus from economic settlement, optimizing for both cryptographic efficiency and ecosystem composability.

### 2.1 Architectural Layers

1.  **Data Layer (NilFS):** Handles object ingestion, erasure coding, and placement.
2.  **Network Layer (Nil-Mesh):** Manages peer discovery, routing, and QoS measurement.
3.  **Consensus Layer (DA Chain - L1):** Verifies **PoUD (KZG multi‑open) + PoDE timing attestations**, manages stake, and mints rewards.
4.  **Settlement Layer (L2 Rollup):** Handles economic transactions, liquidity, and governance.

### 2.2 The DA Chain (L1)

The Data Availability Chain is a minimal L1 (built using Cosmos-SDK/Tendermint BFT) optimized for NilStore's cryptographic operations.

*   **Function:** Verifying **KZG openings (multi‑open)** for PoUD and enforcing PoDE timing bounds via watcher digests, managing $STOR staking, and executing slashing logic. It does not run a general‑purpose VM.
*   **Required pre‑compiles (normative):** (a) **BLAKE2s‑256**, (b) **Poseidon** (for Merkle paths), (c) **KZG** (G1/G2 ops; multi‑open), and (d) **VDF Verification**. Chains lacking these MUST expose equivalent syscalls in the DA module.
*   **Rationale:** The intensive cryptographic operations required for daily proof verification are best handled natively.

### 2.3 The Settlement Layer (L2)

Settlement occurs on a ZK-Rollup (using PlonK/Kimchi) bridged to a major EVM ecosystem (e.g., Ethereum L2).

*   **Function (One‑Token Profile):** Manages **$STOR only**, mints Deal NFTs, hosts the NilDAO, and executes **$STOR‑denominated** settlement for storage and bandwidth. **Non‑$STOR assets are out‑of‑scope** for protocol contracts; any conversions happen off‑protocol.

### 2.4 The ZK-Bridge

The L1 aggregates epoch verification results into a single proof/digest and posts it to the L2 bridge contract. **Normative circuit boundary**:
1) **Public inputs**: `{epoch_id, DA_state_root, poud_root, bw_root, validator_set_hash}`.
2) **Verification key**: `vk_hash = sha256(vk_bytes)` pinned in the L2 bridge at deployment; upgrades require DAO action and timelock. In addition, an Emergency Circuit MAY perform an expedited **VK‑only** upgrade with a shorter timelock under §9.2, restricted to a pre‑published whitelist (hash‑pinned on L1). **No other code paths or parameters may change under Emergency mode.** During “yellow‑flag”, the bridge **MUST**:
  • continue updating `{epoch_id, poud_root, bw_root}`;
  • **disable** all fund‑moving paths: vesting payouts, token transfers/mints/burns, withdrawals/deposits, deal‑escrow releases, slashing executions, new deal creation (`CreateDeal`), and deal uptake (`MinerUptake`);
  • freeze parameter change entrypoints and all governance actions (proposal submission and voting), **EXCEPT** for the DAO vote required to ratify the emergency patch (§9.2);
  • halt the economic processing (reward minting and slashing execution) derived from `poud_root` and `bw_root` updates;
  • require an independent auditor attestation **and** a hash of the patched verifier bytecode;  
and auto‑revert to normal after sunset unless ratified by DAO.
3) **State mapping**: On accept, the bridge **atomically** updates `{poud_root, bw_root, epoch_id}`; monotonic `epoch_id` prevents replay.
4) **Failure domains**: any mismatch in roots or non‑monotonic epoch initiates a **Grace Period** (DAO-tunable, default 24h). If the mismatch persists after the Grace Period, the bridge halts (hard reject). No trusted relayers or multisigs are required because validity is enforced by the proof and pinned `vk_hash`.
5) **Proof Generation (Normative):** The ZK proof MUST be generated by a decentralized prover network or a rotating committee selected from the L1 validator set, with slashing penalties for failure to submit valid proofs within the epoch window.

### 2.5 Cryptographic Core Dependency

All layers rely on the primitives defined in the **NilStore Cryptographic Core Specification (`spec.md`)**, which establishes the security guarantees for data integrity and proof soundness.

## 3. Data Layer (NilFS)

NilFS abstracts data management complexity, automating the preparation, distribution, and maintenance of data, ensuring neither users nor Storage Providers (SPs) manage exact file representations or replication strategies manually.

### 3.1 Object Ingestion and Data Units (DUs)

1.  **Content-Defined Chunking (CDC):** Ingested objects are automatically split using CDC (e.g., Rabin fingerprinting) to maximize deduplication. Chunks are organized into a Merkle DAG (CIDv1 compatible).
2.  **Data Unit Packing:** Chunks are serialized and packed into standardized **Data Units (DUs)**. DU sizes are powers‑of‑two (1 MiB to 8 GiB). SPs interact only with DUs.

#### 3.1.1 Upload Walkthrough (Informative)

This walkthrough illustrates what happens when a client uploads an object **F** to NilStore:

1) **Chunk & DAG (CDC).** The client runs content‑defined chunking (e.g., Rabin) over **F**, producing a Merkle‑DAG (CIDv1‑compatible).
2) **Pack into DUs.** Chunks are serialized into one or more **Data Units (DUs)** (power‑of‑two size between 1 MiB and 8 GiB). Each DU is self‑contained.
3) **Commit & deal intent.** The client computes a DU commitment (`C_root`) and prepares `CreateDeal` parameters (price, term, redundancy, QoS).
4) **Erasure coding.** Each DU is encoded with Reed–Solomon **RS(n,k)** (default **(12,9)**), yielding **n** shards (k data + n−k parity).
5) **Deterministic placement.** For every shard `j`, compute a Nil‑Lattice **ring‑cell** target via
   `pos := Hash(CID_DU ∥ ClientSalt_32B ∥ j) → (r,θ)` and enforce placement constraints (one shard per SP per cell; cross‑cell distance threshold).
6) **Deal creation (L2).** The client calls **`CreateDeal`** on L2, posting `C_root`, locking $STOR escrow, and minting a **Deal NFT**.
7) **Miner uptake (L2+L1).** Selected SPs bond $STOR, fetch their assigned shards, and store the **plaintext DU bytes** locally. The client‑posted **DU KZG commitment (`C_root`)** binds content for all future proofs.
8) **Epoch service.** During each epoch, SPs (a) serve retrievals; clients sign **Ed25519 receipts**; SPs aggregate receipts into a Poseidon Merkle (`BW_root`), and (b) post **PoUD + PoDE** storage proofs against the original `C_root`.
9) **Settlement & rewards.** L1 verifies KZG openings and enforces PoDE timing and posts a compressed digest to L2 (**ZK‑Bridge**). L2 updates `{poud_root, bw_root, epoch_id}` and releases vested fees per distribution rules.
10) **Repair (as needed).** If shard availability drops below threshold, the network triggers **Autonomous Repair**—repaired shards must open against the original DU commitment (no drift).

**Message flow (illustrative):**
```
Client  →  SDK:  CDC+DAG → DU pack → RS(n,k) → placement map
Client  →  L2:  CreateDeal(C_root, terms) → Deal NFT
SP      ←  L2:  MinerUptake(collateral)   ← selected SPs
SP      ↔  L1:  Epoch PoUD+PoDE(C_root)
Clients ↔  SP:  Retrieval ↔ Receipts(Ed25519) → SP aggregates
L1      →  L2:  ZK-Bridge(recursive SNARK) → state update & vesting
```

### 3.2 Erasure Coding and Placement

**Normative (Redundancy & Sharding).** Each DU is encoded with **systematic Reed–Solomon over GF(2^8)** using **symbol_size = 128 KiB**. A DU is striped into **k** equal data stripes; **n−k** parity stripes are computed; stripes are concatenated per‑shard to form **n shards** of near‑equal size. The default profile is **RS(n=12, k=9)** (≈ **1.33×** overhead), tolerating **f = n−k = 3** arbitrary shard losses **without** data loss.
**Normative (Placement constraints).** At most **one shard per SP per ring‑cell**; shards of the same DU MUST be placed across distinct ring‑cells with a minimum topological separation (governance‑tunable).
**Normative (Repair triggers).** A **RepairNeeded** event is raised when `healthy_shards ≤ k+1`. Repairs MUST produce openings **against the original DU commitment**; re‑committing a DU is invalid.
**Deal metadata MUST include:**
`{profile_type, RS_n?, RS_k?, rows?, cols?, symbol_size, ClientSalt_32B, lattice_params, placement_constraints, repair_threshold, epoch_written, meta_root?, meta_scheme?}`.

Notes:
- `profile_type ∈ {"RS-Standard","RS-2D-Hex","dial"}`.
- `epoch_written` records the epoch the DU was first committed and is REQUIRED for routing (§7.4).
- `meta_root` (Poseidon) and `meta_scheme` are REQUIRED when the resolved profile uses encoded metadata (all RS‑2D‑Hex profiles; optional for RS).
- Fields marked `?` are present if required by the resolved profile and/or metadata scheme (see §3.2.y–§3.2.z).
**Normative (Anti-Grinding):** `ClientSalt_32B` MUST be derived deterministically from the client's signature over the Deal parameters (e.g., `Blake2s-256("NILSTORE-SALT-V1" || Sig_Client)`) to prevent placement grinding.

*   **Deterministic Placement (Nil-Lattice):** Shards are placed on a directed hex-ring lattice to maximize topological distance. The coordinate (r, θ) is determined by:
    `pos := Hash(CID_DU ∥ ClientSalt_32B ∥ SlotIndex) → (r, θ)`
The `ClientSalt` ensures cross-deal uniqueness.

### 3.2.y RS‑2D‑Hex Profile (Optional)

#### 3.2.y.0 Objective
The RS‑2D‑Hex profile couples two‑dimensional erasure coding with NilStore’s hex‑lattice.
It maps row redundancy → radial rings and column redundancy → angular slices, enabling O(|DU|/n) repair bandwidth under churn.

#### 3.2.y.1 Encoding
- Partition the DU into an [r × c] symbol matrix (baseline r = f+1, c = 2f+1).
- Column‑wise RS(n,r) → primary slivers; row‑wise RS(n,c) → secondary slivers.
- Each SP is assigned a (primary_i, secondary_i) sliver pair.

#### 3.2.y.2 Commitments & Metadata
- Each sliver MUST be bound by a KZG commitment; the DU MUST expose a blob commitment `C_root`.
- Deal metadata MUST carry `{rows, cols, symbol_size, commitment_root, placement_constraints}`.

#### 3.2.y.3 Lattice Placement (Normative)
- Row→rings: All slivers in a given row MUST lie on distinct radial rings.
- Col→slices: All slivers in a given column MUST lie on distinct angular slices.
- Cross‑cell: An SP MUST NOT hold >1 sliver in the same (r,θ) cell.

#### 3.2.y.4 Read & Repair
- Read: Collect ≥ 2f+1 secondary slivers across rings, reconstruct DU, re‑encode, verify `C_root`.
- Repair:
  - Secondary sliver repair: query f+1 neighbors on the same ring.
  - Primary sliver repair: query 2f+1 neighbors on the same slice.
- All repairs MUST open against the original DU commitment (§3.3).

#### 3.2.y.5 Integration with Consensus
RS‑2D‑Hex affects only NilFS shard layout; the PoUD+PoDE mechanism remains file‑agnostic and unmodified (§6).

#### 3.2.y.6 Governance
- Default RS(12,9) remains mandatory.
- RS‑2D‑Hex MAY be enabled per pool/class; SPs MUST advertise support at deal negotiation.

### 3.2.z Durability Dial Abstraction

#### 3.2.z.0 Objective
Expose a user‑visible durability_target ∈ [0.90, 0.999999999] that deterministically resolves to a governance‑approved redundancy profile (RS‑Standard or RS‑2D‑Hex).

#### 3.2.z.1 Mapping & Metadata
- Client sets `profile_type="dial"` and `durability_target`.
- The resolver MUST produce `resolved_profile := {RS_n, RS_k} | {rows, cols}` and placement constraints.
- Deal metadata MUST record `{profile_type="dial", durability_target, resolved_profile}`.

#### 3.2.z.2 Late‑Joiner Bootstrap (Completeness)
Any SP missing its assigned sliver after dispersal MUST be able to reconstruct it without the writer online, using row/column intersections per the resolved profile. This guarantees eventual completeness.

#### 3.2.z.3 Encoded Metadata (Scalability)
For RS‑2D‑Hex, sliver‑commitment metadata MUST be encoded linearly (e.g., 1D RS over the metadata vector). SPs store only their share; gateways/clients reconstruct on demand.

#### 3.2.z.3.1 Encoded Metadata Object (Normative)

meta_scheme: `RS1D(n_meta, k_meta)` with default `k_meta = f+2` and `n_meta = n`.
Each Storage Provider stores one `MetaShard`:

`MetaShard := { du_id, shard_index, payload, sig_SP }`

- `payload` encodes that SP’s share of the sliver‑commitment vector (and per‑sliver KZG commitments as needed).
- `sig_SP` binds the shard to `du_id` and `shard_index`.
- All `MetaShard.payload` chunks are Poseidon‑Merkleized to form `meta_root` recorded in Deal metadata (§3.2).

Verification (clients/gateways):
1) Fetch ≥ `k_meta` `MetaShard`s with Merkle proofs to `meta_root`.
2) Reconstruct the commitment vector.
3) Verify sliver openings against the DU commitment during reads/repairs.

Implementations MAY cache reconstructed metadata; caches MUST be invalidated on DU invalidation events (§3.2.z.4).

#### 3.2.z.4 Writer Inconsistency Proofs (Fraud)

If an SP detects inconsistency between a received sliver and `C_root`, it MUST produce an `InconsistencyProof`:

**Normative (Authenticated Transfer):** During initial data dispersal, the writer MUST sign each sliver sent to the SPs. The signature MUST cover the sliver content, the `du_id`, and the `sliver_index`. The `InconsistencyProof` MUST include this signature (`Sig_Writer`).

`InconsistencyProof := { du_id, sliver_index, symbols[], openings[], meta_inclusion[], witness_meta_root, witness_C_root }`

- `symbols[]` and `openings[]` provide the minimum symbol‑level data needed to re‑encode and check commitment equality.
- `meta_inclusion[]` are Merkle proofs to `meta_root` for the relevant sliver commitments.
- `witness_meta_root` and `witness_C_root` bind to on‑chain Deal metadata and DU commit.

On‑chain action (DoS‑safe): Any party MAY call `MarkInconsistent(C_root, evidence_root)` on L1 with a refundable **bond** ≥ `B_min` (DAO‑tunable). The contract verifies at most `K_max` symbols/openings per call (cost‑capped). If ≥ f+1 proofs from distinct SPs verify, the DU is marked invalid, excluded from PoUD/PoDE/BW accounting, the writer’s escrowed $STOR is slashed per §7.3, and the bond is refunded; otherwise the bond is burned. Repeat submissions for the same `C_root` within a cool‑off window are rejected.

#### 3.2.z.5 Lattice Coupling
Resolved profiles MUST respect §3.2.y placement rules for 2D cases, and the standard ring‑cell separation for RS.

#### 3.2.z.6 Governance
NilDAO maintains the mapping table (durability target → profile), caps allowed ranges, and sets cost multipliers per profile.

### 3.3 Autonomous Repair Protocol

The network autonomously maintains durability through a bounty system.

1.  **Detection:** If DU availability drops below the resilience threshold (e.g., k+1), a `RepairNeeded` event is triggered.
2.  **Commitment (Commit-Reveal Phase 1):** Repair nodes reconstruct the missing shards. They compute `Commitment = Hash(RepairSolution ∥ Nonce)` and submit this commitment on-chain with a refundable bond during the commitment window (`Δ_commit`).
3.  **Reveal (Commit-Reveal Phase 2):** Nodes submit the `RepairSolution` and `Nonce` during the reveal window (`Δ_reveal`). The solution MUST include openings against the original DU KZG commitment (no new commitment accepted) and a Merkle proof to the DU’s original `C_root`.
4.  **Verification and Bounty:** The L1 chain verifies the solution. The Resilience Bounty (default: 5% of the remaining escrowed fee) is awarded to the earliest valid commitment. Bonds for valid solutions are refunded; others are burned.

**Normative (Anti‑withholding):** When a repair for shard `j` is accepted, the SP originally assigned `j` incurs an immediate penalty on their bonded $STOR strictly greater than the repair bounty (Default: Penalty = 1.5 × Bounty), in addition to an automatic demerit. Repeated events within a sliding window escalate to further slashing unless the SP supplies signed RTT‑oracle transcripts proving inclusion in a whitelisted incident.
**Normative (Anti‑withholding Slashing):** The penalty for failing to maintain a shard (triggering a repair) MUST be a significant fraction of the SP's bonded collateral for that specific DU (Default: 25% of the DU collateral), independent of the PoUD/PoDE slashing schedule.
**Normative (Collocation Filter):** An identity is disqualified from claiming bounty on any shard it was previously assigned for `Δ_repair_cooldown` epochs (DAO‑tunable). Furthermore, any identity within the same /24 IPv4 (or /48 IPv6) OR the same ASN **for the same window** is likewise disqualified. Cooldown MUST be ≥ 2× mean repair time.
    **Normative (RTT Profile Similarity):** The Collocation Filter MUST incorporate RTT profile data from the QoS Oracle (§4.2). If the RTT profiles of two SPs exhibit statistically significant similarity (defined by a governance-tunable correlation threshold) across diverse vantage points, they MUST be treated as collocated, regardless of their IP/ASN.
    **Normative (Dynamic Bounty):** The bounty MUST be dynamically adjusted based on the urgency of the repair, the cost of reconstruction, and network conditions (DAO‑tunable parameters).

## 4. Network Layer (Nil-Mesh)

Nil-Mesh is the network overlay optimized for low-latency, topologically aware routing.

### 4.1 Heisenberg-Lifted Routing

Nil-Mesh utilizes the geometric properties of the Nil-Lattice for efficient pathfinding.

*   **Secure Identity Binding (Normative):** Peer IDs (NodeIDs) are securely bound to lattice coordinates (r, θ) through a costly registration process. To register or move a coordinate, an SP MUST:
    (1) Bond a minimum amount of $STOR (Stake_Min_Cell), specific to the target Ring Cell.
    (2) Compute a Verifiable Delay Function (VDF) proof anchored to their NodeID and the target coordinate: `Proof_Bind = VDF(NodeID, r, θ, difficulty)`.
    This prevents rapid movement across the lattice and ensures that capturing a Ring Cell requires significant capital ($STOR) and time (VDF computation).
*   **Mechanism:** Peer IDs are mapped ("lifted") to elements in a 2-step nilpotent Lie group (Heisenberg-like structure) corresponding to their lattice coordinates.
*   **Pathfinding:** K-shortest paths (K=3) are computed in this covering space and projected back to the physical network. This offers superior latency performance compared to standard DHTs and increases Sybil resistance by requiring attackers to control entire topological regions ("Ring Cells").
**Normative (Capture cost):** DAO MUST publish and periodically update the `Stake_Min_Cell` and VDF `difficulty` parameters. These parameters MUST be raised automatically if empirical concentration increases.

### 4.2 RTT Attestation and QoS Oracle

Verifiable Quality of Service (QoS) is crucial for performance and security.

*   **Attestation:** Nodes continuously monitor and sign Round-Trip Time (RTT) attestations with peers.
*   **On‑Chain Oracle:** A **stake‑weighted attester set** posts RTT digests (Poseidon Merkle roots) to the DA chain. **Normative**:
    1) **Challenge‑response**: clients issue random tokens; SPs must echo tokens within `T_max`; vantage nodes verify end‑to‑end.
    2) **VDF Enforcement (Mandatory Baseline + Conditional Escalation):** Every attestation MUST include a short-delay VDF proof (Baseline VDF).
       **Normative (VDF Anchoring):** The VDF input MUST include the random challenge token issued by the client/attester. The VDF MUST be computed after receiving the challenge and before transmitting the response, proving the delay occurred within the RTT measurement window and preventing pre-computation.
       If the anomaly rate exceeds `ε_sys` for ≥ 3 consecutive epochs, the VDF delay is increased (Conditional Escalation) until the anomaly rate drops for 2 consecutive clean epochs. Total VDF cost per probe is capped by the **Verification Load Cap** (§ 6.1). Protocol MUST publish the current VDF parameters (delay, modulus) on‑chain per epoch.
    3) **Diversity & rotation**: The attester set MUST achieve a minimum diversity score (e.g., Shannon index over ASN/Region distribution) defined by governance (default: score equivalent to uniform distribution over ≥ 5 regions and ≥ 8 ASNs). Assignments are epoch‑randomized and **committed on‑chain** (rotation proof) before measurements begin.
    4) **Slashing**: equivocation or forged attestations are slashable with on‑chain fraud proofs (submit raw transcripts).
    5) **Sybil control**: weight attesters using **quadratic weighting** of bonded $STOR (weight ∝ √STOR) to reduce the influence of large stakeholders. Apply decay weights for co‑located /24s and ASNs.
    **Normative (Influence Cap):** The total weight of any single entity or correlated group (defined by ASN/Region cluster or RTT Profile Similarity (§3.3)) MUST NOT exceed 20% of the total attester weight (DAO-tunable cap).
*   **Usage:**
    1.  **Path Selection:** Clients use the Oracle to select the fastest 'k' providers.
    2.  **Fraud Prevention:** The Oracle verifies that bandwidth receipts are genuine (verifying RTT > network floor), preventing Sybil self-dealing.

## 5. Economic Model ($STOR‑Only)

NilStore employs a unified token economy ($STOR) to align long-term security incentives with network utility.

### 5.1 $STOR (Staking and Capacity Token)

*   **Supply:** Fixed (1 Billion).
*   **Functions:** Staking collateral for SPs and Validators; medium of exchange for storage capacity; governance voting power.
*   **Sink:** Slashing events.
*   **Float Health Monitors (normative):** Publish a **Circulating Float Ratio (CFR)** = (total supply – staked collateral – escrow – DAO/Treasury/vesting – unspent grants)/total supply. Define **yellow/red bands** (default 30% / 25%). Crossing yellow permits a temporary β taper (increase Treasury share) and widening of downward δ within published bands; crossing red triggers the Economic Circuit Breaker (§ 6.6.3). These measures MUST NOT reduce Core security floors (`p_kzg`, `R`, `B_min`) nor suppress PoUD/PoDE verification.


### 5.2 Fee Market for Bandwidth ($STOR‑1559)

**One‑token profile (normative):** The protocol uses **$STOR only** for bandwidth settlement. **No activity‑based inflation** is permitted. Each region r and epoch t defines **BaseFee_r,t** (in $STOR per MiB), adjusted EIP‑1559‑style toward a byte‑throughput target U*. For a payable origin→edge transfer of b bytes:

  Burn       = β · BaseFee[r,t] × b                 // burn share in $STOR
  Treasury   = (1−β) · BaseFee[r,t] × b             // route to Security Treasury
  Payout     = PremiumPerByte × b                   // pay provider in $STOR

**Burn‑Share Governor (normative).** β ∈ [β_min, β_max] is DAO‑governed (default β=0.95; bounds [0.90, 1.00]). During a declared Security Escalation (§ 6.6.3), β MAY be temporarily lowered but MUST satisfy β ≥ β_emergency_min (default 0.85) and MUST auto‑revert after de‑escalation. Changes to β and its bounds are time‑locked (≥ 24 h).

**Update rule (bounded):**
BaseFee_{t+1} = BaseFee_t · (1 + δ · (U_t − U*) / U*)
with |δ·(U_t−U*)/U*| ≤ Δ_max (DAO‑tunable, default ±12.5%). BaseFee is per‑region; no price oracles are used.
**Operating Bands (normative).** For each region‑class, the DAO MUST publish on‑chain `{U* band, δ band}` and a minimum 72 h timelock for any changes. The controller MUST clamp intra‑epoch adjustments to the published band; out‑of‑band moves require a DAO vote.

**Protocol currency invariant:** Settlement and escrow contracts **MUST accept $STOR only**; deposits in other assets MUST be rejected. Any off‑protocol conversions are invisible to the contracts.

### 5.3 Off‑Protocol Payer Adapters (No In‑Protocol Stables)

The protocol’s settlement layer accepts **$STOR only** and exposes no stablecoin paths or price oracles. Wallets, edges, and merchant gateways MAY implement **off‑protocol adapters** that:
  (a) quote human‑readable prices off‑chain,
  (b) acquire $STOR via external venues, and
  (c) fund payer **$STOR escrow** before retrieval.

Adapters are **not** part of consensus; their failures cannot affect protocol accounting. Grants (§ 7.y, Core “GRANT‑TOKEN‑V1”) remain the recommended mechanism to control spend.
## 6. Consensus and Verification (Storage + Bandwidth)

The economic model is enforced cryptographically through the PoUD+PoDE consensus mechanism on the L1 DA Chain.

### 6.0a  Proof Mode — **Canonical bytes via privacy_mode**

Core supports **one** normative proof path evaluated over the deal’s canonical bytes (as selected by `privacy_mode ∈ {ciphertext (default), plaintext}`) — **PoUD** (KZG multi‑open on canonical bytes) + **PoDE** (timed derivations).

### 6.0b  PoUD (Proof of Useful Data) – Plaintext Mode (normative)

For each epoch and each assigned DU sliver interval:

1) Content correctness: The SP MUST provide one or more **KZG multi‑open** proofs at verifier‑chosen 128 KiB symbol indices proving membership in the DU commitment `C_root` recorded at deal creation. When multiple indices are scheduled for the same DU in the epoch, SPs SHOULD batch using multi‑open to minimize calldata.

2) Timed derivation (PoDE): Let `W = 8 MiB` (governance‑tunable). The SP MUST compute
```
Derive(canon_bytes[interval], beacon_salt, row_id, epoch_id, du_id) -> (leaf64, Δ_W)
  tag  = "PODE_DERIVE_ARGON_V1"
  salt = Blake2s-256(tag ‖ beacon_salt ‖ u32_le(row_id) ‖ u64_le(epoch_id) ‖ u128_le(du_id))
  input_digest = Blake2s-256("PODE_INPUT_DIGEST_V1" ‖ canon_bytes[interval])
  leaf64 = Argon2id(input_digest, salt; t_cost=H_t, m_cost=H_m, parallelism=1, out_len=64)
  Δ_W    = Blake2s-256(canon_bytes[interval])
```
Parameters `H_t, H_m` come from the dial profile; **`H_p` MUST be exactly 1 (sequential‑only)** and profiles with `H_p ≠ 1` MUST be rejected. The proof includes `H(leaf64, Δ_W)` and the minimal canonical bytes needed for recomputation.

3) Concurrency & volume: The prover MUST satisfy at least `R` parallel PoDE sub‑challenges per proof window, each targeting a distinct DU interval (default `R ≥ 16`; DAO‑tunable). The aggregate verified bytes per window MUST be ≥ `B_min` (default `B_min ≥ 128 MiB`, DAO‑tunable). B_min counts only bytes that are both (a) KZG‑opened and (b) successfully derived under PoDE. The prover MUST include a KZG opening `π_kzg` binding the supplied `canon_bytes[interval]` to the original `C_root`.

### 6.0c  PDP‑PLUS Coverage SLO (normative)
Define CoverageTargetDays (default 365). The governance scheduler MUST choose per‑epoch index sets (challenge rate $q/M$) so that for every active DU:
  • the expected fraction of uncovered bytes $(1-q/M)^T$ after $T$=CoverageTargetDays is ≤ $2^{-18}$ (implying $q/M \approx 3.4\%$ if $T=365$); and
  • the scheduler is commit‑then‑sample: indices for epoch t are pseudorandomly derived from the epoch beacon and a DU‑local salt and are not known to SPs before the BW_commit deadline of epoch t−1.
Chains MUST publish (and auditors MUST reproduce) the per‑epoch index‑set transcript. Failure to meet the SLO MUST trigger an automatic increase of B_min (×1.25 per epoch, capped by the Verification Load Cap) until the SLO is restored.

4) Deadline: The derivations MUST complete before `Δ_submit` (§ 7.3). RTT‑Oracle transcripts (§ 4.2) are included when a remote verifier is used.

On‑chain: L1 verifies KZG openings (precompile § 2.2) and checks `B_min` & `R` counters. Watchers enforce timing via RTT‑Oracle and publish pass/fail digests; repeated failures escalate slashing per § 6.3.3.

### 6.1 Retrieval Receipts

To account for bandwidth, clients sign receipts upon successful retrieval.

*   **Receipt Schema (Normative):**
    `Receipt := { CID_DU, Bytes, EpochID, ChallengeNonce, ExpiresAt, Tip_BW, Miner_ID, payer_id, Client_Pubkey, Sig_Ed25519 [, GatewaySig?, grant_id?] }`
    **Eligibility (normative).** Receipts lacking `payer_id` are ineligible. If `grant_id` is present, it MUST verify against the payer’s `"GRANT‑TOKEN‑V1"` Merkle root. Settlement MUST compute `Burn = β·BaseFee[region, epoch] × Bytes` **before** `Payout`, and MUST route `(1−β)` of `BaseFee × Bytes` to the Security Treasury.
    - `ChallengeNonce` is issued per‑session by the SP/gateway and bound to the DU slice; `ExpiresAt` prevents replay.
    - `EpochID` binds the receipt to the specific accounting period and MUST match the current epoch during submission.
    - **Verification model:** Ed25519 signatures are verified **off‑chain by watchers and/or on the DA chain**; the protocol commits to a **Poseidon Merkle root** of receipts and proves byte‑sum consistency. In‑circuit Ed25519 verification is **not required**.
      **Commit requirement:** For epoch `t`, SPs MUST have posted `BW_commit := Blake2s‑256(BW_root)` by the last block of epoch `t−1` (see § 6.3.1). Receipts not covered by `BW_commit` are ineligible.
      **Penalty:** Failure to post `BW_commit` for epoch `t` sets counted bytes to zero for `t` and forfeits all bandwidth payouts for `t`.
      **Normative anchor:** At least **5% of receipts by byte‑volume per epoch** MUST be verified (randomly sampled via § 6.3) and escalate automatically under anomaly (§ 6.3.4). Sampling MUST be volume-weighted.
      **Normative (Verification Load Cap):** The total on‑chain verification load MUST be capped (DAO‑tunable) to prevent DoS via forced escalation.
      **Normative (VLC Prioritization and Security Floors):** Governance MUST define Security Floors for critical parameters ($p_{kzg\_floor}$, $R_{floor}$, $B_{min\_floor}$). The system MUST NOT automatically reduce these parameters below their floors.
      **Normative (Economic Circuit Breaker):** If the Verification Load Cap (VLC) is reached during a security escalation (e.g., increase in $p$), and parameters are already at their floors, the system MUST activate an Economic Circuit Breaker instead of suppressing the escalation:
      1. **Prioritize High-Risk Receipts:** The sampling mechanism MUST prioritize receipts associated with SPs exhibiting high abuse scores (See §6.3.1).
      2. **Source Verification Costs:** The excess verification load costs MUST first be sourced from the dedicated Security Treasury (DAO-managed).
      3. **Emergency Burn‑Share Override + Surcharge (normative):** If the Treasury is insufficient, the protocol MUST temporarily lower `β` (routing a larger share of `BaseFee` to the Security Treasury) within `[β_emergency_min, β]` and MAY apply a bounded security surcharge `σ_sec` to `BaseFee` whose revenues are routed 100% to the Security Treasury. Bandwidth payouts (PremiumPerByte) MUST NOT be throttled. Both switches MUST auto‑revert after de‑escalation or after 14 days (whichever is sooner) and are subject to the standard timelock unless a yellow‑flag freeze is active.
      This ensures that security auditing proceeds unimpeded during an attack, while imposing an economic cost on the network instead of compromising storage integrity.

### 6.2 Storage Proof Binding (PoUD + PoDE)

For each SP and each assigned DU interval per epoch the DA chain enforces:

1. **PoUD (KZG‑PDP on canonical bytes):** The SP submits one or more **KZG openings** at verifier‑chosen **128 KiB symbol indices** proving membership in the **original** DU commitment `C_root` recorded at deal creation. Multi‑open is RECOMMENDED; indices are derived from the epoch beacon.
2. **PoDE (timed derivation):** For each challenged **W = 8 MiB** window, compute a salted local transform `Derive(canon_window, beacon_salt, row_id)` **within the proof window** and submit `H(deriv)` with the minimal canonical bytes to recompute. **`R ≥ 16`** sub‑challenges/window and **Σ verified bytes ≥ B_min = 128 MiB** per epoch (defaults; DAO‑tunable).
   **Normative (PoDE Linkage):** The prover MUST include a KZG opening proof `π_kzg` demonstrating that the `canon_window` input bytes correspond exactly to the data committed in `C_root` (See Core Spec §4.3).
3. **Deadlines:** Proofs must arrive within `Δ_submit` after epoch end. Timing may be attested by RTT‑oracle transcripts for remote verification.

**On‑chain checks:** L1 verifies all KZG openings (including `π_kzg` for the PoDE linkage) via pre‑compiles and enforces `R` and `B_min`; watchers produce timing digests for PoDE. The rollup compresses per‑SP results into `poud_root` for the bridge.

### 6.3 Probabilistic Retrieval Sampling (QoS Auditing)

#### 6.3.0 Objective
Strengthen retrieval QoS without suspending reads by sampling and verifying a governance‑tunable fraction of receipts each epoch.

#### 6.3.1 Sampling Set Derivation
0) **Commit‑then‑sample (Normative):** Each SP MUST post `BW_commit := Blake2s‑256(BW_root)` no later than the last block of epoch `t−1`.

1) **Abuse Score Calculation (Normative):** At epoch boundary `t`, calculate an Abuse Score `A_score(SP)` for each provider. This score MUST incorporate factors including:
    * Historical receipt verification failures.
    * Anomalies detected by the RTT QoS Oracle (e.g., RTT near the network floor).
    * Sudden spikes in receipt volume.
    * RTT Profile Similarity (§3.3) with other high-scoring SPs.

1) At epoch boundary `t`, derive `seed_t := Blake2s-256("NilStore-Sample" ‖ beacon_t ‖ epoch_id)`, where `beacon_t` is the Nil‑VRF epoch beacon.
2) **Risk-Based Sampling (Normative):** Expand `seed_t` into a PRF stream. Select receipts **from the set committed by `BW_commit`**. The global sampling fraction `p` remains governance-tunable (`0.5% ≤ p ≤ 10%`, default ≥ 5%). However, the per-SP sampling rate `p_sp` MUST be dynamically adjusted based on `A_score(SP)`. High-risk SPs MUST have a significantly higher sampling rate. Receipts not committed in `t−1` MUST NOT be counted for `t`.
3) The sample MUST be unpredictable to SPs prior to epoch end and sized so that expected coverage ≥ 1 receipt per active SP. Auditor assignment SHOULD be stake‑weighted and region/ASN‑diverse (per §4.2) to avoid correlated blind‑spots and to bound per‑auditor load.
4) **Honeypot DUs:** MUST be **profile‑indistinguishable** from ordinary DUs: sizes drawn from the same power‑of‑two distribution; RS profiles sampled from governance‑approved mixes; Nil‑Lattice slots assigned via the standard hash; and metadata randomized within normal bounds. Any retrieval receipt for a Honeypot DU is automatically selected for 100% verification.
   **Normative (Indistinguishability):** Honeypot DUs MUST be created and funded pseudonymously (e.g., using zero-knowledge proofs of funding) to prevent identification via on-chain analysis. Retrieval patterns MUST mimic organic traffic distributions.
   **Normative (Blinded Funding):** Funding for Honeypot DUs MUST originate from a decentralized, blinded pool (e.g., a shielded treasury or mixer) managed by the NilDAO. Funding transactions MUST NOT be linkable to the governance process.

#### 6.3.2 Verification Procedure
Watchers (or DA validators) MUST, for each sampled receipt:
- Verify Ed25519 client signature and expiry.
- Check `ChallengeNonce` uniqueness and binding to the DU slice.
- Verify RTT transcript via the QoS Oracle (§4.2) meets declared bounds.
- Verify inclusion in `BW_root` (Poseidon path).
Aggregate results into `SampleReport_t`.

#### 6.3.3 Enforcement
- Pass: If ≥ (1−ε) of sampled receipts per SP verify (`ε` default 1%), rewards vest as normal.
- Fail (Minor): If failures ≤ ε, deduct failing receipts from counted bytes and **forfeit all retrieval payouts** for the epoch.
- Fail (Major): If failures > ε, deduct failing receipts, **forfeit payouts**, and apply quadratic slashing to bonded $STOR. Repeat offenders MAY be suspended pending DAO vote.

#### 6.3.4 Governance Dials
NilDAO MAY tune: sampling fraction `p`, tolerance `ε` (default 0.1%), slashing ratio, and escalation behavior.

**Normative (Escalation Guard):** Escalation MUST be triggered both system-wide and per-SP. Per-SP escalation MUST immediately increase the SP's individual sampling rate $p_{sp}$ if their failure rate significantly exceeds $\epsilon$. System-wide escalation MUST increase $p$ stepwise by at most ×2 per epoch. However, if the anomaly rate exceeds $5 \times \epsilon_{sys}$, $p$ MUST immediately escalate to the maximum allowed by the **Verification Load Cap** (§ 6.1). Escalation auto‑reverts after 2 clean epochs. All changes MUST be announced in‑protocol.

Additional dial (content‑audited receipts):
- `p_kzg ∈ [0,1]` — Fraction of sampled receipts that MUST include one or more KZG openings at 128 KiB RS symbol boundaries corresponding to claimed bytes. Default 0.05. In plaintext mode, `p_kzg` MUST be ≥ 0.05 unless disabled by DAO vote under the Verification Load Cap. Honeypot DUs MUST use `p_kzg = 1.0`. On‑chain verification uses KZG precompiles when available; otherwise, auditors verify off‑chain with fraud‑proof slashing. Adjust `p_kzg` under the **Verification Load Cap** (§ 6.1).


#### 6.3.5 Security & Liveness
Sampling renders expected value of receipt fraud negative under rational slashing. Unlike asynchronous challenges that pause reads, NilStore maintains continuous liveness.


### 6.4  Bandwidth‑Driven Redundancy (Normative)

NilStore aligns replica count and provider selection with observed demand and measured provider capability:

1) **Heat Index.** For DU `d` at epoch `e`, define `H_e(d)` as an EMA over verifiable retrieval receipts (served bytes; p95 latency), half‑life `τ`. Watchers aggregate via BATMAN.

2) **Target Redundancy & Lanes.** Redundancy `r_e(d) = clamp(r_min, r_max, ceil(H_e / μ_target))`. The number of parallel client lanes `m(req) = clamp(1, m_max, ceil(B_req / μ_conn))`.

3) **Placement (WRP).** The per‑DU provider set is chosen by **weighted rendezvous hashing** on `(du_id, epoch)`, with weight `w_i = f(cap_i, conc_i, rel_i, price_i, geo_fit)` derived from **Provider Capability Vectors (PCV)** and watcher probes. Clients stripe requests across the top‑score providers (m lanes), failing over to the next candidates if SLA is not met.

4) **Hot replicas.** When `H_e(d)` crosses tier `T_hot(k)`, a VRF committee assigns `Δr` short‑TTL replicas to additional providers chosen by the same WRP. Providers post a `bond_bw`; rewards per verified byte follow `R_hot(H)`. Replicas expire when `H_e(d) < T_cool(k)` (hysteresis).

5) **Receipts.** Per‑chunk receipts commit to `{du_id, chunk_id, bytes, t_start, t_end, rtt, p99, client_nonce, provider_id}` with provider signatures. Receipts aggregate into `BW_root` per provider per epoch. Rewards apply only if quality factor `q ≥ q_floor`.


## 7. The Deal Lifecycle



### 7.y  Bandwidth Receipts & BW_root (Normative)

- **Receipt schema ($STOR‑only):** `{ du_id, chunk_id, bytes, region, t_start, t_end, provider_id, payer_id, [edge_id?, EdgeSig?], [grant_id?], PremiumPerByte, sig_provider }` hashed under `"BW-RECEIPT-V1"`.
- **Aggregation:** leaves → Poseidon Merkle → `"BW-ROOT-V1"`; providers submit `(provider_id, epoch, BW_root, served_bytes, agg_sig)`.
- **Eligibility (payer‑only + A/B):**
  (A) Edge‑settled: `edge_id` + `EdgeSig` from a payer‑registered edge; payable bytes = **origin→edge** only.
  (B) Grant‑token: `grant_id` valid under the payer’s `"GRANT‑TOKEN‑V1"` Merkle root and unspent.
  Receipts lacking `payer_id` are ineligible. Settlement MUST compute `Burn = β·BaseFee[region, epoch] × bytes` **before** Payout and MUST route `(1−β)` of `BaseFee × bytes` to the Security Treasury.
### 7.x  L2 Registries & Calls (New)

- `register_pcv(provider_id, PCV, proof_bundle)` — Provider Capability Vector registry; watcher probes attached and aggregated via BATMAN.
- `register_edge(edge_id, payer_id, max_miss_budget, bond_stor)` — Registers an edge authorized to emit edge‑settled receipts on behalf of `payer_id`. `bond_stor` MUST be ≥ f(max_miss_budget) (DAO‑tunable). Edges are slashable for forged receipts.
- `submit_bw_root(provider_id, epoch, BW_root, served_bytes, med_latency, agg_sig)` — Aggregation of per‑chunk receipts into a per‑epoch bandwidth root.
- `spawn_hot_replicas(du_id, epoch, Δr, TTL)` — VRF‑mediated hot‑replica assignment; requires capacity bonds and enforces TTL/hysteresis.



### 7.1 Quoting and Negotiation (Off-Chain)

1.  **Discovery:** Client queries Nil-Mesh for SPs near the required lattice slots.
2.  **Quoting:** SPs respond with a `Quote {Price_STOR_per_GiB_Month, Required_Collateral, QoS_Caps}`.
3.  **Selection:** Client selects the optimal bundle based on price and RTT (via QoS Oracle).

### 7.2 Deal Initiation (On-Chain - L2)

1.  **`CreateDeal`:** Client calls the function on the L2 settlement contract.
    *   It posts the Commitment Root (C_root).
    *   It locks the total storage fee in $STOR escrow.
    *   A **Deal NFT** (ERC-721) is minted to the client, representing the contract.
2.  **`MinerUptake`:** The selected SP bonds the required $STOR collateral and commences service.
3.  **`StorageAttest`:** Before any PoUD+PoDE proofs for this deal are counted toward vesting,
    the SP MUST post on L1/L2 an attestation tuple
    `{sector_id, origin_root, deal_id}`
    where `origin_root` commits to the data layout `{du_id, sliver_index, symbol_range, C_root}`.
    Vesting and bandwidth distribution for this sector are **disabled** unless a matching `StorageAttest` exists.

### 7.3 Vesting and Slashing

*   **Vesting:** The escrowed fee is released linearly to the SP each epoch, contingent on a valid **PoUD + PoDE** submission.
*   **Consensus Parameters (Normative):**
    *   **Epoch Length (`T_epoch`)**: 86,400 s (24 h).
    *   **Proof Window (`Δ_submit`)**: 120 s after epoch end — this is the *network scheduling window* for accepting proofs (DAO‑tunable; normative floor 60 s). (See Core Spec §4.6).
    *   **Per‑replica Work Bound (`Δ_work`)**: 1 s (baseline profile), the minimum wall‑clock work per replica defined by the PoDE calibration (See Core Spec §0.2).
    *   **Block Time** (Tendermint BFT): 6 s.
*   **Slashing Rule (Normative):** Missed **PoUD + PoDE** proofs trigger a quadratic penalty on the bonded $STOR collateral:
    `Penalty = min(0.50, 0.05 × (Consecutive_Missed_Epochs)²) × Correlation_Factor(F)`
* `F` is computed **per diversity cluster** (ASN×region cell) and globally.
* **Correlation_Factor(F) (Tractable Definition):**
      * The use of "Shapley-like shares" is removed due to computational infeasibility.
      * Let $F_{cluster}$ be the fraction of total capacity within a diversity cluster that failed in the current epoch.
      * $Correlation\_Factor(F) = 1 + \alpha \cdot (F_{cluster})^{\beta}$
      * Defaults: $\alpha = 1.0$, $\beta = 2.0$, `floor_SP = 1.0`, `cap_corr = 5.0`. Bounds (DAO‑tunable within): $\alpha ∈ [0.5, 2.0]$, $\beta ∈ [2, 4]$, `cap_corr ∈ [3, 8]`. Parameters MUST stay within bounds and respect standard timelocks.
      * The Correlation_Factor MUST be capped by `cap_corr`. An SP-level floor `floor_SP = 1.0` MUST be applied (correlation should increase, not decrease, the penalty).
      * **Normative (Collocation Definition):** Collocated identities (same /24, ASN, OR high RTT Profile Similarity (§3.3)) MUST be merged for $F_{cluster}$ computation to prevent Sybil dilution.
      * For $F_{global} > F^{*}$ (default 15%), the DAO MAY activate a temporary cap on network-aggregate burn (e.g., 2%/epoch).
    The penalty resets upon submission of a valid proof.

### 7.4 Multi‑Stage Epoch Reconfiguration

#### 7.4.0 Objective
Ensure uninterrupted availability during committee churn by directing writes to epoch e+1 immediately, while reads remain served by epoch e until the new committee reaches readiness quorum.

#### 7.4.1 Metadata
Each DU MUST carry `epoch_written`. During handover, gateways/clients route reads by `epoch_written`; if `epoch_written < current_epoch`, they MAY continue reading from the old committee until readiness is signaled.

#### 7.4.2 Committee Readiness Signaling
New‑epoch SPs MUST signal readiness once all assigned slivers are bootstrapped. A signed message: `{epoch_id, SP_ID, slivers_bootstrapped, timestamp, sig_SP}` is posted on L1. When ≥ 2f+1 SPs signal, the DA chain emits `CommitteeReady(epoch_id)`.

Readiness Audit (Normative). Before counting an SP toward quorum, watchers MUST successfully retrieve and verify a random audit sample of that SP’s assigned slivers (sample size ≥ 1% or ≥ 1 sliver, whichever is larger). Failures cause the SP’s readiness flag to be cleared and a backoff timer `Δ_ready_backoff` (default 30 min) to apply before re‑signal.

#### 7.4.3 Routing Rules
- Writes: MUST target the current (newest) epoch.
- Reads:
  - If `epoch_written = current_epoch`, read from current.
  - If `epoch_written < current_epoch`, prefer old committee until `CommitteeReady`, then switch to new.
Gateways MUST NOT request slivers from SPs that have not signaled readiness.

#### 7.4.4 Failure Modes
- SPs failing to signal by the epoch deadline are slashed per policy.
- If quorum is not reached by `Δ_ready_timeout`, the DAO MAY trigger emergency repair bounties.
- False readiness is slashable and MAY cause temporary suspension from deal uptake.

#### 7.4.5 Governance Dials
DAO‑tunable: `Δ_ready_timeout` (default 24h), quorum (default 2f+1), slashing ratios, and the emergency bounty path.

## 8. Advanced Features: Spectral Risk Oracle (σ)

To manage systemic risk and enable sophisticated financial instruments, NilStore incorporates an on-chain volatility oracle (σ).

*   **Mechanism:** σ is calculated daily from the Laplacian eigen-drift of the storage demand graph (tracking object-to-region flows).
    `σ_t := ||Δλ₁..k(Graph_t)||₂` (tracking the k lowest eigenvalues).
    **Normative (Oracle Input Hardening):** The input `Graph_t` MUST be filtered to exclude manipulative patterns, such as rapid creation/deletion of deals by the same entity (Sybil filtering) and traffic associated with high abuse scores (§5.2.1.c.1).
*   **Application (Dynamic Collateral):** The required collateral for a deal is dynamically adjusted based on volatility:
    `Required_Collateral := Base_Collateral · f(σ)`
    // Collateral MUST be anchored solely to internal network volatility (σ).
    // External price volatility ($σ_{price}$) is excluded to maintain the no-oracle design (§5.2)
    // and prevent importing market volatility into the core data security model.
    Higher volatility (σ) necessitates higher slashable stake. This also informs pricing for storage ETFs and insurance pools.
    **Normative (Oracle Dampening and Management):** The function $f(\sigma)$ MUST incorporate a dampening mechanism (e.g., a 30-day Exponential Moving Average).
    **Normative (Circuit Breakers and Rate Limits):** The rate of change in Required_Collateral MUST be capped per epoch (e.g., max 10% increase) to prevent sudden shocks.
    **Normative (Grace Period):** A mechanism for collateral top-ups MUST be defined. The grace period before liquidation/slashing is DAO-tunable (default 72 hours).

## 9. Governance (NilDAO)

### 9.x  Bandwidth Quota, Auto‑Top‑Up & Sponsors (Normative)

The protocol uses a **hybrid** bandwidth model: each file has an **included quota** (budget reserved per epoch from uploader deposits in **$STOR**; verified receipts **debit $STOR escrow**). On exhaustion, the file enters a **grace tier** with reduced placement weight until **auto‑top‑up** or **sponsor** budgets restore full weight. APIs: `set_quota`, `set_auto_top_up`, `sponsor`. Governance sets `w_grace`, roll‑over caps, region multipliers, price bands, sponsor caps, and ASN/geo abuse discounts.



The network is governed by the NilDAO, utilizing stake-weighted ($STOR) voting on the L2 Settlement Layer.

### 9.1 Scope

The DAO controls economic parameters (slashing ratios, bounty percentages), QoS sampling dials (`p`, `ε`, `ε_sys`), multi‑stage reconfiguration thresholds (`Δ_ready_timeout`, quorum, `Δ_ready_backoff`), Durability Dial mapping (target → profile), metadata‑encoding parameters (`n_meta`, `k_meta`, `meta_scheme`), network upgrades, and the treasury.
It also controls content‑binding dials across Core and Metaspec, primarily the receipt‑level content‑check fraction `p_kzg` (this § 6.3.4).
Additional PoDE/PoUD pressure dials:
- `R` — Minimum parallel PoDE sub‑challenges per proof window (default `R ≥ 16`).
- `B_min` — Minimum verified bytes per proof window (default `≥ 128 MiB`).
- Escalation: If sampled fail rate `ε_sys` exceeds the threshold for 2 epochs, increase `R` and/or `B_min` stepwise (×1.5 max per epoch) subject to the Verification Load Cap (§ 6.1).

### 9.2 Upgrade Process

*   **Standard Upgrades:** Require a proposal, a voting period, and a mandatory 72-hour execution timelock.
*   **Emergency Circuit (Hot-Patch):** A predefined **5‑of‑9** threshold **with role diversity** can enact **VK‑only** emergency patches (see § 2.4). Keys MUST be HSM/air‑gapped.
    *   **Key Allocation and Independence (Normative):** The 9 keys MUST be strictly allocated as: Core Team (3), Independent Security Auditor (3), Community/Validator Rep (3).
       The Auditor role MUST be distributed across three distinct entities (1 key each) with provably no financial or control relationship with the Core Team, ratified by DAO vote annually.
       The 5-of-9 threshold MUST include at least one valid signature from each of these three main groups (Core, Auditor, Community).
    *   **Sunset Clause (Normative):** Emergency patches automatically expire 14 days after activation unless ratified by a full DAO vote.
    *   **Key Lifecycle Management (Normative):** Auditor and Community keys MUST be rotated annually. Core Team keys MUST be revoked and rotated upon personnel changes, requiring DAO ratification of the new keyholders.
    *   **Sunset Integrity (Normative):** The emergency patch mechanism MUST NOT be capable of modifying the Sunset Clause duration or the ratification requirement. If an emergency patch is ratified by a full DAO vote during the 14-day window, the automatic expiration MUST be disabled. The ratified patch remains active until it is superseded by the standard upgrade cycle.

### 9.3 Freeze Points

The cryptographic specification (`spec.md@<git-sha>`) and the tokenomics parameters (`tokenomics@<git-sha>`) are hash-pinned and frozen prior to external audits and the formal DAO launch.

## 10. Roadmap and KPIs

### 10.1 Phased Rollout

1.  **MVP SDK (Rust/TS):** (2025-09)
2.  **DAO Launch & Tokenomics Freeze:** (2025-11)
3.  **Public Testnet-0 (L1 DA Chain):** (2026-01) - PoUD+PoDE, basic economics.
4.  **Edge-Swarm Beta (Retrieval Economy):** (2026-04) - Mobile client, $BW activated.
5.  **Rollup Bridge Mainnet (L2 Settlement):** (2026-06) - EVM L2 integration, Deal NFTs.
6.  **Mainnet-1:** (2026-09).

### 10.2 Key Performance Indicators (Targets)

| Metric                  | Target                               |
| ----------------------- | ------------------------------------ |
| Seal Time (64 GiB)      | N/A (no sealing)                     |
| Epoch Proof Size (Aggregated) | ≤ 1.2 kB (post-recursion)            |
| Retrieval RTT (p95)     | ≤ 400 ms (across 5 geo regions)      |
| On-chain Verify Gas (L2)| ≤ 120k Gas                           |
| Durability              | ≥ 11 nines (modeled)                 |
| Sampling FP/FN rate       | ≤ 0.5% / ≤ 0.1% (monthly audit)    |
| Handover ready time (p50) | ≤ 2 h (RS‑2D‑Hex), ≤ 6 h (RS)       |

## 11. Product UX & Economics (Product-Aligned)

### 11.1 Client APIs (informative; SDK requirement)
- `store(file, durability_target, term)` → returns `{deal_id, profile, price_quote, placement_summary, estimated_retrieval_price}`. SDKs MUST expose escrow balance, spend caps, and redundancy status events.
- `get(file_id)` → routes to healthy SPs, returns a price quote before retrieval. SDKs SHOULD expose “price cap would be exceeded” warnings and allow user confirmation.

### 11.2 SP Selection & Pricing (normative where noted)
- **Canonical AskBook:** Providers post bounded price curves per `{region, qos_class}` `{sp_id, region, qos_class, p0, k, γ, cap_free_GiB, min_term, price_curve_id}` within caps/bounds (`β_floor=0.70`, `β_ceiling=1.30`, `premium_max=0.5×BaseFee`, `price_cap_GiB=2×` median BaseFee; `k, γ` bounded per PSet). The chain publishes a single `AskBookRoot` plus partition offsets each epoch; deals MUST prove selection against this root. Off‑book providers are ineligible for PoUD/PoDE payouts.
- **Deterministic assignment:** For a DU `{CID_DU, ClientSalt_32B, shard_index, region, qos}`, deterministically sort candidate slices by marginal price (at current util), then QoS, then `sp_id`; enforce placement (one shard per cell, min ring/slice distance by profile); skip violations and fill until redundancy target met. Quotes outside caps are rejected.

### 11.3 Redundancy Dial & Auto-Rebalance (normative)
- Durability slider presets map to governance‑pinned profiles (see Core §6.2): `Standard`=RS(12,9), `Archive`=RS(16,12), `Mission-Critical`=RS‑2D‑Hex{rows=4, cols=7}. Deals MUST record `durability_target` and resolved profile.
- Placement constraints per profile: `Standard` ring distance ≥ 2; `Archive` ring distance ≥ 3; `Mission-Critical` ring distance ≥ 3 and slice distance ≥ 2, all with one shard per SP per cell.
- Auto‑rebalance: when redundancy < target or an SP exits, the network MUST schedule repairs within `T_repair_max` to restore the profile, opening against the original `C_root` and respecting placement diversity. Defaults: `T_repair_max = 24h` (RS), `T_repair_max = 8h` (RS‑2D‑Hex). Status transitions `healthy/degraded/repairing` are emitted as events.

### 11.4 Capacity-Aware Entry/Exit (normative)
- Entry probation: rewards ramp 50→100% over `N_probation = 7` epochs; slashing multiplier `λ_entry = 1.25` during ramp.
- Exit: exit fee and unbonding window scale with capacity headroom (`H_free`): `headroom_raw = free_capacity_ratio / target_headroom` with default `target_headroom = 0.20` (pinned in `PSet`, chosen to preserve ~20% spare for repairs/unbonding). Optionally smooth `headroom_raw` via 7‑day EMA; use `headroom = clamp(0,1, headroom_raw_smoothed)`. `F_exit = F_base × (1 + k_fee × (1 − headroom))` with defaults `F_base=0.5%`, `k_fee=2.0`, bounds `[0.5%, 10%]`; `T_unbond = T_base + k_time × (1 − headroom)` with defaults `T_base=24h`, `k_time=72h`, bounds `[12h, 7d]`. High headroom → low fee/fast exit; low headroom → higher fee/slower exit and mandatory handoff. Exits finalize only after repairs complete and `T_unbond` elapses.

### 11.5 Billing & Spend Guards (normative)
- Single DU escrow covers storage + baseline egress in $STOR; auto top‑up optional. Defaults: `K_epoch=7` epochs funded; `K_low=3` epochs trigger grace. Retrieval continues but no new replicas spawn.
- Users MAY set `max_monthly_spend`; SDKs MUST enforce unless explicitly overridden. Retrieval receipts bill per epoch with bounded `β` and `PremiumPerByte` (within `[0, premium_max]`), subject to `price_cap_GiB`.

### 11.6 Events & Emergency UX (normative)
- Standard events: `DealCreated`, `RedundancyDegraded`, `RepairScheduled`, `RepairComplete`, `ProofMissed`, `ExitRequested`, `ExitFinalized`, `FreezeActivated`, `FreezeCleared`, `SpendGuardHit`. Clients and explorers SHOULD display these.
- Yellow‑flag freeze: proofs continue; withdrawals, new deals, and exits pause; auto top‑ups pause. Messaging to users/SPs is mandatory; timers for grace/sunset follow Core §6.3.

### 11.7 Research Isolation
- PoS²‑L RFCs (`rfcs/PoS2L_*`) are research‑only and disabled for production profiles unless explicitly activated by DAO supermajority plus emergency signers with auto‑sunset.

## Annex A: Threat & Abuse Scenarios and Mitigations (Informative)

| Scenario | Attack surface | Detect / Prevent (Design) | Normative anchor(s) |
| --- | --- | --- | --- |
| **Wash‑retrieval / Self‑dealing** | SP scripts fake clients to inflate bandwidth usage | Challenge‑nonce + expiry in receipts; watchers or L1 verify Ed25519 off‑chain/on‑chain; protocol commits to **Poseidon receipt root** and byte‑sum; per‑DU/epoch service caps; /16 down‑weighting | §6.1 (Receipt schema & verification model), §6.2 (BW_root) |
| **RTT Oracle collusion** | Gateways/attesters collude to post low RTT | Stake‑weighted attesters; challenge‑response tokens; ASN/region diversity; randomized assignments; slashable fraud proofs with raw transcripts | §4.2 (RTT Oracle) |
| **Commitment drift in repair** | Repaired shards bound to a *new* commitment | Repaired shards MUST open against the **original DU KZG**; reject new commitments | §3.3 (Autonomous Repair) |
| **Bridge/rollup trust** | VK swap or replay of old epoch | L2 bridge pins `vk_hash`; public inputs `{epoch_id, DA_state_root, poud_root, bw_root}`; monotone `epoch_id`; timelocked VK upgrades | §2.4 (ZK‑Bridge) |
| **Lattice capture (ring‑cell cartel)** | SPs concentrate shards topologically | One‑shard‑per‑SP‑per‑cell; minimum cell distance; DAO can raise separation if concentration increases | §3.2 (Placement constraints), §9 (Governance) |
| **Shard withholding (availability)** | SP stores but doesn’t serve | Vesting tied to valid PoUD + PoDE; Bandwidth distribution requires receipts; slashing for missed epochs | §7.3 (Vesting/Slashing), §6 |
