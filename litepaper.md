# PolyStore Litepaper

*Research Draft*

## Why PolyStore Exists

PolyStore is a decentralized storage protocol for one specific job: proving that committed bytes can be read back under explicit economic rules.

That matters to three different parties.

- **Owners** get a compact on-chain commitment to their data and a protocol path that pays providers for real reads instead of vague “availability” claims.
- **Providers** get concrete responsibility. Each provider is assigned a fixed slot in a stripe, so it is clear which shard it must store, serve, and prove.
- **Readers** can fetch directly from providers and verify what they received against the same on-chain commitment. A gateway may still help with routing, caching, or packing, but it is not the trust anchor.

The protocol is built around one design choice: the same file layout should support storage, routing, and verification. PolyStore therefore stores each deal as **PolyFS**, commits the current PolyFS state on chain as a compact **`manifest_root`**, and turns accountable reads into **retrieval sessions**.

The practical reason this is possible is **KZG commitments**. They let the system prove a claim about a small piece of data with a small proof against a tiny on-chain root. That changes the design space: the chain can anchor very large datasets without storing, hashing, or replaying whole files every time someone reads them.

## PolyFS in Plain Language

PolyFS is the canonical file layout inside a deal. It turns an uploaded file into three things:

- **Blobs**: 128 KiB proof units in the current profile.
- **MDUs**: 8 MiB transfer units, each holding 64 Blobs.
- **Replicated metadata** that tells clients how to find data and verifiers how to prove it.

The MDUs do not all serve the same purpose.

1. **`MDU #0`** is the file-system index. It maps file paths to byte ranges and the user-data MDUs that contain them.
2. **Witness MDUs** hold the commitment-bearing metadata used to assemble proof paths for those user-data MDUs. They are replicated so any serving provider can supply proof context.
3. **User-data MDUs** hold the payload bytes themselves. These are the MDUs that get erasure-coded and distributed across providers.

This distinction matters. The served bytes come from **user-data MDUs**. The **witness MDUs** hold the metadata that helps show how those bytes link back to the deal’s committed root. PolyFS therefore separates “where the bytes live” from “how the proof path is assembled,” while keeping both under one committed structure.

The chain stores only **`manifest_root`**, a compact commitment to the current PolyFS state. Later, a verifier can check a served byte range against that root without turning the whole file into the verification object.

## Slots Make Provider Responsibility Explicit

PolyStore’s default placement is striped. Each user-data MDU is encoded under **RS(8,12)**: eight data slots and four parity slots.

A **slot** is simply a fixed position in that stripe. The chain assigns one provider to each ordered slot. That is the operational model in one sentence: a provider is responsible for the shard bytes for its slot, not for a vague promise to be somewhere in a replica set.

Slots matter for three reasons.

- **Accountability:** the protocol can attribute a proof or a failure to a specific slot and provider.
- **Routing:** a client can fetch any `K` healthy slots to reconstruct an MDU instead of hunting for a full replica.
- **Scaling:** extra capacity can be added as additional slot-aligned placements, preserving the same routing and accountability model instead of blurring it with ad hoc replicas.

Owners do not hand-pick providers for accountable placement. Slot assignment is deterministic and policy-driven, which keeps placement anti-sybil and lets the protocol reason about who was supposed to store and serve what.

Metadata MDUs remain replicated across the assigned providers, so any serving provider can help a client resolve file paths and proof context even though user-data MDUs are striped.

## Retrieval Sessions Turn Reads Into Settleable Events

Any remote read that is meant to count for protocol payment or accountability is sessionized. A retrieval session does four jobs at once.

1. **Authorization.** The deal’s retrieval policy decides who may open the session: owner only, allowlist, voucher, or public access. This controls who may request protocol-accounted reads; it is not a privacy system, so confidential data still needs encryption.
2. **Escrow.** Opening the session locks the retrieval fee up front. In the current design, the funds come from deal escrow for owner-paid reads, from the requester for sponsored or public reads, or from protocol budget for audit and repair reads.
3. **Scope.** The session pins the exact deal, current `manifest_root`, responsible provider or slot, blob-aligned range, nonce, and expiry. That prevents “I served something else” disputes later.
4. **Outcome.** The provider serves within that scope, submits proof material, and the client confirms success. If those conditions are met before expiry, the session completes and settlement releases the payout. If not, the session expires and there is no completion payout.

