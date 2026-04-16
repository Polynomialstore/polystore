# PolyStore Litepaper

*Research Draft*

## PolyFS Makes Retrieval Verifiable

PolyFS is the deal filesystem that makes files path-resolvable, proof-addressable, and stripeable under one committed root.

That is the shortest way to understand PolyStore. Files are organized as PolyFS, the current PolyFS state is committed on chain through a compact `manifest_root`, and protocol-accounted remote reads are bound to retrieval sessions. The result is a storage protocol that can keep its on-chain trust anchor small while still making real retrievals direct, checkable, and economically accountable.

The practical value proposition is straightforward. Data owners get one compact on-chain root for large committed datasets. Providers get explicit slot responsibility instead of vague replica ownership. Readers get direct verification against committed structure and the ability to reconstruct reads under bounded provider outages. The protocol pays for real service events rather than only for background audit theater.

PolyStore therefore makes three different verification claims, and it helps to state them plainly.

**Data possession verification** checks that specific served shard or blob bytes match the committed structure.

**Range availability, or reconstructability under K-of-N slot availability,** checks that enough healthy slot contributions exist to reconstruct the requested logical bytes under the deal's erasure-coding profile. This is a retrieval-layer reconstructability claim, not a consensus-layer data-availability-sampling claim.

**Retrieval settlement verification** checks that a paid retrieval session was opened against the current committed generation, served within scope, and completed under the protocol's settlement rules.

## PolyFS: One Filesystem for Paths, Proofs, and Striping

PolyFS is not just a packing format. It is the deal filesystem that keeps path resolution, proof assembly, and reconstruction planning on the same committed structure.

The basic units are simple. A **Blob** is the atomic KZG verification unit. In the current profile it is 128 KiB. An **MDU** is the larger retrieval and layout unit. In the current profile it is 8 MiB, so each MDU contains 64 Blobs.

PolyFS uses those units in three layers:

```text
manifest_root
   |
   +-- MDU #0 ............ file table and root table for path resolution
   +-- witness MDUs ...... proof-index metadata
   +-- user-data MDUs .... actual file bytes, later striped across slots
```

`MDU #0` is the filesystem anchor. It lets a client resolve a file path into concrete byte ranges and MDU references. Witness MDUs carry the commitment-bearing metadata that lets any serving provider assemble proof paths without relying on a privileged coordinator. User-data MDUs carry the actual bytes the user wants back. Those are the MDUs that become striped data.

That distinction matters. The proof claim for a read is about bytes in a user-data MDU. Witness MDUs are proof-index metadata, not the thing the user is trying to retrieve. They exist so proof lookup stays practical and decentralized.

PolyFS is not only useful for proving that a particular shard or byte range belongs to committed data. Combined with striped placement, it also supports verifying that enough slot contributions exist to reconstruct the requested logical bytes. In other words, the same committed structure that tells a client where bytes live also tells the client how to verify membership and how to plan reconstruction.

## Slots, Striping, and Why Reed-Solomon Matters

PolyStore's canonical placement model stripes each user-data MDU across an ordered slot map. In the current default profile, each user-data MDU is encoded under RS(8,12): 8 data slots and 4 parity slots.

A **slot** is a fixed position in each stripe row. The ordered slot map tells the protocol which provider is responsible for each position, so routing and accountability attach to named positions rather than to a fuzzy pool of replicas.

```text
one stripe row under RS(8,12)

[slot0][slot1][slot2][slot3][slot4][slot5][slot6][slot7][slot8][slot9][slot10][slot11]
  data   data   data   data   data   data   data   data   parity  parity   parity   parity

retrieve from any 8 healthy slots in the row
```

This gives PolyStore four operational benefits in plain language.

First, it tolerates outages. In general, RS(`K`,`K+M`) preserves retrieval under up to `M` unavailable slots per row.

Second, it parallelizes reads. Large retrievals can fan out across multiple providers and multiple rows at once, then reconstruct incrementally. The throughput gain comes from aggregate provider bandwidth and row-level parallelism, not from Reed-Solomon coding somehow making a single disk faster.

Third, it avoids single-provider bottlenecks. A large read does not have to wait on one full replica holder if the requested rows can be assembled from any `K` healthy slots.

Fourth, it preserves explicit provider responsibility. Metadata remains replicated so any assigned provider can resolve paths and assemble proof context, but user-data responsibility is still slot-specific and therefore attributable.

## Retrieval Sessions Turn Reads Into Protocol Events

Every protocol-accounted remote read is sessionized. Retrieval sessions are the control-plane object that turns off-chain byte transfer into something the protocol can authorize, price, verify, and settle.

At open, a retrieval session pins the deal, the current `manifest_root`, the responsible slot or provider, the requested blob-aligned range, the payer, a nonce, and an expiry. In the current model, opening the session also locks or burns the relevant retrieval fees according to policy, so the funding source is explicit before bytes move. Sessions may be owner-paid, requester-paid, or protocol-paid, depending on who is authorized to open the read and which budget is being used. Deal policy can restrict who may open user retrieval sessions, but that access-control surface is not the same thing as privacy.

