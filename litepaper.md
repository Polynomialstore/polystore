# PolyStore Litepaper

**Outline Draft for Rewrite**

## Purpose

This document should become the shortest serious introduction to PolyStore.

Its job is to explain one compact argument early and clearly: PolyStore turns files into PolyFS, a verifiable file layout whose internal units are MDUs and blobs, and it treats retrieval as a first-class protocol action rather than an afterthought. The litepaper should make those two ideas feel like one coherent design.

It should answer five questions without sounding like a spec or like product copy:

1. What is PolyStore?
2. Why does the system start from retrievability rather than audit theater?
3. How do files become PolyFS structure, commitments, and provider assignments?
4. How does a retrieval become a provable, paid protocol event?
5. Why is this design meaningfully different from storage systems that separate storage proofs from actual reads?

The document should stay concrete, compact, and example-driven.

---

## Drafting Rules

* Use one running example throughout the paper: one file, one deal, one retrieval session, one settlement path.
* Introduce PolyFS early, then explain its internal structure: `MDU #0`, witness MDUs, user MDUs, blobs, slots, and `manifest_root`.
* Explain retrieval early as part of the same story, not as a later feature.
* Prefer short paragraphs over glossary dumping.
* Use mechanisms and examples instead of slogans.
* Avoid legacy architecture history and deprecated mode language.

---

## Proposed Structure

## 1. The Core Claim

### Goal of the section
Explain PolyStore in a page without losing the mechanism.

### What it needs to say
* PolyStore stores files inside PolyFS, a verifiable file layout anchored by a compact `manifest_root` commitment and built from MDUs and blobs.
* PolyStore treats retrieval as the central accountable act: reads are opened as retrieval sessions, served by assigned providers, checked against commitments, and settled on completion.
* These are not separate features. PolyFS exists so retrieval can be direct, verifiable, routable, and economically accountable.

### Desired outcome
By the end of the opening, the reader should understand that PolyStore is about getting bytes back under checkable conditions, not just about providers passing isolated audits.

---

## 2. PolyFS: How Files Become Verifiable Structure

### Goal of the section
Introduce PolyFS early enough that the rest of the paper has a concrete object model, then explain the MDU system inside it.

### Concepts to define
* deal
* `manifest_root`
* blob
* MDU
* `MDU #0`
* witness MDUs
* user MDUs
* slot assignment

### What it needs to say
* Files are packed into PolyFS rather than treated as opaque objects.
* `MDU #0` and witness MDUs carry the metadata and proof structure that let clients resolve files and verify what providers serve.
* User data MDUs are the data-bearing units that get striped across providers.
* The chain stores a compact commitment to this structure instead of whole-file state.

### Editorial note
This section should make PolyFS feel operational, not mystical. Readers should come away understanding why its MDU model exists.

---

## 3. Retrieval Is the Protocol Center

### Goal of the section
Explain why retrieval is not a side path layered on top of storage.

### What it needs to say
* Real reads happen through retrieval sessions that bind payer, content, provider/slot responsibility, and byte range.
* Providers do not get protocol credit for vague availability claims; they get credit for serving bytes that can be tied back to committed structure.
* Session completion is what connects off-chain delivery to on-chain accounting.
* This is how PolyStore aligns payment, verification, and actual demand.

### Concrete details worth naming
* session open
* byte-range scope
* proof submission
* completion confirmation
* refund / expiry behavior

---

## 4. One File, End to End

### Goal of the section
Make the whole system feel real in one continuous example.

### Required worked example
Walk one file through:

1. A user opens a deal.
2. The file is packed into PolyFS (`MDU #0`, witness MDUs, user MDUs).
3. User-data MDUs are striped across assigned slots.
4. Providers receive their assigned shard data and replicated metadata.
5. The user commits the resulting `manifest_root`.
6. Later, a reader opens a retrieval session for a concrete range.
7. Providers serve the needed bytes and proof material.
8. The reader verifies completion.
9. The chain settles the session.

### Editorial note
Use concrete values for file size, `K`, `M`, MDU counts, and fee flow. The example should not stay abstract.

---

## 5. Roles, Economics, and Scaling

### Goal of the section
Explain what users and providers actually do, and how the money flow matches the architecture.

### What it needs to say
* Data owners fund deals, commit content, choose retrieval exposure, and can encrypt before upload.
* Providers store assigned shards plus replicated metadata, then serve reads for the slots they are responsible for.
* Retrieval sessions consume budget at open and settle on successful completion.
* Additional slot-aligned placements should be described as budgeted elasticity, not as vague replication marketing.

### What to avoid
* Splitting operator reality and economics into separate abstract sections.
* Generic claims like "providers earn by being fast" without describing the actual work.

---

## 6. Why This Design Matters, and Where It Stops

### Goal of the section
End with real differentiation and real boundaries.

### Claims worth making if defended
* PolyFS and the retrieval path are designed together instead of being bolted together.
* Compact commitments let the chain anchor large data without becoming the storage layer.
* Retrieval sessions make delivery accountable instead of observational.

### Limits worth acknowledging
* This is a protocol for verifiable storage coordination and retrieval settlement, not a magical universal filesystem.
* Encryption does not remove all metadata leakage by itself.
* Repair, elasticity, and policy need discipline; they are not excuses for uncontrolled complexity.

### Desired closing idea
PolyStore should read as a system that organizes files as PolyFS so real reads can be verified, routed, and paid for under explicit protocol rules.
