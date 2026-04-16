# PolyStore Whitepaper

*Revised Working Draft*

## Abstract

Decentralized storage systems often separate **storage accounting** from **retrieval accountability**. A provider may be paid to “store” data over time, while actual user reads remain loosely attributed, hard to verify end-to-end, and difficult to settle economically. PolyStore collapses those surfaces. In PolyStore, a completed retrieval session is both a service event and a storage proof.

The protocol anchors each Deal generation with one compact on-chain commitment, `manifest_root`, and organizes content as **PolyFS** so that file resolution, proof construction, and reconstruction planning all refer to the same committed structure. Metadata remains replicated, user data is striped across an ordered slot map, and paid reads are opened, verified, and settled against a **pinned generation** rather than a floating notion of “current content.” This supports three distinct verification claims: specific served bytes belong to committed data; enough valid slot contributions existed to reconstruct a requested logical range; and a declared retrieval session completed and may settle.

In PolyStore Core v2.4, the canonical profile described in this paper uses **128 KiB Blobs**, **8 MiB MDUs**, and **RS(8,12)** striping. Blob size and MDU size are fixed protocol constants in the current version, while RS(8,12) is the canonical/default striped profile assumed throughout this document. The architectural model can still generalize across future versions. This paper focuses on the canonical striped retrieval path and situates it within PolyStore’s broader **Unified Liveness** design, in which organic reads and protocol-funded synthetic retrievals share the same accountability surface.

## 1. Executive Summary

### 1.1 The problem

Most decentralized storage systems can show that data was probably retained, but they are weaker at proving that a specific paid read actually happened, that it happened against the correct committed content, and that responsibility for success or failure can be attributed to named providers rather than to a vague pool of “replicas.”

That gap matters. Real users care about reads, not abstract retention. Owners care about who is responsible when a file is slow or unavailable. A protocol that pays for storage but cannot cleanly verify and settle reads leaves the most economically meaningful service event partly outside the protocol’s trust boundary.

### 1.2 PolyStore’s thesis

PolyStore treats **retrieval as the accountable storage event**. The core claim is not that every provider stores a whole file replica or that the chain must replay every byte transfer. The claim is narrower and more useful:

- the chain anchors one compact root per Deal generation;
- PolyFS makes paths, proof lookup, and reconstruction planning refer to the same committed structure;
- user data is striped across an ordered slot map, so responsibility is attached to named slot positions;
- a retrieval session pins both the generation being served and the slot responsibility being exercised; and
- settlement happens only when the protocol has evidence that the declared session completed under that pinned scope.

This design turns a read into something the protocol can authorize, verify, and settle without putting raw files on chain.

### 1.3 Why the chain is necessary

The chain is not a file server. It serves four narrower roles:

1. **Commitment anchor:** store `manifest_root`, the compact root against which proofs verify.
2. **Mutation guard:** enforce compare-and-swap generation updates so concurrent writers cannot silently overwrite each other.
3. **Responsibility ledger:** record the ordered slot assignment that makes provider obligations attributable.
4. **Settlement engine:** enforce session opening, expiry, proof validity, completion conditions, and payout rules.

This is the minimal on-chain surface PolyStore needs to make off-chain bytes economically and cryptographically accountable.

### 1.4 Position in the design space

PolyStore is **not** a consensus-layer data-availability system. It does not claim blanket sampling-based availability for all bytes at all times. It makes a narrower operational claim: for a requested logical range, the protocol can verify that valid slot contributions existed under a pinned generation and were sufficient to reconstruct the requested bytes.

PolyStore is also **not** a replica-only storage market. Accountability is attached to an ordered slot map, not to the idea that “some provider in the set probably had the file.” That distinction is what lets repair, blame, payout, and negative evidence all refer to named slot responsibilities.

### 1.5 Scope of this paper

This paper describes the **canonical striped retrieval-verification path** in PolyStore Core v2.4. It covers immutable Deal generations, PolyFS layout, Triple Proof verification, ordered slot accountability, retrieval sessions, and the Unified Liveness model that reuses the same session surface for ordinary reads and protocol-funded audits.

Broader protocol surfaces—such as service hints, elasticity, rotation, and proxy/deputy mechanics—are summarized where necessary, but they are explicitly distinguished between current behavior and planned policy.

## 2. System Model, Actors, and Threat Model

### 2.1 Actors

