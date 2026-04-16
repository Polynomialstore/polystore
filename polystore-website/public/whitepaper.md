# PolyStore Whitepaper

*Working Draft*

## Abstract

PolyStore is a decentralized storage protocol built around **PolyFS**: the deal filesystem that makes files path-resolvable, proof-addressable, and stripeable under one committed root. Each Deal advances by explicit **generation** swaps, so retrieval sessions pin an immutable `manifest_root` rather than a floating notion of “current content.” The protocol makes three distinct verification claims. First, it can verify that specific served shard or Blob bytes belong to committed data. Second, it can verify **range availability**, meaning reconstructability of requested logical bytes from `K` healthy slot contributions under an RS(`K`,`K+M`) stripe. Third, it can verify that a paid retrieval session actually completed and should settle.

Those claims are designed to stay compact. KZG openings operate at blob-sized units rather than whole files; the chain verifies compact proofs against `manifest_root` instead of replaying full retrievals; and client-side Reed-Solomon decoding is row-local and parallelizable. In the striped path, reads fan out across multiple providers and rows in parallel, and RS(`K`,`K+M`) preserves retrieval through up to `M` unavailable slots per row. The current deployment profile—128 KiB Blobs, 8 MiB MDUs, and RS(8,12)—is one profile of this architecture, not the architecture itself.

Cold-data auditing is modeled as **sessionized synthetic retrieval**: the protocol can open the same session type used for ordinary reads, but fund it from an audit budget rather than from user demand. This whitepaper therefore focuses on one canonical model—PolyFS generations, ordered slot responsibility, chained proofs, and session settlement—and treats profile constants and audit policy as secondary choices layered on top.

## 1. Scope, Terminology, and Verification Claims

This whitepaper describes the **canonical striped protocol**. Historical full-replica deals may remain readable as a compatibility path, but they are not the design center here. Unless a section explicitly says otherwise, “retrieval” means **slot-aware striped retrieval** and “provider responsibility” means responsibility for a named slot in an ordered slot map.

PolyFS is the deal filesystem that makes files path-resolvable, proof-addressable, and stripeable under one committed root.

Four terms are used precisely throughout:

- **Deal:** the on-chain object that names the owner, economics, retrieval policy, current generation, and current slot assignment.
- **Generation:** an immutable snapshot of Deal content, identified by a specific `manifest_root` and the associated PolyFS layout it commits to.
- **Slot:** an ordered provider responsibility in an RS(`K`,`K+M`) stripe. A provider is accountable because it owns one or more slots, not because it is vaguely “one of the replicas.”
- **Retrieval session:** the accountable control-plane object that binds a read to a Deal, a pinned generation, a slot responsibility, a served Blob range, a payer, and an expiry.

The phrase **current `manifest_root`** therefore has one narrow meaning: the latest promoted generation of the Deal. It is a lookup rule for *new* reads and *new* writes. It is **not** a floating reference inside an already-open retrieval session.

### 1.1 Three verification claims

The paper distinguishes three different protocol claims and keeps them separate.

| Verification claim | What the protocol verifies | What it does **not** mean |
|---|---|---|
| **Data possession verification** | specific served shard or Blob bytes match the pinned generation under `manifest_root` | not that the whole file or whole Deal is simultaneously readable from one provider |
| **Range availability / reconstructability verification** | enough healthy slot contributions exist to reconstruct the requested logical bytes under RS(`K`,`K+M`) | not consensus-layer data-availability sampling, and not a blanket claim about all rows at all times |
| **Retrieval settlement verification** | a paid retrieval session completed under the declared scope, with valid proof coverage and completion evidence before expiry | not that every attempted read succeeds on the first try, or that retries are unnecessary |

To avoid overclaiming, this whitepaper uses **range availability** or **reconstructability under `K`-of-`N` slot availability** for the second claim. Some readers may loosely call that “data availability verification,” but the claim here is deliberately narrower and operational.

### 1.2 What the paper is not claiming

