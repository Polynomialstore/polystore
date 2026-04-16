# PolyStore Whitepaper

*Working Draft*

## Abstract

PolyStore is a decentralized storage protocol whose canonical object is a **versioned Deal generation** committed on chain by a compact `manifest_root`. A generation packages content as **PolyFS**: one filesystem anchor MDU, a replicated witness layer, and striped user-data MDUs. Retrieval is not modeled as an unstructured off-chain side effect. In the canonical striped protocol, a user-visible file read is decomposed into one or more **slot-scoped retrieval sessions** against a pinned Deal generation and a pinned slot responsibility. The client resolves the file path from replicated metadata, fetches the required shard Blobs from any `K` healthy slots for each affected row, verifies each shard with a chained proof back to `manifest_root`, and locally Reed-Solomon decodes the requested bytes. Completed sessions drive settlement and liveness; when organic demand is absent, the protocol can open the same session type for synthetic audits.

This paper defines the version model, layout model, placement model, retrieval lifecycle, proof path, and economic boundaries of that design. It also separates protocol invariants from the **current deployment profile**. The profile in active use today—128 KiB Blobs, 8 MiB MDUs, and RS(8,12)—is one instantiation of the architecture, not the architecture itself.

## 1. Scope and Terminology

This whitepaper describes the **canonical striped protocol**. Historical full-replica deals may remain readable as a compatibility path, but they are not the design center here. Unless a section explicitly says otherwise, “retrieval” means **slot-aware striped retrieval** and “provider responsibility” means responsibility for a named slot in an ordered slot map.

Four terms are used precisely throughout:

- **Deal:** the on-chain object that names the owner, economics, retrieval policy, current generation, and current slot assignment.
- **Generation:** an immutable snapshot of Deal content, identified by a specific `manifest_root` and the associated PolyFS layout it commits to.
- **Slot:** an ordered provider responsibility in an RS(`K`,`K+M`) stripe. A provider is accountable because it owns one or more slots, not because it is vaguely “one of the replicas.”
- **Retrieval session:** the accountable control-plane object that binds a read to a Deal, a pinned generation, a slot responsibility, a served Blob range, a payer, and an expiry.

The phrase **current `manifest_root`** therefore has one narrow meaning: the latest promoted generation of the Deal. It is a lookup rule for *new* reads and *new* writes. It is **not** a floating reference inside an already-open retrieval session.

## 2. Protocol Invariants vs. Current Deployment Profile

The protocol needs a fixed cryptographic atom, a fixed retrieval/layout unit, and a fixed slot accountability model. The exact numbers are a deployment profile.

| Element | Protocol role | Current deployment profile |
|---|---|---|
| Blob | cryptographic atom for KZG openings and session accounting | 128 KiB |
| MDU | larger layout and retrieval planning unit | 8 MiB = 64 Blobs |
| Stripe profile | reconstruction and slot accountability | RS(8,12) |
| Metadata policy | path resolution and proof lookup must remain available from any assigned slot | `MDU #0` + witness MDUs replicated to all assigned providers |
| User-data policy | data-bearing MDUs are accountable by slot, not by opaque replica | striped shard storage across the ordered slot map |

The architecture does **not** depend on those exact numbers, but it **does** depend on the separation of roles above. A future profile could change the Blob size, MDU size, or RS parameters without changing the conceptual model, provided the cryptographic atom, retrieval planner, and accountability logic remain aligned.

## 3. Deal State as Versioned Snapshots

A Deal is a mutable on-chain object, but the content it points to is not treated as mutable in place. Each content change creates a **new generation**.

Conceptually, a generation is the tuple:

`(manifest_root, total_mdus, witness_mdu_count, PolyFS layout, slot assignment in force at promotion time)`

The whitepaper relies on the following rules:

1. **Generations are immutable once promoted.** If a Deal moves from generation `H1` to `H2`, the protocol does not reinterpret `H1`; it creates a new current snapshot.
2. **Retrieval sessions pin a specific generation.** A session opened against `H1` continues to verify against `H1`, even if the Deal later advances to `H2`.
3. **Slot responsibility is pinned at session open.** If a slot is later repaired or reassigned, that does not retarget an open session. A replacement provider serves through a new session bound to the new slot responsibility.
4. **Writes use compare-and-swap semantics.** A content update must name the previous `manifest_root` it expects to replace. If the Deal has advanced in the meantime, the update is stale and must fail.