| Actor | Role |
|---|---|
| **Owner** | creates or updates a Deal, funds long-lived storage, and controls generation promotion |
| **Requester** | opens a user retrieval session and confirms completion if the read succeeds |
| **Assigned provider** | stores replicated metadata and the shard Blobs for one or more ordered slots; serves bytes and proof material for its slot responsibilities |
| **Gateway / deputy** | optional helper for packing, routing, caching, proof assembly, or reconstruction; useful for UX, but not the trust anchor |
| **Chain** | stores compact commitments and placement state, validates proofs, and enforces session settlement rules |

### 2.2 In-scope failures and adversarial behavior

The protocol is designed to make the following failures attributable or bounded:

- **stale writes** and concurrent writers attempting to replace the wrong generation;
- **slot unavailability**, including row-local outages where some but not all slots are healthy;
- **wrong bytes** or invalid proof material served under a named slot responsibility;
- **malicious or faulty gateways** that proxy traffic but are not trusted for correctness;
- **wash traffic** and fake demand intended to create unearned payout or liveness credit;
- **self-dealing / sybil placement pressure**, where a user attempts to bias storage toward colluding providers;
- **partial delivery**, where some data moves on the wire but the declared session never completes.

### 2.3 Out of scope or deliberately narrower claims

PolyStore does **not** claim that:

- access control alone provides confidentiality;
- metadata leakage disappears;
- one provider should always be able to serve a whole file under the striped path;
- a successful read of one range proves blanket global availability of the whole Deal; or
- a compact root removes all bandwidth, proof, or orchestration cost.

Integrity, reconstructability, and settlement are the primary protocol claims here. Privacy still comes from encryption and application-layer design.

## 3. Unified Liveness and Verification Claims

### 3.1 Retrieval is storage

PolyStore’s broader economic model is **Unified Liveness**: ordinary retrieval sessions count as valid storage proofs. A provider does not earn durable credibility merely by existing in a placement set. It earns credit when the protocol can observe real or synthetic retrieval success under the same proof and settlement model.

This matters for two reasons. First, it ties rewards and health more closely to the service users actually consume. Second, it avoids inventing one trust model for “user reads” and another for “storage proofs.” PolyStore tries to keep them on one accountability surface.

### 3.2 Synthetic retrieval is the fallback for cold data

Organic demand is uneven. Some data is read often; some is cold. PolyStore therefore uses **protocol-funded synthetic retrieval** as a fallback path. The system acts as a “user of last resort” by opening retrieval sessions against cold data when organic reads are insufficient.

The important architectural point is that synthetic retrieval reuses the same core machinery:

- the same pinned `manifest_root`,
- the same slot accountability,
- the same proof path,
- the same completion semantics, and
- the same economic boundary between opened, proved, confirmed, completed, and expired sessions.

Challenge quotas, frequencies, and reward weights are policy-level matters that may evolve. The verification surface stays the same.

### 3.3 Three distinct verification claims

PolyStore makes three separate claims and keeps them separate:

| Verification claim | What the protocol verifies | What the claim does **not** mean |
|---|---|---|
| **Byte-membership / possession verification** | the specific served shard or Blob bytes are committed under the pinned generation | not that one provider can serve the whole Deal by itself |
| **Range reconstructability verification** | enough valid slot contributions existed to reconstruct the requested logical bytes for each affected row | not consensus DA sampling, and not a blanket claim about every row of the Deal at all times |
| **Retrieval settlement verification** | the declared paid session completed under the pinned scope before expiry and may settle | not that every attempt succeeds on the first try or that retries are unnecessary |

### 3.4 Why the distinction matters

These three claims answer different questions:

- “Did these served bytes belong to committed data?”
- “Were there enough valid contributions to reconstruct the requested range?”
- “Did the declared paid session complete and therefore deserve payout?”

Keeping those questions separate makes the protocol more honest. A valid proof over one Blob does not imply global availability. A reconstructable range does not imply that every row of the Deal was healthy. A timed-out session does not imply that the underlying content vanished forever. It means only that the declared session did not complete under protocol rules.

## 4. Protocol Model and Current Profile

PolyStore needs three aligned units: a cryptographic atom, a filesystem/retrieval planning unit, and a slot-accountability profile. In Core v2.4, the relevant constants and roles are:

| Element | Protocol role | Core v2.4 status |
|---|---|---|
| **Blob** | cryptographic atom for KZG verification and Blob-aligned session accounting | **128 KiB**, fixed protocol constant |
| **MDU** | larger filesystem and retrieval-planning unit | **8 MiB**, fixed protocol constant (`64` Blobs) |
| **Stripe profile** | ordered slot accountability and `K`-of-`N` reconstructability | canonical/default profile for this paper: **RS(8,12)** |
| **Metadata policy** | path resolution and proof-index material must remain available from any assigned slot | `MDU #0` plus witness MDUs replicated to all assigned providers |
| **User-data policy** | data-bearing bytes are attributable by slot | per-row shard Blobs stored across the ordered slot map |

