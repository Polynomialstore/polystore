# PolyStore Whitepaper

**Outline Draft for Rewrite**

## Purpose

This document should become the technical narrative for PolyStore. It should explain the protocol as a system, defend the architectural choices, and give readers enough structure to understand how the spec hangs together.

It should not be a paraphrase of `spec.md`, and it should not be a market-facing brochure. The job of the whitepaper is to connect:

* the problem,
* the system model,
* the commitment model,
* the retrieval/session model,
* the economics,
* and the threat model.

If the litepaper is the shortest serious introduction, the whitepaper should be the first serious technical argument.

---

## Drafting Rules

* Write in continuous argument, not branded bullet lists.
* Every major section should answer a real technical question.
* Use one running example and one system diagram that recur throughout the document.
* Do not use legacy mode language or historical migration framing.
* Do not over-brand ordinary mechanisms.
* When a claim depends on a mechanism, show the mechanism.

---

## Proposed Structure

## 1. Introduction

### Goal of the section
State the protocol thesis, the system boundary, and the central design tradeoff.

### What it needs to do
* Define PolyStore as a decentralized storage protocol centered on striped data placement and accountable retrieval.
* Explain that retrieval is the operational center of the system, not a secondary concern.
* Frame the whitepaper around the question: how do we make stored data retrievable, verifiable, and economically accountable?

### Desired outcome
By the end of the introduction, the reader should know what problem the paper is solving and why the design is not just "another storage chain."

---

## 2. Problem Statement and Design Constraints

### Goal of the section
Make the constraints explicit before introducing mechanisms.

### Constraints to name
* Users care about getting bytes back, not isolated proof theater.
* The chain cannot store or verify whole datasets directly.
* Providers should be selected and paid under anti-sybil, budget-aware rules.
* Retrieval must be verifiable without trusting a gateway.
* The protocol needs a compact on-chain commitment anchor for large data.

### Why this section matters
It gives the rest of the paper a falsifiable frame. Every later mechanism should clearly answer one of these constraints.

---

## 3. System Model

### Goal of the section
Define the actors and objects in a compact, rigorous way.

### Actors
* Data owner
* Requester / reader
* Storage provider
* Chain
* Optional gateway / client helper

### Core objects
* Deal
* Manifest root
* MDU
* Blob
* Slot assignment
* Retrieval session

### What it needs to say
* A deal is the central on-chain object.
* Content is committed by manifest root.
* Placement is an ordered slot map for striped storage.
* Retrieval sessions bind payer, content, provider/slot, and byte range into one accountable event.

---

## 4. Data Layout and Commitments

### Goal of the section
Explain how data is structured and what exactly is committed on-chain.

### Required content
* MDU and blob granularity
* PolyFS / file-to-range mapping
* Metadata region versus user-data region
* Manifest-root commitment model
* Why this layout is chosen

### What the section must answer
* How does a file map into committed storage units?
* What does the chain actually store?
* Why is the manifest root sufficient as the trust anchor?

---

## 5. Striped Placement Model

### Goal of the section
Explain the canonical striped layout and why the protocol standardizes on it.

### Required content
* Ordered slot assignment
* RS(`K`,`K+M`) profile
* Metadata replication
* User-data striping
* Reconstruction from any valid `K` shards

### What it needs to argue
* Striping is the core architecture, not an optional mode.
* The slot map is what makes provider accountability and retrieval routing coherent.
* The protocol's availability story depends on this structure.

---

## 6. Retrieval Sessions

### Goal of the section
Make retrieval sessions feel like the protocol center of gravity.

### Required content
* Session open
* Session binding fields
* Off-chain byte serving
* Proof submission
* Completion confirmation
* Settlement conditions

### What this section must answer
* Why is a retrieval session necessary?
* What exactly is being authorized and paid for?
* When does a provider get credit?

### Editorial note
This section should be prose-first, with one compact message-flow diagram.

---

## 7. Proof Model and Verification Path

### Goal of the section
Explain how the protocol binds served bytes back to the on-chain commitment.

### Required content
* Triple proof / chained verification
* Manifest inclusion
* Blob inclusion / structure proof
* Data opening / byte-level verification
* Why the chain can verify specific retrieval claims without holding full data

### What it must avoid
* Pure symbol dumping without narrative.
* Hand-wavy statements like "cryptographic proof" without path explanation.

---

## 8. End-to-End Worked Example

### Goal of the section
Give the reader one concrete story that ties together sections 3 through 7.

### Required example flow
1. Create a deal.
2. Assign `N = K+M` slots.
3. Encode and upload one file.
4. Commit `manifest_root`.
5. Open one retrieval session for a concrete byte range.
6. Serve data from assigned providers.
7. Submit proofs.
8. Confirm completion.
9. Settle fees and record outcome.

### Why this section is mandatory
Without it, the paper will continue to feel abstract and synthetic.

---

## 9. Economics and Pricing

### Goal of the section
Explain the protocol's money flow and why it is aligned with the retrieval-first design.

### Required content
* Storage term / deal funding
* Retrieval fees
* Base fee and variable fee
* Completion payout
* Budget limits
* User-funded elasticity

### What it needs to argue
* Retrieval work is not just observed; it is settled.
* Provider compensation follows accountable service.
* Elasticity must be budgeted and bounded.

---

## 10. Elasticity and Additional Slot-Aligned Placements

### Goal of the section
Explain the scaling path without sounding like marketing.

### Required content
* Saturation signal
* When additional placements are justified
* Why scaling is attached to slot structure
* Why this must remain budget-aware

### Editorial note
This section should be careful, mechanistic, and short. It should not sound like CDN copy.

---

## 11. Security and Threat Model

### Goal of the section
State what the protocol defends against and how.

### Threats to cover
* Wrong data / fraud proofs
* Non-response / liveness failure
* Sybil and placement manipulation
* Wash traffic / fake demand
* Gateway trust minimization

### What it needs to argue
* Integrity is rooted in the commitment chain.
* Availability/accountability is rooted in retrieval sessions and slot assignments.
* The system's economics make abuse costly rather than free.

---

## 12. Privacy, Confidentiality, and Deletion

### Goal of the section
Say only what the protocol can actually claim.

### Required content
* Client-side encryption model
* What providers can and cannot learn
* Ciphertext replication
* Crypto-erasure as the deletion model
* Boundaries around metadata leakage and operational limits

### Editorial note
This section should be disciplined and precise, not venture-copy.

---

## 13. Implementation Surface and Client Roles

### Goal of the section
Clarify how browsers, gateways, and providers relate to the protocol.

### Required content
* Browser/WASM path
* Gateway as optional helper, not trust anchor
* Direct-to-provider retrieval and upload
* Wallet-signed control-plane actions

### Why this matters
Readers should leave understanding that the protocol is not "the gateway."

---

## 14. Boundaries, Open Questions, and Scope Discipline

### Goal of the section
Make the document sound authored rather than inflated.

### Good topics
* Repair and replacement policy details
* Long-horizon elasticity policy
* Retrieval-policy ergonomics
* Metadata privacy tradeoffs
* Parameter tuning versus architectural commitments

### Editorial note
This section is not about weakness; it is about intellectual honesty.

---

## 15. Conclusion

### Goal of the section
Restate the full claim of the paper in tighter form.

### Desired closing idea
PolyStore should be presented as a protocol that treats retrievability as the central storage fact, uses compact commitments to anchor large datasets, and settles real retrieval work through accountable, budgeted, verifiable sessions.