PolyStore is not claiming that access control equals privacy, that gateways disappear, or that a compact root removes all retrieval complexity. The protocol claim is narrower: a compact root, an aligned filesystem, an explicit slot map, and session-bound proofs are enough to verify possession, reconstructability of requested ranges, and retrieval settlement without putting raw files on chain.

## 2. Protocol Invariants vs. Current Deployment Profile

The protocol needs a fixed cryptographic atom, a fixed retrieval/layout unit, and a fixed slot accountability model. The exact numbers are a deployment profile.

| Element | Protocol role | Current deployment profile |
|---|---|---|
| Blob | cryptographic atom for KZG openings and session accounting | 128 KiB |
| MDU | larger layout and retrieval planning unit | 8 MiB = 64 Blobs |
| Stripe profile | reconstruction and slot accountability | RS(8,12) |
| Metadata policy | path resolution and proof lookup must remain available from any assigned slot | `MDU #0` + witness MDUs replicated to all assigned providers |
| User-data policy | data-bearing MDUs are accountable by slot, not by opaque replica | striped shard storage across the ordered slot map |

The architecture does **not** depend on those exact numbers, but it **does** depend on the separation of roles above. A future profile could change Blob size, MDU size, or RS parameters without changing the conceptual model, provided the cryptographic atom, retrieval planner, and accountability logic remain aligned.

## 3. Deal State as Versioned Snapshots

A Deal is a mutable on-chain object, but the content it points to is not treated as mutable in place. Each content change creates a **new generation**.

Conceptually, a generation is the tuple:

`(manifest_root, total_mdus, witness_mdu_count, PolyFS layout, slot assignment in force at promotion time)`

The whitepaper relies on the following rules:

1. **Generations are immutable once promoted.** If a Deal moves from generation `H1` to `H2`, the protocol does not reinterpret `H1`; it creates a new current snapshot.
2. **Retrieval sessions pin a specific generation.** A session opened against `H1` continues to verify against `H1`, even if the Deal later advances to `H2`.
3. **Slot responsibility is pinned at session open.** If a slot is later repaired or reassigned, that does not retarget an open session. A replacement provider serves through a new session bound to the new slot responsibility.
4. **Writes use compare-and-swap semantics.** A content update must name the previous `manifest_root` it expects to replace. If the Deal has advanced in the meantime, the update is stale and must fail.

These rules prevent concurrent writers from silently overwriting each other, and they prevent an open retrieval from becoming ambiguous when content or placement changes during service.

## 4. PolyFS Layout and Commitment Model

PolyFS is the canonical layout of a Deal generation. Its purpose is not simply to pack files neatly; its purpose is to ensure that file resolution, cryptographic proof generation, reconstruction planning, and retrieval accounting all refer to the same committed structure.

### 4.1 Layered PolyFS layout

| Layer | Function | Placement policy |
|---|---|---|
| `MDU #0` | filesystem anchor: file table, root table, and path-resolution metadata | replicated to every assigned provider |
| Witness MDUs | replicated proof-index metadata: commitment tables and auxiliary metadata needed to assemble inclusion paths efficiently | replicated to every assigned provider |
| User-data MDUs | data-bearing MDUs containing the file bytes (typically ciphertext bytes if the client encrypts before upload) | striped across the ordered slot map |

**Figure 1. PolyFS layers**

```text
manifest_root
   |
   +-- MDU #0            -> filesystem anchor (replicated)
   +-- witness MDUs      -> proof-index metadata (replicated)
   +-- user-data MDU 0   -> striped rows -> slots 0 .. N-1
   +-- user-data MDU 1   -> striped rows -> slots 0 .. N-1
   +-- ...
```

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

**Figure 2. One row across slots**

```text
logical row r:    D0   D1   D2   D3   D4   D5   D6   D7
RS(8,12)  --->   S0   S1   S2   S3   S4   S5   S6   S7   S8   S9   S10  S11
                   |    |    |    |    |    |    |    |    |    |     |     |
                 slot0 slot1 ...                                 ...  parity parity
```