Two clarifications matter.

First, **Blob size and MDU size are fixed constants in the current protocol version**. This paper treats them that way. The architecture is parametric only across future protocol versions, not within one live version.

Second, **RS(8,12)** is the canonical profile assumed throughout this document because it is the design center of the current striped model. Constrained devnet or bootstrap deployments may use smaller temporary profiles, but those do not change the conceptual model the paper describes.

## 5. Deal Generations, PolyFS, and Committed State

### 5.1 A Deal is mutable; a generation is not

A `Deal` is the mutable on-chain object that carries ownership, economics, retrieval policy, placement, and the current content commitment. The content itself is not treated as mutable-in-place. Every content change creates a new **generation**.

A live Deal therefore has two kinds of state:

| State type | What it contains |
|---|---|
| **Committed content state** | `manifest_root`, the sequence of committed MDU roots, `total_mdus`, `witness_mdus`, and the PolyFS layout those roots imply |
| **Placement / service state** | the ordered slot map, provider health and repair status, retrieval policy, service hint, and economics |

Only the first category is cryptographically committed by `manifest_root`. The second category is still authoritative state, but it is not “inside” the content root.

### 5.2 Compare-and-swap is the overwrite guard

Every content mutation is a **generation swap**:

- previous `manifest_root = H1`
- new `manifest_root = H2`

The owner’s update intent must include the `previous_manifest_root` it expects to replace. The chain rejects the update unless that expected root still matches the Deal’s current root at execution time.

This does three important things:

1. it prevents stale gateways or clients from overwriting the wrong generation;
2. it makes concurrent writes explicit conflicts rather than silent corruption; and
3. it lets providers and gateways treat staged bytes for `H2` as provisional until the signed chain swap succeeds.

### 5.3 Retrieval sessions pin both content and responsibility

An open retrieval session is bound to:

- a specific Deal,
- a specific pinned `manifest_root`,
- a specific slot/provider responsibility,
- a specific Blob-aligned served range,
- a payer,
- a nonce, and
- an expiry.

Once opened, that session does not float to a newer generation and does not silently retarget to a different provider if repair occurs later. If the Deal advances from `H1` to `H2`, or a slot is replaced, new work happens in a **new** session opened against the new authoritative state.

This separation—content root pinned, slot responsibility pinned—is what keeps reads attributable during concurrent writes, repairs, and retries.

## 6. PolyFS Layout and Striping

### 6.1 One filesystem for paths, proofs, and reconstruction

PolyFS is not just a packing format. It is the committed filesystem that ensures:

- file paths resolve into committed ranges,
- proof lookup refers to committed structure,
- reconstruction planning is derived from the same committed layout, and
- the retrieval path does not need a separate off-ledger index to understand what should be fetched and verified.

That alignment is the reason PolyStore can keep one small on-chain root while still making reads cryptographically accountable.

### 6.2 Layered layout

A PolyFS generation has three logical layers:

| Layer | Function | Placement policy |
|---|---|---|
| `MDU #0` | filesystem anchor: file table, root table, path-resolution metadata | replicated to every assigned provider |
| **Witness MDUs** | replicated proof-index metadata and commitment tables used to assemble proof paths | replicated to every assigned provider |
| **User-data MDUs** | the actual file bytes committed by the generation (typically ciphertext bytes if the client encrypts before upload) | striped across the ordered slot map |

```text
manifest_root
   |
   +-- MDU #0            -> filesystem anchor (replicated)
   +-- witness MDUs      -> proof-index metadata (replicated)
   +-- user-data MDU 0   -> striped rows -> slots 0 .. 11
   +-- user-data MDU 1   -> striped rows -> slots 0 .. 11
   +-- ...
```

Two consequences follow immediately.

First, **logical payload size is not equal to committed layout size**. The committed generation includes `MDU #0` and the witness MDUs in addition to the user payload.

Second, witness MDUs are **supporting metadata**, not an alternative proof target. User-data retrieval still proves inclusion under the target **user-data MDU root**. The witness layer makes the path reproducible from any assigned provider.

### 6.3 User-data striping and accountable leaf space

Each 8 MiB user-data MDU contains 64 logical data Blobs. Under RS(8,12):