These rules solve two structural problems at once. They prevent concurrent writers from silently overwriting each other, and they prevent an open retrieval from becoming ambiguous when content or placement changes during service.

## 4. PolyFS Layout and Commitment Model

PolyFS is the canonical layout of a Deal generation. Its purpose is not simply to pack files neatly; its purpose is to ensure that file resolution, cryptographic proof generation, and retrieval accounting all refer to the same committed structure.

### 4.1 Layered PolyFS layout

| Layer | Function | Placement policy |
|---|---|---|
| `MDU #0` | filesystem anchor: file table, root table, and path-resolution metadata | replicated to every assigned provider |
| Witness MDUs | replicated proof index: commitment tables and auxiliary metadata needed to assemble inclusion paths efficiently | replicated to every assigned provider |
| User-data MDUs | data-bearing MDUs containing the file bytes (typically ciphertext bytes if the client encrypts before upload) | striped across the ordered slot map |

Two clarifications matter.

First, **logical payload size is not the same thing as committed layout size**. A 64 MiB file payload occupies 8 user-data MDUs under the current 8 MiB MDU profile, but the committed generation is larger than 64 MiB because `MDU #0` and the witness MDUs are additional committed state.

Second, witness MDUs are **not** an alternative proof target. They are replicated indices that make proof construction practical. The second hop of the chained proof for a user-data read still proves that a shard-Blob commitment is a leaf under the **target user-data MDU root**. The witness layer exists so any assigned provider can supply the commitment tables and inclusion material needed to assemble that proof path without relying on a privileged coordinator.

### 4.2 User-data striping

Each user-data MDU contains 64 logical data Blobs in the current profile. Under an RS(`K`,`K+M`) stripe:

- the 64 logical Blobs are arranged into `64 / K` rows,
- each row is encoded across `N = K+M` slots,
- each slot stores one shard Blob per row, and
- the accountable leaf space of the user-data MDU becomes `L = N * (64 / K)` shard Blobs.

For the current RS(8,12) profile, that means:

- `K = 8`, `M = 4`, `N = 12`,
- there are `64 / 8 = 8` rows per user-data MDU,
- each row produces 12 shard Blobs, and
- each user-data MDU exposes `12 * 8 = 96` accountable shard-Blob leaves.

The important point is not the arithmetic. The important point is that the proof atom and the storage atom stay aligned: every provider stores complete 128 KiB shard Blobs that can be individually verified.

### 4.3 What `manifest_root` commits to

The chain does not store whole files. It stores a compact `manifest_root` that commits to the sequence of MDU roots in the generation. That commitment is the only on-chain trust anchor needed for retrieval verification.

A verifier therefore asks a narrow, deterministic question:

1. which generation root is pinned by the session,
2. which MDU root is committed at the requested `mdu_index`,
3. which shard-Blob commitment is committed under that MDU root, and
4. whether the served shard bytes are a valid opening of that shard-Blob commitment.

That is the entire verification spine of the protocol.

## 5. Placement Model and Provider Responsibilities

PolyStore’s canonical placement model is an **ordered slot map** of length `N = K+M`. Metadata is replicated across all assigned providers. User-data MDUs are striped across slots.

A provider assigned to slot `s` has four concrete obligations:

1. store the replicated metadata MDUs for the generation;
2. store the shard Blobs that belong to slot `s` for every user-data MDU;
3. serve those shard Blobs, plus the replicated proof-index metadata, when a valid session names slot `s`; and
4. submit proof-of-retrieval material attributable to slot `s`.

This is a narrower claim than “the provider serves the file.” In the canonical striped protocol, a provider serves **its shard contribution** to the file. The file emerges from the client’s verified reconstruction across `K` healthy slots.

That distinction is structural. A single provider may serve all replicated metadata for path resolution. A single provider may also serve an old full-replica deal for compatibility. But for new striped user-data reads, the protocol’s accountable unit is the **slot contribution**, not the whole file response.

## 6. Ingest, Staging, and Generation Promotion

The upload path matters because `manifest_root` becomes the on-chain anchor for all later verification. PolyStore treats content publication as a two-phase process: **off-chain staged placement** followed by **on-chain generation promotion**.

### 6.1 Step 1: prepare the candidate generation

The owner or client packs the files into PolyFS, computes the MDU roots, computes the witness layer, and derives the candidate `manifest_root`. This step is deterministic. Any honest implementation given the same files, profile, and previous generation should derive the same committed structure.

### 6.2 Step 2: stage bytes to the assigned providers