The important point is not the arithmetic. The important point is that the proof atom and the storage atom stay aligned: every provider stores complete 128 KiB shard Blobs that can be individually verified.

### 4.3 What `manifest_root` commits to

The chain does not store whole files. It stores a compact `manifest_root` that commits to the sequence of MDU roots in the generation. That commitment is the only on-chain trust anchor needed for retrieval verification.

A verifier therefore asks a narrow, deterministic question:

1. which generation root is pinned by the session,
2. which MDU root is committed at the requested `mdu_index`,
3. which shard-Blob commitment is committed under that MDU root, and
4. whether the served shard bytes are a valid opening of that shard-Blob commitment.

PolyFS exists specifically so proof assembly and reconstruction follow filesystem boundaries. Path resolution names the target MDUs, witness MDUs index the proof material, and row planning determines which slot leaves must be opened.

### 4.4 PolyFS as the substrate for possession and availability verification

PolyFS is not only useful for proving that a particular shard or byte range belongs to committed data. Combined with striped placement, it also supports verifying that enough slot contributions exist to reconstruct the requested logical bytes.

Those are two different protocol statements.

**Possession verification** asks whether a specific served shard Blob belongs to the pinned generation. That is a per-Blob claim. It is established by the chained proof path from `manifest_root` to the served shard bytes.

**Range availability / reconstructability verification** asks whether the client can obtain enough valid slot contributions to reconstruct the requested logical range. That is a row-by-row claim. For each affected row, the client verifies contributions from any `K` healthy slots under the pinned generation and decodes the row locally. If that succeeds for all affected rows, the requested logical range is operationally available.

The witness MDUs support both tasks by carrying proof-index metadata, but they are not the target of the user-data proof claim. For user-data retrieval, the second hop still proves inclusion under the **target user-data MDU root**. Witness MDUs simply make that inclusion path discoverable and reproducible from any assigned provider.

### 4.5 Explicit overhead model

The protocol has three different overhead sources, and the paper keeps them separate.

Let:

- `P` = payload bytes packed into user-data MDUs after MDU alignment,
- `F` = metadata bytes carried by `MDU #0` plus witness MDUs,
- `R = (K+M)/K` = Reed-Solomon expansion factor for one stripe set,
- `N = K+M` = number of slots in one stripe set,
- `A` = number of slot-aligned placements, with default `A = 1`.

Then the main size equations are:

```text
logical committed generation bytes:   G  = P + F
one stripe-set stored footprint:      S1 ≈ R*P + N*F
A stripe-set stored footprint:        SA ≈ A * (R*P + N*F)
```

The terms matter:

- **PolyFS overhead** is mainly `F`, i.e. `MDU #0` plus witness MDUs.
- **Striping overhead** is `(R - 1) * P`, i.e. the RS parity expansion of user-data MDUs.
- **Scaling overhead** is `(A - 1) * (R*P + N*F)`, i.e. explicit extra slot-aligned placements chosen for throughput or demand, not hidden duplication.

Actual byte counts may vary because of final-MDU padding, ciphertext framing, and witness sizing, but those equations capture the architectural split the paper relies on.

## 5. Placement Model and Provider Responsibilities

PolyStore’s canonical placement model is an **ordered slot map** of length `N = K+M`. Metadata is replicated across all assigned providers. User-data MDUs are striped across slots.

A provider assigned to slot `s` has four concrete obligations:

1. store the replicated metadata MDUs for the generation;
2. store the shard Blobs that belong to slot `s` for every user-data MDU;
3. serve those shard Blobs, plus the replicated proof-index metadata, when a valid session names slot `s`; and
4. submit proof-of-retrieval material attributable to slot `s`.

This is a narrower claim than “the provider serves the file.” In the canonical striped protocol, a provider serves **its shard contribution** to the file. The file emerges from the client’s verified reconstruction across `K` healthy slots.