- the 64 data Blobs are arranged into **8 rows** of **8 data Blobs** each;
- each row is encoded into **12 shard Blobs**;
- each slot stores one shard Blob per row; and
- the accountable leaf space of one user-data MDU becomes **96 shard-Blob leaves** (`12 * 8`).

```text
one row under RS(8,12)

logical data row:   D0   D1   D2   D3   D4   D5   D6   D7
encoded to slots:   S0   S1   S2   S3   S4   S5   S6   S7   S8   S9   S10  S11
                      |    |    |    |    |    |    |    |    |    |     |     |
                    slot0 ... data slots .......................... parity slots
```

The important design choice is that the **storage atom and proof atom stay aligned**. Providers store complete 128 KiB shard Blobs that can be verified individually.

### 6.4 What `manifest_root` commits to

The chain does not store files or raw shard bytes. It stores `manifest_root`, which commits to the sequence of MDU roots in the current generation.

A verifier therefore asks a narrow deterministic question:

1. which generation root is pinned by the session,
2. which MDU root is committed at the relevant `mdu_index`,
3. which shard/Blob commitment is committed under that MDU root, and
4. whether the served bytes are a valid opening of that shard/Blob commitment.

PolyFS is valuable because file resolution, proof assembly, and reconstruction planning all point at the same committed structure when answering those questions.

### 6.5 Explicit tradeoffs and overhead

PolyStore makes its tradeoffs explicit rather than hiding them inside vague “proof overhead” language.

Let:

- `P` = user payload bytes after alignment into user-data MDUs,
- `F` = metadata bytes (`MDU #0` plus witness MDUs),
- `R = (K+M)/K` = Reed-Solomon expansion factor,
- `N = K+M` = number of slots,
- `A` = number of stripe-aligned placements, with default `A = 1`.

Then the main footprint split is:

```text
committed generation bytes:         G  = P + F
one stripe-set stored footprint:    S1 ≈ R*P + N*F
A stripe-set stored footprint:      SA ≈ A * (R*P + N*F)
```

This separates three costs cleanly:

- **metadata overhead** from `MDU #0` and witness MDUs;
- **striping overhead** from parity expansion;
- **scaling overhead** from optional extra stripe-aligned placements.

The most important operational tradeoff is **row-local read amplification**. In RS(8,12), reconstructing any bytes inside one row may require fetching **8 verified shard Blobs** for that row—even if the user asked for less than the row’s full logical 1 MiB. PolyStore does not hide that cost. It accepts it as the explicit price of `K`-of-`N` outage tolerance, parallel retrieval, and slot-specific accountability.

## 7. Triple Proof Architecture

PolyStore’s proof system is a **Triple Proof**: a chained verification path from the Deal’s compact on-chain root to the served bytes.

```text
manifest_root
   -- KZG opening at mdu_index -->
target MDU root
   -- Merkle inclusion at leaf_index -->
shard / Blob commitment
   -- KZG opening -->
served bytes or challenged evaluation
```

### 7.1 Hop 1: `manifest_root` to target MDU root

The first hop proves that the relevant MDU root is committed inside the pinned generation at the claimed `mdu_index`.

This is the deal-level identity check. It answers: “Is this the right committed MDU for the generation the session pinned?”

### 7.2 Hop 2: target MDU root to shard/Blob commitment

The second hop proves that the relevant shard/Blob commitment is a leaf under the **target MDU root**.

This is where witness MDUs often cause confusion. They carry replicated commitment tables and auxiliary data that help any assigned provider assemble the correct proof path. They do **not** change the object being proven. The second hop always terminates at the target MDU root.

### 7.3 Hop 3: shard/Blob commitment to served bytes

The third hop proves that the served bytes—or the challenged evaluation within the served Blob, depending on the message surface—are a valid KZG opening of the relevant Blob commitment.

For user reads, this happens per served shard Blob. Once the client has `K` valid shard Blobs for a row, it can decode that row and extract the requested logical bytes.

### 7.4 Why this stays compact

The chain needs only the compact root and the proof objects relevant to the declared session or challenge. It does **not** need to store whole files or replay an entire retrieval data plane.

That is the central efficiency boundary in PolyStore:

- proof verification stays at Blob-sized units;
- reconstruction happens locally and row-by-row;
- the chain arbitrates compact commitments and settlement state, not raw object transport.

## 8. System-Defined Placement and Provider Accountability

### 8.1 Ordered slot maps, not vague replica sets

PolyStore’s canonical placement model is an **ordered slot map** of length `N = K+M`. Metadata is replicated to every assigned provider. User-data MDUs are striped across slots.