A session can cover a multi-blob range, and the data can be delivered in chunks or batches inside that range. But settlement attaches to the session’s declared range as a unit: in the current design, a session is completed or it expires. An expired session does not earn the provider a completion payout, and any locked value follows the protocol’s cancel or unwind path rather than settling as a successful read.

The same control-plane object can also be opened by the protocol itself for audit, repair, or liveness checks when organic demand is absent. That keeps cold data inside the same accountability model instead of creating a separate proof universe.

## What the Client Verifies, and What the Chain Verifies

The client and the chain do different jobs.

| Client-side checks | Chain-side checks for settlement |
| --- | --- |
| Resolve `file_path` through `MDU #0` | The session was authorized, funded, and unexpired |
| Choose `K` healthy slots and reconstruct the requested bytes | The session was pinned to the current `manifest_root` |
| Verify the downloaded shard or blob data before accepting it | The proof material matches the committed structure |
| Decrypt and validate application content | The proof is attributable to the provider responsible for the named slot |
| Decide that the read succeeded and confirm completion | Release payout only when proof and completion are both present |

In practice, the proof path is short and specific: the served bytes are checked against the relevant Blob commitment; that commitment is linked to the target user-data MDU; and that user-data MDU is linked to `manifest_root`. The witness MDUs supply the replicated metadata that makes that proof path portable.

The client decides whether the returned file is the one it wanted. The chain decides whether the provider satisfied a paid, authorized retrieval against committed data. It does not replay download scheduling, local reconstruction strategy, caching, or decryption.

## Worked Example: A 64 MiB Payload

Suppose an owner stores a **64 MiB payload**. Because an MDU is 8 MiB, the payload occupies exactly **8 user-data MDUs**. PolyFS then adds metadata on top of that payload: **`MDU #0` plus the required witness MDUs**. In other words, the **64 MiB figure refers to raw payload bytes only**. The full committed layout is 64 MiB **plus** metadata.

The owner prepares the deal in four steps:

1. Pack the payload into 8 user-data MDUs.
2. Generate `MDU #0` and the witness MDUs that describe the file layout and proof context.
3. Encode each user-data MDU under RS(8,12), producing 12 ordered slot positions per MDU.
4. Commit the resulting `manifest_root` on chain.

At that point, the deal has a compact on-chain trust anchor for the payload and its verification metadata without putting the raw object on chain.

Later, a reader asks for a **256 KiB** range inside one of those user-data MDUs. Because a Blob is 128 KiB, that request spans **two Blobs**.

The reader opens a retrieval session pinned to the deal, the current `manifest_root`, the relevant slot or provider responsibility, that two-Blob range, a payer, and an expiry. Using `MDU #0`, the client resolves the file path to the target user-data MDU and Blob positions. Using the replicated witness metadata, the client or provider obtains the proof context for those Blobs. The client then fetches the corresponding shard Blobs from any `K` healthy slots for that user-data MDU and reconstructs the requested bytes.

Verification proceeds in three linked steps:

1. the served shard or Blob bytes are checked against the relevant Blob commitment;
2. that Blob commitment is linked to the target **user-data MDU**;
3. that user-data MDU is linked to the deal’s committed **`manifest_root`**.

If the client reconstructs the requested bytes, verifies them locally, and confirms completion before expiry, the provider’s payout can be settled. If the session expires first, there is no completion payout. At no point does the chain need the full 64 MiB payload as the verification object.

## Why This Design Is Decision-Relevant

For an owner, PolyStore offers a small on-chain commitment, explicit control over who may open accountable reads, and a payment path tied to actual service.

For a provider, it offers explicit slot responsibility and a proof path that can be settled without trusting a gateway to speak for what was stored or served.

For the system as a whole, it keeps verification cheap enough to remain on chain because the chain only sees compact commitments, compact proofs, and session state rather than whole files.

PolyStore does not claim that access control equals privacy, or that gateways disappear. Sensitive data still needs client-side encryption. Gateways still help with packing, caching, and routing. The claim is narrower and more useful: if the protocol says a provider stored and served committed data, there is a compact path that can be checked against the same on-chain root that anchored the deal.

That is why PolyStore designs PolyFS, slot assignment, and retrieval sessions together rather than as separate layers.