That distinction is structural. A single provider may serve all replicated metadata for path resolution. A single provider may also serve an old full-replica deal for compatibility. But for new striped user-data reads, the protocol’s accountable unit is the **slot contribution**, not the whole-file response.

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

### 6.3 Step 3: apply structural and readiness checks

A provider or gateway may reject a staged upload if the client’s expected base generation is stale. This is an off-chain preflight analogue of compare-and-swap. It prevents the client from spending bandwidth staging a new generation on top of the wrong base.

Before promotion, a deployment should also distinguish two different checks:

- **Structural validity:** the local PolyFS layout is internally consistent; witness tables match the target MDU roots; and the derived `manifest_root` matches the artifact set being staged.
- **Service readiness:** the assigned providers have actually received the bytes they are expected to serve for that candidate generation.

The chain anchors the first property directly through `manifest_root`. The second property is operational. A practical deployment should therefore require readiness evidence before promotion, such as provider acknowledgements for replicated metadata plus sample fetch-and-verify checks over staged shard Blobs. Those checks are deployment policy, not a new on-chain proof system.

### 6.4 Step 4: promote the generation on chain

To make the candidate generation current, the owner submits an update intent that names both the previous `manifest_root` and the new `manifest_root`. The chain promotes the new root only if the previous root still matches the Deal’s current root at execution time.

This compare-and-swap rule is the authoritative overwrite guard. It prevents concurrent writers, stale gateways, or stale local caches from silently replacing the wrong generation.

### 6.5 Step 5: retain current vs. provisional generations correctly

Until the compare-and-swap succeeds, the previously promoted generation remains readable. The newly uploaded bytes are provisional. If promotion fails, the provisional bytes may later be garbage-collected under policy; they do not retroactively become the live Deal state.

A bad commit can therefore anchor an unusable generation if an owner promotes without adequate staging checks. What it cannot do is later produce valid retrieval proofs or sustained retrieval settlement for data that was never really staged. The protocol separates the compact trust anchor from the operational discipline required to make that root serviceable.

## 7. Canonical Retrieval Path

A user-visible file read proceeds in five deterministic stages.

### 7.1 Resolve the logical file range

The client reads cached or freshly served replicated metadata (`MDU #0` plus witness MDUs), either from prior verified cache or via ordinary metadata retrieval sessions, from any assigned provider and resolves `file_path` into the affected user-data MDUs and logical Blob ranges.

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

### 7.6 Throughput and outage behavior

Striping helps throughput because reads can **fan out across multiple providers and rows in parallel**, not because RS encoding itself makes disks faster. For each affected row, the client may fetch shard Blobs from any `K` healthy slots concurrently. For large reads spanning multiple rows or MDUs, those row fetches can also proceed concurrently. The resulting throughput ceiling is therefore the aggregate of the selected provider links and the client’s decode pipeline, not the bandwidth of one replica holder.

Striping helps availability because **RS(`K`,`K+M`) preserves retrieval under up to `M` unavailable slots per row**. The claim is precise and row-local. If a row still has any `K` healthy slots, the client can verify those `K` contributions, decode the row, and continue. If fewer than `K` healthy slots remain for a required row, that row is unavailable even if other rows are still serviceable.

The cost of these benefits is explicit rather than hidden. RS expansion adds parity bytes to user-data MDUs. Replicated metadata adds `MDU #0` plus witness MDUs to every assigned provider. Optional extra slot-aligned placements multiply stored bytes again by choice. PolyStore treats those costs as the explicit price of outage tolerance, parallel retrieval, and accountable slot ownership.

### 7.7 What counts as availability evidence

Successful retrieval and reconstruction from `K` healthy slot contributions, under sessions pinned to the same `manifest_root` and verified by the same chained proof model, is the protocol’s **operational availability evidence** for a logical range.