This means the accountable question is never just “was one of the replicas available?” It is “which slot was responsible for which shard contribution under this pinned generation?”

That distinction is what makes blame, retry, repair, and payout attributable.

### 8.2 Why placement is system-defined

Users do not directly choose their own slot map. Placement is chain-controlled over an eligible provider set and may be biased by service hints and diversity rules.

The rationale is straightforward:

- **anti-self-dealing:** reduce trivial collusive placement;
- **failure-domain diversity:** avoid placing all responsibility inside one correlated environment;
- **clear accountability:** map each shard responsibility to a named slot;
- **deterministic replacement:** make repair and rotation legible rather than ad hoc.

This does not magically solve sybil behavior. Economic and governance safeguards are still required. But it materially improves the protocol’s accountability surface.

### 8.3 Provider obligations

A provider assigned to slot `s` has four concrete obligations for a pinned generation:

1. store the replicated metadata MDUs for that generation;
2. store the shard Blobs that belong to slot `s` for every user-data MDU;
3. serve those shard Blobs and the relevant replicated proof-index metadata when a valid session names slot `s`; and
4. submit proof-of-retrieval material attributable to slot `s`.

Under the striped path, a provider is not primarily responsible for “serving the whole file.” It is responsible for serving the shard contribution owned by its named slot.

### 8.4 Repair and replacement

Repair and replacement do not retroactively mutate in-flight accountability.

If a slot is marked repairing, reads should route around it and retrieve from any other healthy `K` slots for the affected rows. If a replacement provider later becomes the authoritative holder for that slot, new retrieval work must happen through **new sessions** opened against the new active responsibility. Open sessions do not silently migrate.

Operationally, the preferred replacement model is **make-before-break**: do not release the old responsibility until the replacement has demonstrated readiness against the current generation. That broader policy is part of PolyStore’s self-healing placement model even where exact automation remains a protocol target rather than a fully hardened current implementation.

## 9. Publishing a Generation

PolyStore treats publication as a two-phase process: **staged placement off-chain** followed by **generation promotion on-chain**.

### 9.1 Step 1: prepare the candidate generation

The client or owner packs files into PolyFS, computes user-data and witness structure, derives the MDU roots, and computes the candidate `manifest_root`.

The determinism claim here should be stated precisely: given the same committed bytes, layout rules, encryption/compression choices, and profile, honest implementations should derive the same commitments.

### 9.2 Step 2: stage bytes to the assigned providers

The candidate generation is uploaded as provisional bytes:

- `MDU #0` and the witness MDUs go to every assigned provider;
- each user-data MDU is RS-encoded into per-slot shard Blobs; and
- each slot owner receives only the shard Blobs for its slot.

These artifacts are addressed by Deal, generation root, MDU index, and slot (or an equivalent canonical key). The previously promoted generation remains the live one during this phase.

### 9.3 Step 3: distinguish structural validity from service readiness

Before promotion, the system should distinguish two different checks:

- **structural validity:** the artifact set is internally coherent and hashes to the claimed `manifest_root`;
- **service readiness:** the assigned providers have actually received the bytes they are expected to serve.

The chain anchors the first property through the promoted root. The second is operational and should be checked by deployment policy before promotion. Typical readiness evidence includes provider acknowledgements for replicated metadata and sample fetch-and-verify checks over staged shard Blobs.

### 9.4 Step 4: promote via compare-and-swap

To make the candidate generation current, the owner submits an update intent naming both the expected previous root and the new root. The chain promotes the new root only if the previous root still matches the Deal’s current root at execution time.

This is the authoritative overwrite guard. Providers and gateways may perform advisory preflight checks, but those checks do not replace the chain’s compare-and-swap rule.

### 9.5 Step 5: keep provisional and current generations distinct

Until the chain swap succeeds, the old promoted generation remains the authoritative current generation. The newly uploaded bytes are **provisional**.

This distinction prevents a failed or stale update from quietly changing what readers should treat as current. Abandoned provisional generations are a real storage-churn and cleanup concern, but they are an operational concern, not an ambiguity in authoritative state.

## 10. Canonical Retrieval Path

A user-visible file read follows one canonical sequence.

### 10.1 Resolve the requested range from committed metadata

The client reads cached or freshly served replicated metadata (`MDU #0` plus witness MDUs), either from prior verified cache or via ordinary metadata retrieval sessions, and resolves `file_path` into the affected user-data MDUs and logical byte ranges.