Serving then stays inside that envelope. Providers are expected to serve only the declared range and to return the proof material tied to that committed range. The client verifies what it receives against committed structure and, in the striped case, reconstructs the requested logical bytes from the selected healthy slots.

Settlement is defined on completion, not on vague progress claims. If the required proof material and the completion signal arrive before expiry, the session can settle. If the session times out or never reaches completion, the provider does not receive a completion payout under the normal settlement path. Partial transfer may happen on the wire, but the litepaper's core accounting claim is whole-session completion rather than partial-byte payout.

The verification boundary is also explicit. The client handles path resolution, slot selection, row reconstruction, and immediate safety checks for the data it is about to use. The chain handles the compact proof checks and the session rules needed for settlement: pinned `manifest_root`, slot responsibility, proof validity, expiry, and completion conditions. A gateway may help with routing, caching, or reconstruction, but it is a convenience layer rather than the trust anchor.

## Proof Path and Why the Cost Stays Bounded

PolyStore's proof path is compact because PolyFS keeps the verification boundaries aligned with storage boundaries.

```text
served shard/blob bytes
        |
        v
opening against the relevant shard/blob commitment
        |
        v
proof that the shard/blob belongs to the target user-data MDU
        |
        v
opening of that MDU against the deal's manifest_root

witness MDUs help assemble this path, but the claim remains about user-data bytes
```

Conceptually, the verifier checks three linked facts. First, the target user-data MDU is committed under the deal's `manifest_root`. Second, the relevant shard or blob commitment belongs to that user-data MDU. Third, the served bytes are a valid opening of that commitment. In the striped case, the proof must also be attributable to the provider responsible for the relevant slot.

Why this stays practical is not that "KZG is magic." It is that verification stays at blob-sized units and MDU-local structure. The system does not ask the chain or the client to replay whole files, perform sealing-style work, or drag the entire raw object through settlement. Proof objects stay compact because the layout was designed for proof-addressable retrieval from the start.

The overhead story is also explicit rather than hidden. PolyFS metadata overhead is mainly `MDU #0` plus the witness MDUs. Striping overhead is the Reed-Solomon expansion from `K` to `K+M`. Additional slot-aligned placements are a separate scaling choice, not hidden duplication. When demand grows, that is the preferred way to add capacity while preserving the same slot-accountability model. Those costs are the price of bounded outage tolerance, parallel retrieval, and accountable verification.

## One File, End to End

Use one fixed example. A data owner wants to store a 64 MiB payload. Here, **64 MiB means payload bytes only**. Because each user-data MDU is 8 MiB, the payload occupies 8 user-data MDUs. PolyFS then adds `MDU #0` and the required witness MDUs as separate metadata overhead.

The owner prepares the file as PolyFS. `MDU #0` records how the file maps into the deal. The witness MDUs hold the proof-index metadata. The 8 user-data MDUs hold the content itself. Each user-data MDU is then encoded under RS(8,12) and assigned across 12 ordered slots with assigned providers. Metadata is replicated to the assigned providers; user data is striped by slot. Once the full layout is ready, the owner commits the resulting `manifest_root` on chain. The deal now has one compact trust anchor for the payload plus its committed filesystem structure.

Later, a reader wants a 256 KiB range inside one user-data MDU. Because the protocol accounts in blob-aligned units, that request corresponds to two 128 KiB Blobs. The reader opens the required retrieval sessions, each pinned to the current `manifest_root`, the responsible slot assignment, the requested blob range, the payer, and the expiry.

To satisfy the read, the client resolves the file path through `MDU #0`, uses the witness MDUs to assemble the proof context, selects healthy slots for the needed stripe rows, fetches shard data and proof material, and reconstructs the requested logical bytes. If one or more slots are unavailable, the read can still succeed so long as each involved row still has any 8 healthy slots. More generally, RS(`K`,`K+M`) tolerates up to `M` missing slots per row.

The throughput story is equally direct. For a larger read, the client can pull shard data from multiple providers in parallel and reconstruct rows incrementally as they arrive. The benefit comes from aggregating provider links across the selected slots, not from pretending that coding alone creates free bandwidth.

Verification still follows the same compact path: the served bytes open against the relevant shard or blob commitment for the target user-data MDU, the proof path shows that commitment belongs to that committed user-data MDU, and the user-data MDU is opened against the deal's `manifest_root`. Witness MDUs supply the proof-index metadata used to assemble that path. Once the required proof material is submitted and the session completes under policy, the protocol can settle the event.

## What PolyStore Is Claiming, and What It Is Not

PolyStore's claim is narrow but useful. By organizing content as PolyFS, the protocol can keep files path-resolvable, proof-addressable, and stripeable under one committed root. That makes it possible to verify possession of served bytes, verify reconstructability of requested ranges under bounded slot outages, and settle paid retrievals against the same compact commitment anchor.

PolyStore is not claiming that access control equals privacy, that gateways disappear, or that a compact root removes all retrieval complexity. Confidentiality still comes from client-side encryption. Gateways remain useful for convenience, caching, and UX. Repair, elasticity, and retrieval policy still require disciplined protocol design.

The practical advantage is simpler than the mechanism: **a small root, explicit slot responsibility, direct verification, K-of-N resilience, and paid reads tied to real service.**