This is a narrower statement than “the Deal is globally available.” It means that, for the requested range and the requested generation, the protocol observed enough valid slot contributions to reconstruct the bytes. Negative evidence comes from the same model in reverse: expired sessions, non-response, or invalid proof paths against the pinned generation provide attributable evidence that a requested range could not be reconstructed from the named slot responsibilities.

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

- **Absent confirmation:** no provider payout and no completed-session credit.
- **Requester dispute or non-confirmation:** proof submission alone cannot force completion; the session remains incomplete until confirmation or expiry.
- **Invalid proof submission:** no state advance; the invalid proof may become slashable evidence, but it does not make the session “partially complete.”
- **Wrong bytes with failing proof path:** the client rejects the bytes and may convert the failed response into fraud evidence.
- **Expiry without completion:** the provider is unpaid for that session; locked variable fees are handled by policy, but the session itself is simply expired.
- **Deal update while session is open:** the session remains bound to the pinned generation root from open time; it does not migrate to the newer generation.

Under this model, there is no optimistic completion, no floating “latest root” reference inside an open read, and no implicit retry semantics.

### 8.4 Retrieval settlement verification

Retrieval settlement verification is the protocol’s third verification claim. It does not re-prove the entire retrieval from scratch. It verifies that:

1. a valid session existed for the declared Deal, slot, generation root, payer, and range;
2. provider proof material covered the full declared range under that pinned scope;
3. completion confirmation arrived before expiry; and
4. the session therefore reached `COMPLETED` under the protocol rules.

Only then may the protocol settle fees and credit the provider. Settlement is therefore tied to **real service under a pinned scope**, not to an informal statement that “traffic probably happened.”

## 9. Chained Proof Architecture

PolyStore’s retrieval claim is narrow: a verifier can check a served shard Blob against a compact on-chain generation root.

**Figure 3. Proof path**

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

## 10. Economics, Sessionized Synthetic Retrieval, and Security Boundaries

### 10.1 Retrieval pricing and payout

Retrieval is paid through sessions, not through informal reputation. In the current fee-oriented model:

- opening a session burns a base anti-spam fee;
- opening a session also locks a variable fee proportional to the declared Blob count;
- a provider is paid only when the session reaches `COMPLETED`; and
- if the session expires without completion, the variable portion is handled by refund or unlock rules rather than provider payout.

This matters because it makes real reads economically legible. A provider does not get credit for vague availability claims. It gets credit for a completed, user-authorized, proof-backed session.

### 10.2 Sessionized synthetic retrieval (secondary audit path)

The protocol still needs a way to test cold data. This whitepaper therefore models synthetic challenges as **sessionized synthetic retrieval**, not as a separate proof system.

When data is cold, the protocol can act as a user of last resort by opening protocol-funded, slot-scoped retrieval sessions against derived rows or leaf indices. Those sessions use the same pinned-generation semantics, the same chained proofs, and the same slot accountability as ordinary user retrievals. They differ only in who opens the session and who pays for it.

This section is intentionally narrow. It treats synthetic retrieval as a **secondary audit path** that reuses the canonical retrieval model. Challenge quotas, audit frequencies, and reward policy may evolve, but they do not change the underlying proof semantics described in this whitepaper.

### 10.3 What the paper claims about Sybil and wash traffic

PolyStore does **not** claim complete Sybil resistance or complete wash-traffic resistance. Its mechanisms are narrower.

**Anti-Sybil posture.** Providers are assigned through a chain-controlled slot-placement process over an eligible provider set, with diversity and bounded-assignment rules at the policy layer. That reduces direct self-dealing because users do not choose their own slot map, but it is still an economic and governance problem, not a purely cryptographic one.

**Anti-wash posture.** Retrievals have explicit funding, explicit slot scope, nonces, and expiries. Public or third-party retrievals are requester-funded or sponsored rather than silently draining the owner’s long-lived storage escrow. Base fees and per-session variable locks make fake demand consume real budget. That does not make wash traffic impossible, but it does make it attributable and costly instead of free signaling.

### 10.4 Privacy and trust boundaries

PolyStore’s integrity model and privacy model are separate.