For metadata-only reads, no Reed-Solomon reconstruction is needed because metadata is replicated.

### 10.2 Choose any `K` healthy slots for each affected row

For every affected user-data MDU row, the client selects any `K` healthy ACTIVE slots. The requested logical byte range is then translated into the shard-Blob ranges required from those slots.

The accountable object is not “the user’s file range” in the abstract. It is the concrete set of served Blob-aligned shard ranges attributable to named slots.

### 10.3 Open slot-scoped retrieval sessions

The client opens one or more retrieval sessions bound to:

- `deal_id`,
- slot / provider responsibility,
- pinned `manifest_root`,
- served Blob-aligned range,
- payer,
- nonce, and
- `expires_at`.

The session pins the exact generation root observed at open time. It also pins the slot responsibility being exercised.

### 10.4 Fetch shard data and proof material

The client fetches the requested shard Blobs from the chosen providers. A gateway may proxy, route, batch, or reconstruct these calls for convenience, but correctness remains anchored in direct proof verification against the pinned root.

### 10.5 Verify, decode, and return the requested bytes

For each served shard Blob, the client verifies the Triple Proof path back to `manifest_root`. Once it has `K` valid shard Blobs for a row, it decodes the row locally and extracts the requested logical bytes.

This is the canonical user-data path:

1. verify individual served shard Blobs,
2. decode rows from any `K` healthy slot contributions,
3. extract the requested logical subrange, and
4. confirm completion only if the declared session actually succeeded.

### 10.6 What counts as availability evidence

The protocol’s availability evidence is **operational and range-scoped**. If the client can verify `K` valid shard contributions for every affected row and reconstruct the requested bytes under one pinned generation, then that requested range was available.

This is deliberately narrower than saying “the whole Deal is globally available.” It is evidence about a requested range, a pinned generation, and named slot responsibilities.

Negative evidence comes from the same model in reverse. Expired sessions, invalid proof paths, and attributable non-response from named slots are all evidence that the requested range could not be reconstructed under the declared session scope.

## 11. Retrieval Sessions and Settlement

### 11.1 Session fields and funding modes

A retrieval session binds the minimum control-plane data needed to make service attributable:

- Deal identity,
- slot/provider identity,
- pinned `manifest_root`,
- served Blob-aligned range,
- payer,
- nonce,
- expiry.

PolyStore supports three economic openings for that same session surface:

- **owner-paid** user sessions,
- **requester-paid / sponsored** user sessions, and
- **protocol-paid** sessions for audit, repair, or healing flows.

That split matters because public or third-party retrieval should not silently drain the owner’s long-lived storage escrow. A public read is accountable only if its funding source is explicit.

### 11.2 Completion is proof plus confirmation before expiry

A session reaches `COMPLETED` only when the protocol has evidence of **both**:

1. provider proof material covering the full declared served range under the pinned scope; and
2. requester confirmation before `expires_at`.

Neither condition is sufficient on its own. Proof without requester confirmation is not completed service. Confirmation without valid proof is not completed service either.

This rule is what turns “bytes probably moved” into a settleable service event.

### 11.3 Failure semantics

The main failure rules are intentionally simple:

- **partial transfer is operationally useful but not settleable by itself;**
- **invalid proof material does not advance session state;**
- **missing confirmation means no completion payout;**
- **expired sessions stay expired even if some bytes moved earlier;**
- **retries are explicit:** a client opens new sessions against alternate healthy slots rather than mutating the existing one;
- **deal updates do not retarget open sessions:** an in-flight session stays pinned to the generation it opened against.

A compact state summary is included in Appendix A.

## 12. Unified Liveness, Audit Path, Economics, and Security Boundaries

### 12.1 Organic retrievals as storage proofs

Completed retrieval sessions are the primary liveness evidence PolyStore wants to reward. Instead of treating storage audits and user reads as separate universes, the system treats successful reads as valid storage evidence.

At the policy layer, this means user retrieval activity can reduce synthetic proof demand for active data. The exact quota function is protocol policy and may evolve, but the architectural point remains: **real reads are first-class liveness evidence**.

### 12.2 Protocol-funded synthetic retrieval for cold data

Cold data still needs accountability. PolyStore therefore opens protocol-funded retrieval sessions as a fallback path when organic demand is insufficient.

The system is effectively a “user of last resort.” It chooses rows or Blob-aligned targets, opens protocol-paid sessions, verifies the same Triple Proof path, and attributes success or failure to the same slot map.

This is preferable to inventing a second proof system for cold-data audits because it keeps accountability uniform.