The client uploads the candidate generation as provisional bytes:

- `MDU #0` and witness MDUs go to every assigned provider;
- each user-data MDU is RS-encoded into per-slot shard Blobs; and
- each slot owner receives only the shard Blobs for its slot.

Providers address those bytes by `(deal_id, manifest_root, mdu_index, slot)` or the equivalent storage key. The current promoted generation remains the live generation during this phase.

### 6.3 Step 3: apply preflight and readiness checks

A provider or gateway may reject a staged upload if the client’s expected base generation is stale. This is an off-chain preflight analogue of compare-and-swap. It prevents the client from spending bandwidth staging a new generation on top of the wrong base.

The chain does **not** directly verify that every provider has received every byte before promotion. Instead, PolyStore separates:

- **structural validity**, which is deterministic from the prepared PolyFS layout and can be checked locally before commit; from
- **service readiness**, which is established operationally by staged placement and later enforced by retrieval and liveness proofs.

A bad commit can therefore anchor an unusable generation if the owner promotes bytes that were never properly staged. What it cannot do is later produce valid retrieval proofs or earn provider credit. Deployments should therefore require readiness checks before promotion, but those checks are not the same thing as the on-chain commitment itself.

### 6.4 Step 4: promote the generation on chain

To make the candidate generation current, the owner submits an update intent that names both the previous `manifest_root` and the new `manifest_root`. The chain promotes the new root only if the previous root still matches the Deal’s current root at execution time.

This compare-and-swap rule is the authoritative overwrite guard. It prevents concurrent writers, stale gateways, or stale local caches from silently replacing the wrong generation.

### 6.5 Step 5: retain current vs. provisional generations correctly

Until the compare-and-swap succeeds, the previously promoted generation remains readable. The newly uploaded bytes are provisional. If promotion fails, the provisional bytes may later be garbage-collected under policy; they do not retroactively become the live Deal state.

## 7. Canonical Retrieval Path

A user-visible file read proceeds in five deterministic stages.

### 7.1 Resolve the logical file range

The client reads replicated metadata (`MDU #0` plus witness MDUs) from any assigned provider and resolves `file_path` into the affected user-data MDUs and logical Blob ranges.

### 7.2 Plan the served shard ranges

For each affected user-data MDU row, the client chooses any `K` healthy slots. The logical file range is then translated into the **served shard-Blob ranges** needed from those slots. The accountable unit is the served shard range, not the original file byte range.

### 7.3 Open slot-scoped retrieval sessions

The client opens one or more retrieval sessions, each bound to:

`(deal_id, slot, provider, manifest_root, served blob-range, payer, nonce, expires_at)`

The session is pinned to the exact generation root observed at open. It is also pinned to the named slot responsibility. Sessions are immutable once opened.

### 7.4 Fetch shard Blobs and proof material

The client fetches the requested shard Blobs directly from the chosen providers. A gateway may proxy or bundle those fetches for convenience, but it is not a trust anchor. Direct-to-provider retrieval remains first-class.

### 7.5 Verify, decode, and return the requested bytes

For each served shard Blob, the client verifies the chained proof back to `manifest_root`. Once it has `K` valid shard Blobs for a row, it Reed-Solomon decodes that row and extracts the requested file bytes.

For metadata-only reads, no RS reconstruction is needed because the metadata MDUs are replicated. For user-data reads, `K`-slot reconstruction is the canonical path.

## 8. Retrieval Sessions: Lifecycle and Failure Semantics

The retrieval session is the protocol object that makes a read billable, attributable, and settleable. The paper models the lifecycle explicitly.

### 8.1 Session fields

A session binds the minimum information needed to make a served shard range accountable:

- Deal identity;
- slot and provider responsibility;
- pinned `manifest_root`;
- served Blob range in the provider’s accountable leaf space;
- payer;
- nonce; and
- expiry.

The served range is Blob-aligned because pricing and proofs operate at Blob granularity. For striped user-data MDUs, the range is expressed in the encoded shard-leaf space of the named slot, not in the user’s original file-byte coordinates.

### 8.2 State machine

Conceptually, the lifecycle is:

```text
OPEN
 ├─ provider submits valid proof for the full declared range ─────▶ PROVED
 ├─ requester submits completion confirmation ────────────────────▶ CONFIRMED
 ├─ expires_at reached before both conditions are true ───────────▶ EXPIRED

PROVED
 ├─ requester submits completion confirmation before expiry ──────▶ COMPLETED
 └─ expires_at reached first ──────────────────────────────────────▶ EXPIRED

CONFIRMED
 ├─ provider submits valid proof for the full declared range ─────▶ COMPLETED
 └─ expires_at reached first ──────────────────────────────────────▶ EXPIRED
```