- **Integrity** comes from the chained proof path back to `manifest_root`.
- **Confidentiality** comes from client-side encryption.
- **Metadata leakage** still exists unless separately minimized; providers may still learn object size, timing, and slot assignment.
- **Gateways** are optional orchestration helpers. They may assist with packing, caching, proof assembly, or session bundling, but they are not the source of truth.

PolyStore is not claiming that access control equals privacy, that gateways disappear, or that a compact root removes all retrieval complexity. It claims that those boundaries can be stated honestly while still making direct, verifiable, and settleable reads practical.

## 11. Efficiency Story: CPU, Disk, and Overhead Boundaries

This whitepaper intentionally uses restrained language about efficiency because benchmark numbers are still being gathered. The design claim is not that KZG is magic or that striping is free. The claim is that PolyStore keeps the expensive work at bounded, blob-sized units and makes the remaining costs explicit.

### 11.1 Why CPU cost stays bounded

The main CPU-saving design choice is that verification stays at **blob-sized units**, not whole files.

- Providers prove shard Blobs they actually store; they do not need sealing-style transforms over whole datasets to answer a read.
- Clients verify compact KZG and Merkle proofs for the served shard Blobs they fetch; they do not replay the whole file to decide whether one range is valid.
- Client-side RS decoding is **row-local**. Only the affected rows need reconstruction, and those rows can be decoded in parallel.
- The chain checks compact proofs and session state; it does not execute the full retrieval data plane.

The real CPU costs are still present: KZG openings and verifications, Merkle path assembly, RS encode and decode, and local orchestration. The value proposition is that those costs scale with the served shards and affected rows, not with “replay the entire object.”

### 11.2 Why extra disk overhead is bounded

PolyFS-specific disk overhead is mainly `MDU #0` plus witness MDUs. That metadata layer is the bounded cost of making files path-resolvable and proof-addressable under one root.

User-data overhead comes from a different source: **RS expansion**. For one stripe set, the extra user-data footprint is exactly the parity factor implied by `(K+M)/K`. That is the explicit price of outage tolerance and parallelizable retrieval.

Any additional slot-aligned placement is a third, separate choice. It is an explicit scaling decision for throughput or hot demand. It is not hidden duplication implied by the base protocol.

### 11.3 Where the real overhead comes from

The easiest way to misunderstand PolyStore is to lump all overhead into one phrase like “proof overhead.” The paper keeps the costs split:

- **metadata overhead:** `MDU #0` + witness MDUs,
- **striping overhead:** RS parity expansion,
- **retrieval bandwidth overhead:** fetching `K` verified shard contributions and proof material rather than one opaque whole-file stream,
- **scaling overhead:** optional extra slot-aligned placements.

That split matters because the first cost is about proof-index structure, the second is about reconstructability, and the third is about operational demand. They should not be conflated.

## 12. Worked Example

Consider a Deal whose raw application payload is **64 MiB**.

### 12.1 Layout

Under the current 8 MiB MDU profile, the raw payload occupies **8 user-data MDUs**. PolyFS then adds:

- `MDU #0` for filesystem metadata; and
- one or more witness MDUs for replicated proof-index data.

The committed generation is therefore **larger than 64 MiB**. The 64 MiB figure refers only to raw payload bytes, not to the total committed PolyFS layout.

### 12.2 Placement

Each of the 8 user-data MDUs is striped under RS(8,12):

- 64 logical data Blobs per user-data MDU;
- 8 rows per user-data MDU;
- 12 shard Blobs per row; and
- 12 ordered slot responsibilities.

Every assigned provider receives all replicated metadata MDUs. The provider assigned to slot `s` also receives the shard Blobs for slot `s` across all 8 user-data MDUs.

### 12.3 Promotion

The owner stages the candidate generation to the 12 assigned providers, verifies that the prepared layout hashes to generation root `H1`, and submits a compare-and-swap update from the previous Deal root to `H1`. Once that update succeeds, `H1` becomes the Deal’s current generation.