### 12.3 Retrieval pricing and settlement

Under the current fee-oriented model, retrieval pricing has two parts:

- a **base anti-spam fee** at session open; and
- a **variable per-Blob fee** locked at session open and paid only on completion.

If the session completes, the variable portion settles according to protocol rules and the provider is paid for real verified service. If the session expires without completion, the provider does not receive the completion payout.

This makes service economically legible. PolyStore does not pay for a vague claim that a provider “was probably available.” It pays for a session that completed under a pinned scope.

### 12.4 Security and trust boundaries

PolyStore’s integrity model and privacy model are separate.

**Anti-sybil posture.** System-defined placement, diversity rules, and bounded assignment reduce trivial self-dealing, but they do not eliminate sybil behavior by themselves. Economic and governance safeguards still matter.

**Anti-wash posture.** Retrieval openings have explicit payers, nonces, expiries, and session scope. Public or third-party retrievals must use explicit requester-funded or sponsored sessions. Fake traffic therefore consumes real budget instead of producing free signaling.

**Privacy boundary.** Integrity comes from the Triple Proof path. Confidentiality comes from client-side encryption. Access control governs who may open user sessions; it is not a privacy guarantee. Providers may still learn timing, sizes, and placement metadata unless higher-level mitigations are added.

**Gateway boundary.** Gateways and deputies may improve UX, routing, or caching, but they are helpers, not trust anchors. Correctness must survive a faulty gateway because the client and chain both verify against the same compact root.

## 13. Performance Thesis and Implementation Status

### 13.1 Why work stays bounded

PolyStore’s performance claim is intentionally modest. It is not that coding or KZG eliminates cost. It is that the work is **bounded at Blob-sized and row-local units** instead of at whole-file scale.

- providers prove the shard Blobs they actually store;
- clients verify the specific shard Blobs they fetch;
- Reed-Solomon decoding is local to affected rows and can be parallelized;
- the chain verifies compact proofs and session state instead of replaying full retrievals.

The remaining costs are real:

- proof generation and verification,
- proof transport bandwidth,
- parity overhead,
- row-local decode work, and
- read amplification for narrow logical ranges.

PolyStore’s claim is that these costs are explicit and composable, not hidden inside opaque replica accounting.

### 13.2 Current implementation vs. planned protocol surface

The current protocol and implementation surface should be stated honestly:

| Area | Current / design-center behavior | Planned or policy-evolving surface |
|---|---|---|
| **Striped PolyFS layout** | current design center | — |
| **128 KiB Blob / 8 MiB MDU constants** | current protocol constants | future protocol versions could revise them |
| **Compare-and-swap generation updates** | current design center | richer non-append mutation flows may expand later |
| **Retrieval sessions with proof + confirmation completion** | current direction and devnet settlement model | batching/aggregation may evolve |
| **Owner-paid, requester-paid, and protocol-paid session openings** | current conceptual model | policy details may evolve |
| **Unified Liveness framing** | current architecture | quota functions and reward weights remain policy work |
| **Repair / make-before-break replacement** | architectural target | exact automation and rotation policy still evolving |
| **Deputy / proxy retrieval** | anticipated helper model | explicit delegation and compensation remain future RFC work |
| **Elastic stripe-aligned overlay scaling** | broader protocol direction | not yet modeled end-to-end in a hardened implementation |

This paper therefore uses strong language about **architecture** and more careful language about **current empirical performance** or **fully automated policy**.

### 13.3 Benchmark plan

A public whitepaper should not overclaim before measurements exist. The right next benchmarks are:

- PolyFS build throughput;
- RS encode and decode throughput by profile;
- provider-side proof generation time per served Blob;
- client and chain-side proof verification time per served Blob;
- proof object size per served Blob;
- metadata overhead as a percentage of payload size;
- aggregate retrieval throughput versus number of selected healthy slots;
- retrieval success rate under row-local slot outages; and
- stored-footprint multiplier under explicit extra stripe-aligned placements.

Until those measurements are published, the safest language is architectural rather than heavily benchmarked.

## 14. Worked Example

Consider a Deal whose raw application payload is **64 MiB**.

### 14.1 Layout and commitment

Under the current 8 MiB MDU profile, the payload occupies **8 user-data MDUs**. PolyFS then adds:

- `MDU #0` for filesystem metadata; and
- one or more witness MDUs for proof-index metadata.

The committed generation is therefore larger than 64 MiB. The 64 MiB number refers only to payload bytes, not to the full committed PolyFS layout.

### 14.2 Placement