`COMPLETED` and `EXPIRED` are terminal from the verification perspective. Unlocking or refunding locked funds after expiry is an economic action applied to an expired session; it does not change what happened on the data plane.

Three consequences follow.

**Partial fulfillment does not settle.** A provider may serve multiple responses within one session, and a client may receive some but not all of the declared shard range. That is operationally useful, but the session reaches `PROVED` only when valid proof material covers the **entire** declared range.

**Confirmation is necessary but not sufficient.** User confirmation without valid proof does not complete the session. Valid proof without user confirmation does not complete the session either. Completion is the conjunction of both conditions before expiry.

**Retries are explicit.** If a provider times out, serves the wrong bytes, or disappears, the client opens new sessions against alternate healthy slots. The existing session is not retargeted. It either completes as opened or it expires.

### 8.3 Failure and dispute semantics

The whitepaper assumes the following failure behavior:

- **Absent confirmation:** no provider payout and no completed session credit.
- **Invalid proof submission:** no state advance; the invalid proof may become slashable evidence, but it does not make the session “partially complete.”
- **Wrong bytes with failing proof path:** the client rejects the bytes and may convert the failed response into fraud evidence.
- **Expiry without completion:** the provider is unpaid for that session; locked variable fees are handled by policy, but the session itself is simply expired.
- **Deal update while session is open:** the session remains bound to the pinned generation root from open time; it does not migrate to the newer generation.

Under this model, there is no optimistic completion, no floating “latest root” reference inside an open read, and no implicit retry semantics.

## 9. Chained Proof Architecture

PolyStore’s retrieval claim is narrow: a verifier can check a served shard Blob against a compact on-chain generation root.

For a striped user-data read, the proof path is:

```text
manifest_root
   -- KZG opening at mdu_index -->
target MDU root
   -- Merkle inclusion at leaf_index -->
shard-Blob commitment
   -- KZG opening -->
served shard bytes
```

### 9.1 Hop 1: manifest commitment to target MDU root

The first hop proves that the relevant MDU root is committed inside the generation’s `manifest_root` at the claimed `mdu_index`.

### 9.2 Hop 2: target MDU root to shard-Blob commitment

The second hop proves that the shard-Blob commitment for the served shard is a leaf under the **target MDU root**. This is where the witness layer often causes confusion.

The witness MDUs carry the replicated commitment tables and auxiliary data from which the inclusion path can be assembled. They make proof lookup and assembly practical. They do **not** change what is being proven. The second hop always terminates at the target MDU root that Hop 1 opened from `manifest_root`.

### 9.3 Hop 3: shard-Blob commitment to served shard bytes

The third hop proves that the served shard bytes are a valid opening of the shard-Blob commitment itself.

For a logical file read, this verification happens per served shard Blob. Once the client has verified `K` shard Blobs for a row, it can decode the row and reconstruct the requested logical bytes. The chain never needs the full file as a verification object.

## 10. Economics, Synthetic Challenges, and Security Boundaries

### 10.1 Retrieval pricing and payout

Retrieval is paid through sessions, not through informal reputation. In the current fee-oriented model:

- opening a session burns a base anti-spam fee;
- opening a session also locks a variable fee proportional to the declared Blob count;
- a provider is paid only when the session reaches `COMPLETED`; and
- if the session expires without completion, the variable portion is handled by refund/unlock rules rather than provider payout.

This matters because it makes real reads economically legible. A provider does not get credit for vague availability claims. It gets credit for a completed, user-authorized, proof-backed session.

### 10.2 Synthetic challenge path

The protocol still needs a way to test cold data. The **synthetic challenge path** is therefore not a separate proof system. It is the same session and proof model used without organic user demand.

When data is cold, the protocol can act as a “user of last resort” by opening protocol-funded, slot-scoped retrieval sessions against randomly derived rows or leaf indices. Those sessions use the same pinned-generation semantics, the same chained proofs, and the same slot accountability. They differ only in who pays and who is acting as the requester.

This is the correct way to understand synthetic challenges in PolyStore: not as a parallel trust model, but as the same retrieval model applied to audit demand.

### 10.3 What the paper claims about Sybil and wash traffic