### 12.4 Retrieval

A reader later requests a **256 KiB** file range that lies within a single RS row of one user-data MDU. The client:

1. resolves the path and byte range from replicated metadata under generation `H1`;
2. chooses any 8 healthy slots for the affected row;
3. opens 8 slot-scoped sessions, one per chosen slot, each pinned to `H1` and the relevant served shard-Blob range;
4. fetches 8 shard Blobs, one from each chosen slot; and
5. verifies all 8 proof chains, decodes the row, and extracts the requested 256 KiB from the reconstructed logical bytes.

If one or more slots are unavailable, retrieval still succeeds from any 8 healthy slots because RS(8,12) tolerates up to 4 missing slots per row. For larger reads spanning multiple rows, the client can pull shard data from multiple providers and multiple rows in parallel and reconstruct incrementally.

The user experiences one file read. The protocol, however, accounts for the read as **8 accountable slot contributions**.

### 12.5 Failure case

Assume one of the chosen slots times out before expiry. The client opens a replacement session against another healthy slot and repeats the fetch for that slot’s shard Blob. The failed session does not “move” to the new provider. It either later completes as opened or it expires unpaid. The successful replacement session is independently attributable and settleable.

This example captures the whole design: a versioned generation root, replicated metadata, striped user-data placement, slot-scoped retrieval sessions, per-shard proof verification, local RS reconstruction, explicit outage tolerance, parallel read fan-out, and explicit failure semantics.

## 13. Conclusion

PolyStore makes one narrow architectural bet: the unit that storage commits to, the unit that retrieval verifies, and the unit that settlement pays for must all line up. The protocol achieves that by treating a Deal as a sequence of immutable generations committed by `manifest_root`, by storing metadata as replicated PolyFS structure and user data as slot-accountable stripes, and by settling retrieval through slot-scoped sessions pinned to a specific generation.

The resulting trust model is one in which:

- open sessions refer to immutable snapshots rather than floating current state;
- providers are accountable for named slot contributions rather than vague availability;
- the proof path is explicit from `manifest_root` to served shard bytes;
- range availability is a `K`-of-`N` reconstructability claim, not an overloaded consensus-style DA claim; and
- synthetic audits reuse the same session machinery rather than inventing a parallel trust model.

The current 128 KiB / 8 MiB / RS(8,12) profile is one concrete deployment of that idea. The whitepaper’s stronger, profile-independent claim is that if the layout, proof atom, and accountability model are aligned, decentralized storage can verify and settle real reads without placing raw files on chain. The practical result is a small root, explicit slot responsibility, direct proof verification, `K`-of-`N` resilience, parallel read fan-out, and paid reads tied to real service.

## Appendix A. Benchmark Agenda and Placeholder Metrics

The design claims above should ultimately be backed by measured numbers. Until then, the whitepaper intentionally uses bounded or architectural language rather than strong empirical adjectives. The following benchmark categories are the ones that matter most.

| Metric | Why it matters | Placeholder |
|---|---|---|
| PolyFS build throughput (GiB/s) | cost of packing `MDU #0`, witness MDUs, and user-data MDUs | TBD |
| RS encode throughput by profile | ingest cost of one stripe set | TBD |
| RS decode throughput by row and by MDU | reconstruction cost during retrieval | TBD |
| KZG proof generation time per shard Blob | provider-side serving cost | TBD |
| KZG verification time per shard Blob | client and chain-side verification cost | TBD |
| Proof object size per served shard Blob | bandwidth overhead for proof transport | TBD |
| Metadata overhead as `%` of payload | concrete cost of `MDU #0` + witness MDUs | TBD |
| Aggregate retrieval throughput vs. selected `K` slots | practical fan-out benefit from multiple providers | TBD |
| Retrieval success under `M` slot outages | operational evidence for row-local outage tolerance | TBD |
| Footprint multiplier for extra slot-aligned placements | cost of explicit throughput scaling | TBD |

