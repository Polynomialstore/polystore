# PolyStore Whitepaper

**Outline Draft for Rewrite**

## Purpose

This document should become the first serious technical argument for PolyStore.

Its job is to explain one coherent system early: PolyStore organizes content as PolyFS, a verifiable file layout whose internal units are MDUs and blobs, and treats retrieval as a first-class protocol event. The whitepaper should show how that single design choice propagates through commitments, placement, proof verification, economics, and threat model.

It should not be a paraphrase of `spec.md`, and it should not read like a market-facing brochure. The paper should explain how the system fits together and why the mechanisms belong together.

---

## Drafting Rules

* Write in continuous argument, not branded bullet piles.
* Introduce PolyFS and the retrieval model together near the front of the paper.
* Use one running example and one recurring system diagram.
* Prefer mechanism-first explanations over comparative marketing language.
* Do not use legacy mode terminology or migration framing.
* When a claim depends on a mechanism, show the mechanism.

---

## Proposed Structure

## 1. Introduction: PolyFS Makes Retrieval Verifiable

### Goal of the section
State the thesis, the system boundary, and the central design move.

### What it needs to do
* Define PolyStore as a decentralized storage protocol built around two linked commitments: PolyFS as the canonical file layout and accountable retrieval sessions.
* Explain that retrievability is the central storage fact the protocol cares about.
* State the paper's core question: how do we organize data as PolyFS so reads can be direct, verifiable, and economically accountable without putting the whole dataset on-chain?

### Desired outcome
By the end of the introduction, the reader should understand that the paper is about the design of retrievability, not about generic storage-chain branding.

---

## 2. Problem Statement and Design Constraints

### Goal of the section
Make the constraints explicit before introducing the mechanism.

### Constraints to name
* Users care about getting bytes back, not isolated proof theater.
* The chain cannot store or verify whole datasets directly.
* Files must map into a structure that clients can resolve and providers can serve deterministically.
* Providers should be assigned and paid under anti-sybil, budget-aware rules.
* Retrieval must be verifiable without trusting a gateway.
* The protocol needs a compact on-chain commitment anchor for large datasets.

### Why this section matters
Every later mechanism should visibly answer one of these constraints.

---

## 3. System Overview: One Deal, One PolyFS, One Retrieval

### Goal of the section
Give the reader a compact system picture before diving into individual mechanisms.

### Actors
* data owner
* requester / reader
* storage provider
* chain
* optional gateway / client helper

### Core objects
* deal
* `manifest_root`
* blob
* MDU
* `MDU #0`
* witness MDUs
* user MDUs
* slot assignment
* retrieval session

### What it needs to say
* A deal is the on-chain anchor for committed content and economics.
* Files become ranges inside PolyFS, whose internal structure is made of metadata MDUs and user-data MDUs.
* The slot map determines which providers hold which striped user-data shards and which metadata is replicated.
* A retrieval session binds a read request to payer, scope, slot responsibility, and completion conditions.

### Editorial note
This section should include a miniature end-to-end flow, not just definitions. It is the paper's first grounding point.

---

## 4. PolyFS and the Commitment Model

### Goal of the section
Explain exactly how PolyFS turns files into committed structure, and how the MDU system supports it.

### Required content
* MDU and blob granularity
* `MDU #0` as the file table / root table anchor
* witness MDUs as commitment-bearing metadata
* user-data MDUs as the data-bearing layer
* file-to-range mapping inside PolyFS
* `manifest_root` as the compact chain commitment

### What this section must answer
* How does a file map into PolyFS, MDUs, and blobs?
* What metadata must be replicated to make retrieval practical?
* Why is the `manifest_root` sufficient as the on-chain trust anchor?

---

## 5. Striped Placement and Provider Responsibilities

### Goal of the section
Explain how committed PolyFS data is distributed across providers.

### Required content
* ordered slot assignment
* RS(`K`,`K+M`) profile
* metadata replication
* user-data striping
* reconstruction from any valid `K` slots
* provider obligations at the slot level

### What it needs to argue
* Striping is the canonical architecture, not an optional flavor.
* Slot assignment is what makes routing, accountability, and reconstruction coherent.
* PolyFS and the slot layout are designed together.

---

## 6. Retrieval Sessions and Settlement

### Goal of the section
Make retrieval sessions feel like the protocol center of gravity.

### Required content
* session open
* authorized scope and funding path
* off-chain byte serving
* proof submission
* completion confirmation
* settlement and expiry rules

### What this section must answer
* Why does a retrieval need an explicit session object?
* What exactly is being authorized and paid for?
* When does a provider receive protocol credit or payout?

### Editorial note
This section should be prose-first with one compact message-flow diagram.

---

## 7. Verification Path: From Served Bytes Back to the Commitment

### Goal of the section
Explain how served bytes are checked against the on-chain commitment.

### Required content
* chained / triple-proof overview
* manifest inclusion
* structure proof inside the target MDU
* byte- or blob-level opening
* why the chain can verify a specific retrieval claim without holding the dataset

### What it must avoid
* Pure symbol dumping without narrative.
* Unexplained references to "cryptographic proof" without the path.

---

## 8. End-to-End Worked Example

### Goal of the section
Tie sections 3 through 7 into one concrete story with numbers.

### Required example flow
1. Create a deal.
2. Pack one file into PolyFS.
3. Assign `N = K+M` slots.
4. Upload striped user-data shards and replicated metadata.
5. Commit `manifest_root`.
6. Open one retrieval session for a concrete byte range.
7. Serve data from assigned providers.
8. Verify proofs and confirm completion.
9. Settle fees and record outcome.

### Why this section is mandatory
Without one full example, the paper will still feel assembled rather than argued.

---

## 9. Economics and Additional Slot-Aligned Placements

### Goal of the section
Explain the money flow and the bounded scaling path in one place.

### Required content
* storage term / deal funding
* retrieval fees
* base fee and variable fee
* completion payout
* budget limits
* user-funded elasticity
* when additional slot-aligned placements are justified

### What it needs to argue
* Retrieval work is settled, not merely observed.
* Provider compensation follows accountable service.
* Scaling must stay attached to slot structure and explicit budget.

---

## 10. Security, Privacy, and Trust Boundaries

### Goal of the section
State what the protocol defends, what it exposes, and where trust is minimized.

### Topics to cover
* wrong data / fraud proofs
* non-response / liveness failure
* sybil and placement manipulation
* wash traffic / fake demand
* gateway trust minimization
* client-side encryption model
* metadata leakage boundaries
* crypto-erasure framing

### What it needs to argue
* Integrity is rooted in the commitment chain.
* Availability and accountability are rooted in slot assignment plus retrieval sessions.
* Privacy claims should stop where metadata and operational reality begin.

---

## 11. Client Roles, Scope Discipline, and Conclusion

### Goal of the section
Close the paper without turning it into a roadmap dump.

### Required content
* browser/WASM path
* gateway as optional helper, not trust anchor
* direct-to-provider data path
* wallet-signed control-plane actions
* bounded list of open questions: repair policy, elasticity tuning, policy ergonomics

### Desired closing idea
PolyStore should be presented as a protocol that organizes files into verifiable PolyFS structure so retrieval can be direct, provable, and economically accountable under explicit on-chain rules.