Each of the 8 user-data MDUs is striped under RS(8,12):

- 64 logical data Blobs per user-data MDU,
- 8 rows per user-data MDU,
- 12 shard Blobs per row,
- 12 ordered slot responsibilities.

Every assigned provider receives all replicated metadata MDUs. The provider assigned to slot `s` also receives the shard Blobs for slot `s` across all 8 user-data MDUs.

### 14.3 Promotion

The owner stages the candidate generation to the assigned providers, verifies that the prepared artifact set hashes to generation root `H1`, and submits a compare-and-swap update from the previous Deal root to `H1`. Once that update succeeds, `H1` becomes the current generation.

### 14.4 Retrieval

A reader later requests a **256 KiB** range that lies inside a single logical row of one user-data MDU.

The client:

1. resolves the file path and byte range from replicated metadata under generation `H1`;
2. chooses any 8 healthy slots for the affected row;
3. opens 8 slot-scoped sessions, one for each chosen slot, all pinned to `H1`;
4. fetches 8 shard Blobs, one from each chosen slot; and
5. verifies those 8 proof paths, decodes the row, and extracts the requested 256 KiB.

This example makes one important tradeoff concrete. Because one RS(8,12) row carries **8 logical data Blobs = 1 MiB** of logical row data, the client may need to fetch **8 shard Blobs = 1 MiB of encoded shard data**, plus proof objects, even though the user requested only 256 KiB. That is the row-local amplification cost discussed earlier.

### 14.5 Failure and retry

Assume one chosen slot times out before expiry. The client does not mutate the failed session. Instead, it opens a **new session** against another healthy slot and fetches that slot’s shard Blob for the same pinned generation and row.

The failed session remains attributable to the original slot and either later completes or expires unpaid. The replacement session is independently attributable and independently settleable.

This example captures the whole design:

- one immutable pinned generation,
- replicated metadata plus striped user data,
- ordered slot responsibility,
- per-shard proof verification,
- row-local decode,
- explicit outage tolerance, and
- explicit retry and settlement semantics.

## 15. Conclusion

PolyStore makes one focused architectural bet: the unit that storage commits to, the unit that retrieval verifies, and the unit that settlement pays for should line up.

It achieves that by combining:

- immutable Deal generations anchored by `manifest_root`,
- PolyFS as one committed filesystem for paths, proofs, and reconstruction planning,
- ordered slot accountability for striped user data,
- Triple Proof verification from the compact root to served bytes, and
- retrieval sessions that pin scope and settle only on real completed service.

The result is not consensus-style global data availability, and it is not vague replica accounting. It is a different model: a decentralized storage protocol in which reads are cryptographically attributable, operationally reconstructable, and economically settleable without placing raw files on chain.

That is the core claim of PolyStore: **a small root, explicit slot responsibility, direct verification, `K`-of-`N` resilience, and paid reads tied to real service.**

## Appendix A. Retrieval Session State Summary

The main text intentionally keeps session mechanics concise. The state summary below captures the essential rule:

```text
OPEN
 ├─ provider submits valid proof for the full declared range ─────▶ PROVED
 ├─ requester submits completion confirmation ────────────────────▶ CONFIRMED
 ├─ expires_at reached before both conditions are true ───────────▶ EXPIRED

PROVED
 ├─ requester confirms before expiry ─────────────────────────────▶ COMPLETED
 └─ expires_at reached first ─────────────────────────────────────▶ EXPIRED

CONFIRMED
 ├─ provider submits valid proof before expiry ──────────────────▶ COMPLETED
 └─ expires_at reached first ─────────────────────────────────────▶ EXPIRED
```

`COMPLETED` and `EXPIRED` are terminal from the protocol-verification perspective. Economic refund or unlock logic may run after expiry, but it does not change the fact that the declared session did not complete.

## Appendix B. Terminology Summary

| Term | Meaning in this paper |
|---|---|
| **Blob** | 128 KiB cryptographic atom for verification and session accounting |
| **MDU** | 8 MiB retrieval and filesystem planning unit (`64` Blobs) |
| **Deal** | mutable on-chain object that names owner, economics, policy, placement, and current generation |
| **Generation** | immutable committed snapshot of Deal content identified by a specific `manifest_root` |
| **Slot** | ordered provider responsibility in an RS-striped row |
| **Triple Proof** | chained proof from `manifest_root` to the served bytes |
| **Pinned generation** | the exact `manifest_root` a session opened against |
| **Range reconstructability** | the ability to reconstruct the requested logical bytes from any `K` healthy slot contributions for each affected row |