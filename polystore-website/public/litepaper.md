# PolyStore Litepaper

**Outline Draft for Rewrite**

## Purpose

This document should become the short, readable explanation of PolyStore for technical founders, infrastructure engineers, and serious users who want the system in one sitting.

It should answer five questions clearly:

1. What is PolyStore?
2. Why does it need to exist?
3. How does a file actually move through the system?
4. Why are the economics and incentives coherent?
5. Why is this meaningfully different from existing decentralized storage designs?

This document should not read like a spec and should not read like marketing copy. It should be concrete, opinionated, and example-driven.

---

## Drafting Rules

* Use one running example throughout the paper: one file, one deal, one retrieval session, one settlement path.
* Define protocol terms once, then use them consistently.
* Cut slogans unless they are followed immediately by explanation.
* Prefer short paragraphs over bullet spam.
* Avoid pitch-deck language such as "revolutionary", "future of storage", or generic cloud copy.
* Do not mention legacy architecture history or deprecated mode terminology.

---

## Proposed Structure

## 1. Opening Thesis

### Goal of the section
Explain PolyStore in one page without jargon overload.

### What it needs to say
* PolyStore is a decentralized storage system built around striped storage, verifiable retrieval, and on-chain retrieval sessions.
* The core claim is that retrieval should not be economically and cryptographically separate from storage verification.
* The system is designed around direct provider retrieval, client-verifiable commitments, and fee-backed settlement.

### What it should avoid
* Big list of branded concepts.
* Unexplained terms in the first two paragraphs.

---

## 2. The Problem With Existing Designs

### Goal of the section
Show the reader what is structurally wrong with storage systems that separate storage proofs from real user reads.

### What it needs to say
* Traditional proof systems can become detached from actual demand.
* Retrieval is often treated as a secondary path instead of the central operational path.
* Users care about getting bytes back, not just about providers passing isolated audits.
* A modern system should align payment, verification, and data delivery.

### Good outcome
By the end of this section, the reader should understand why PolyStore cares so much about retrieval sessions.

---

## 3. The Core Model

### Goal of the section
Introduce the minimal set of objects required to understand the protocol.

### Concepts to define
* Deal
* `manifest_root`
* MDU / blob / slot
* Provider assignment
* Retrieval session

### What it needs to say
* A deal is an on-chain container for committed content plus economics.
* Content is committed through a manifest root rather than by storing whole-file state on-chain.
* Providers are assigned into an ordered striped slot map.
* Retrieval is performed against assigned providers and settled through an on-chain session flow.

---

## 4. One File, End to End

### Goal of the section
This is the most important section in the litepaper. It should make the system feel real.

### Required worked example
Walk one file through:

1. User creates a deal.
2. Chain assigns slots.
3. Client encodes the file into striped shards.
4. Providers receive their assigned shards.
5. User commits the returned manifest root.
6. Later, a reader opens a retrieval session.
7. Providers serve data and proof material.
8. Reader confirms completion.
9. Chain settles fees and records completion.

### Editorial note
Use concrete example values for `K`, `M`, blob counts, and fee flow. Do not leave the example abstract.

---

## 5. Why Striping Matters

### Goal of the section
Explain why PolyStore is built around one canonical striped architecture.

### What it needs to say
* Striping is not a side mode; it is the core layout.
* Metadata is replicated broadly; user data is striped across the slot map.
* Reconstruction from any valid `K` shards improves availability and retrieval flexibility.
* The system is designed around direct retrieval from assigned providers, not around a monolithic gateway.

### What it should avoid
* Historical comparison against removed internal modes.
* Generic "faster, cheaper, better" claims without mechanism.

---

## 6. Retrieval Sessions and Settlement

### Goal of the section
Explain how reads become accountable economic events.

### What it needs to say
* A retrieval session pins content, payer, provider/slot, and byte range.
* Providers do not get paid just for claiming service; they get paid when the session reaches completion.
* The user-confirmation step matters because it ties settlement to successful delivery.
* This is the bridge between data-plane work and protocol accounting.

### Concrete details worth naming
* base fee
* variable fee per blob
* completion payout
* expiry / refund behavior

---

## 7. What Data Owners Control

### Goal of the section
Make the user-facing controls feel concrete.

### What it needs to say
* Users fund a deal and control content commits.
* Users choose retrieval exposure through policy.
* Users can bound spend.
* Users can encrypt before upload and retain key control.

### Editorial note
Keep this section practical. It should read like operator reality, not feature marketing.

---

## 8. What Providers Actually Do

### Goal of the section
Describe the provider role in operational terms.

### What it needs to say
* Store assigned shards.
* Serve retrievals for assigned slots.
* Produce proof material tied to committed data.
* Participate in the economics through retrieval performance and protocol accountability.

### What it should avoid
* Hand-wavy "earn by being fast" copy without describing what work providers perform.

---

## 9. Economics in Plain English

### Goal of the section
Give the reader a coherent mental model of money flow.

### What it needs to say
* There is a storage term and a retrieval path.
* Retrieval sessions consume fees at open and settle at completion.
* User-funded elasticity exists to handle real demand spikes.
* Additional slot-aligned placements should be described as a budgeted scaling mechanism, not as magic replication.

### Editorial note
This section should prefer one crisp diagram or one crisp example over broad prose.

---

## 10. Why This Design Is Different

### Goal of the section
State the real differentiation cleanly.

### Claims worth making if defended
* Retrieval is treated as the primary verification path, not an afterthought.
* The commitment model is compact enough to anchor large datasets on-chain.
* Striping, direct retrieval, and session settlement produce a cleaner operational model than separate audit-only schemes.

### What to avoid
* Cheap comparisons to named competitors unless they are technically exact and useful.

---

## 11. Limits and Honest Boundaries

### Goal of the section
Prevent the document from sounding inflated.

### What it should acknowledge
* This is a protocol for verifiable retrieval and storage coordination, not a magical global filesystem.
* Encryption does not remove all metadata leakage by itself.
* Scalability, repair, and elasticity are design areas that must remain economically disciplined.

### Editorial note
This section should be short, but it gives the document credibility.

---

## 12. Closing

### Goal of the section
End with a precise restatement of the thesis.

### Desired closing idea
PolyStore should feel like a storage protocol built around getting the bytes back under accountable, budgeted, cryptographically checkable conditions.