PolyStore does **not** claim complete Sybil resistance or complete wash-traffic resistance. Its mechanisms are narrower.

**Anti-Sybil posture.** Providers are assigned through a chain-controlled slot-placement process over an eligible provider set, with diversity and bounded-assignment rules at the policy layer. That reduces direct self-dealing because users do not choose their own slot map, but it is still an economic and governance problem, not a purely cryptographic one.

**Anti-wash posture.** Retrievals have explicit funding, explicit slot scope, nonces, and expiries. Public or third-party retrievals are requester-funded or sponsored rather than silently draining the owner’s long-term storage escrow. Base fees and per-session variable locks make fake demand consume real budget. That does not make wash traffic impossible, but it does make it attributable and costly instead of free signaling.

### 10.4 Privacy and trust boundaries

PolyStore’s integrity model and privacy model are separate.

- **Integrity** comes from the chained proof path back to `manifest_root`.
- **Confidentiality** comes from client-side encryption.
- **Metadata leakage** still exists unless separately minimized; providers may still learn object size, timing, and slot assignment.
- **Gateways** are optional orchestration helpers. They may assist with packing, caching, proof assembly, or session bundling, but they are not the source of truth.

## 11. Worked Example

Consider a Deal whose raw application payload is **64 MiB**.

### 11.1 Layout

Under the current 8 MiB MDU profile, the raw payload occupies **8 user-data MDUs**. PolyFS then adds:

- `MDU #0` for filesystem metadata; and
- one or more witness MDUs for replicated proof-index data.

The committed generation is therefore **larger than 64 MiB**. The 64 MiB figure refers only to raw payload bytes, not to the total committed PolyFS layout.

### 11.2 Placement

Each of the 8 user-data MDUs is striped under RS(8,12):

- 64 logical data Blobs per user-data MDU;
- 8 rows per user-data MDU;
- 12 shard Blobs per row; and
- 12 ordered slot responsibilities.

Every assigned provider receives all replicated metadata MDUs. The provider assigned to slot `s` also receives the shard Blobs for slot `s` across all 8 user-data MDUs.

### 11.3 Promotion

The owner stages the candidate generation to the 12 assigned providers, verifies that the prepared layout hashes to generation root `H1`, and submits a compare-and-swap update from the previous Deal root to `H1`. Once that update succeeds, `H1` becomes the Deal’s current generation.

### 11.4 Retrieval

A reader later requests a **256 KiB** file range that lies within a single RS row of one user-data MDU. The client:

1. resolves the path and byte range from replicated metadata under generation `H1`;
2. chooses any 8 healthy slots for the affected row;
3. opens 8 slot-scoped sessions, one per chosen slot, each pinned to `H1` and the relevant served shard-Blob range;
4. fetches 8 shard Blobs, one from each chosen slot; and
5. verifies all 8 proof chains, decodes the row, and extracts the requested 256 KiB from the reconstructed logical bytes.

The user experiences one file read. The protocol, however, accounts for the read as **8 accountable slot contributions**.

### 11.5 Failure case

Assume one of the chosen slots times out before expiry. The client opens a replacement session against another healthy slot and repeats the fetch for that slot’s shard Blob. The failed session does not “move” to the new provider. It either later completes as opened or it expires unpaid. The successful replacement session is independently attributable and settleable.

This example captures the whole design: a versioned generation root, replicated metadata, striped user-data placement, slot-scoped retrieval sessions, per-shard proof verification, local RS reconstruction, and explicit failure semantics.

## 12. Conclusion

PolyStore makes one narrow architectural bet: the unit that storage commits to, the unit that retrieval verifies, and the unit that settlement pays for must all line up. The protocol achieves that by treating a Deal as a sequence of immutable generations committed by `manifest_root`, by storing metadata as replicated PolyFS structure and user data as slot-accountable stripes, and by settling retrieval through slot-scoped sessions pinned to a specific generation.

The resulting trust model is one in which:

- open sessions refer to immutable snapshots rather than floating current state;
- providers are accountable for named slot contributions rather than vague availability;
- the proof path is explicit from `manifest_root` to served shard bytes; and
- synthetic audits reuse the same retrieval machinery rather than inventing a parallel trust model.

The current 128 KiB / 8 MiB / RS(8,12) profile is one concrete deployment of that idea. The whitepaper’s actual claim is the stronger, profile-independent one: if the layout, proof atom, and accountability model are aligned, decentralized storage can verify and settle real reads without placing raw files on chain.
