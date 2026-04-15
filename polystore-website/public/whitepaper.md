# PolyStore Whitepaper

*Research Draft*

## 1. Introduction: PolyFS Makes Retrieval Verifiable

PolyStore is a decentralized storage protocol built around a narrow technical claim: retrievability must be designed into the data layout itself. If a protocol stores data in one form, proves possession in another, and settles retrievals in a third, it will eventually force users to trust glue code, trusted gateways, or weak economic proxies. PolyStore's architecture is an attempt to remove that split.

The system's central design move is to organize content as PolyFS, commit the current PolyFS state on chain through a compact `manifest_root`, and make retrieval sessions the protocol object that connects real reads to settlement. PolyFS is not just a file layout. Its internal units are chosen so the same committed structure that anchors storage can also support efficient KZG-backed proof paths for possession and served bytes. The chain does not need to reason about whole files. It only needs to verify compact proofs against a small commitment root.

That property matters because the protocol is trying to solve a harder problem than "can a provider answer an audit challenge." It is trying to answer: how do we make stored data retrievable, verifiable, and economically accountable without turning the chain into the storage layer? PolyStore's answer is to keep the on-chain trust anchor compact, keep the off-chain data path direct, and make every meaningful retrieval event legible to the protocol.

This paper explains how that design choice propagates through file layout, commitments, placement, verification, pricing, and trust boundaries.

## 2. Problem Statement and Design Constraints

The protocol starts from a simple observation: users care about getting bytes back. A storage system that can emit proofs in isolation but cannot reliably connect those proofs to real retrieval demand is misaligned with the thing users actually buy.

That observation creates several constraints.

First, the chain cannot store or verify whole datasets directly. A storage protocol needs a compact commitment anchor that can stand in for a large object without becoming a second copy of the data.

Second, files cannot remain opaque blobs if the protocol wants efficient decentralized verification. Clients need to resolve file ranges deterministically. Providers need to know exactly what they are responsible for serving. The chain needs a way to verify specific retrieval claims against committed structure.

Third, placement cannot be left to ad hoc bilateral choice. Providers need to be assigned under anti-sybil, budget-aware rules so the protocol can reason about responsibility, routing, and payout.

Fourth, retrieval must be verifiable without trusting a gateway. A gateway may be convenient, but it cannot be the thing that makes a read believable. Verification has to survive direct-to-provider operation.

Fifth, verification overhead must stay low enough that on-chain checking remains practical. If every storage or retrieval claim drags the full raw file back into the verification path, the protocol loses the benefit of decentralized settlement.

Everything else in the design is downstream of those constraints.

## 3. System Overview: One Deal, One PolyFS, One Retrieval

The central on-chain object is the Deal. A Deal identifies the owner, the current committed content, the current provider assignment, the economic budget, and the retrieval policy. The Deal's main trust anchor is the current `manifest_root`, a compact KZG commitment for the committed PolyFS state of the deal.

The main actors are straightforward.

A data owner funds a Deal and commits content into it. A requester or reader opens retrieval sessions against that committed content. Storage providers hold assigned shard data and replicated metadata, serve reads, and submit proof material tied to what they stored and served. The chain anchors commitments, enforces session rules, and settles economic outcomes. A gateway may help with packing, routing, or local convenience, but it is an optional helper rather than a trust anchor.

The protocol's object model is equally compact. Files live inside PolyFS. PolyFS is made of MDUs and Blobs. The Deal stores a `manifest_root` that commits to the PolyFS state. Providers are assigned through an ordered slot map. Retrievals are represented by retrieval sessions that bind a read request to a concrete deal, commitment root, slot responsibility, range, payer, and expiry.

In one sentence, the system works like this: a file is packed into PolyFS, PolyFS is committed by `manifest_root`, the committed user-data units are striped across assigned providers, and later retrieval sessions authorize direct reads whose proof paths run back to the same commitment root.

## 4. PolyFS and the Commitment Model

PolyFS is the canonical file layout for a Deal. It exists to make file resolution, proof generation, and retrieval verification agree on the same structure.

The atomic cryptographic unit is the Blob. In the current profile, a Blob is 128 KiB. The larger retrieval unit is the MDU, or Mega-Data Unit. In the current profile, an MDU is 8 MiB, which means each MDU contains 64 Blobs. This pairing matters: Blobs are small enough to support efficient KZG-based verification, while MDUs are large enough to be practical for storage, striping, and range planning.

PolyFS organizes those units into three layers.

`MDU #0` is the filesystem anchor. It carries the file table and root table that let a client resolve a file path into byte ranges and MDU references. Witness MDUs carry commitment-bearing metadata that accelerate verification and make proof lookup practical. User-data MDUs carry the actual file bytes that the user cares about. The metadata MDUs are replicated across the assigned providers. The user-data MDUs are the units that become striped data.

The Deal does not place all of this state on chain. Instead, the chain stores a compact `manifest_root` commitment. Conceptually, that root anchors the committed MDU structure of the Deal. The important consequence is that later proofs do not have to reintroduce the full file as the verification object. They only need to show how a specific served byte range is connected to a Blob, how that Blob is connected to its containing MDU, and how that MDU is connected to the Deal's committed root.

This is why PolyFS is a proof-preserving layout rather than a neutral filesystem veneer. It does not fight the verification model. It keeps the internal boundaries aligned with the cryptographic atom, so KZG openings stay small and practical. That is what makes decentralized verification feasible at chain scale.

## 5. Striped Placement and Provider Responsibilities

PolyStore's canonical placement model is striped. In the current profile, each user-data MDU is encoded under RS(8,12): eight data slots and four parity slots. The ordered slot map determines which provider is responsible for each ordered slot. Metadata remains replicated. User data becomes striped shard data.

This arrangement gives the protocol three useful properties at once.

It gives reconstruction flexibility, because any valid `K` slots can reconstruct the user-data MDU. It gives accountability, because slot assignment makes provider responsibility explicit rather than implied. It gives routing structure, because a client can plan reads in terms of slots, active providers, and concrete MDUs instead of opaque replicas.

A provider's job is therefore specific. Store the shard Blobs assigned to its slot. Store the replicated PolyFS metadata. Serve reads for the slot responsibilities it holds. Submit proof material tied to the committed structure. In the striped model, provider responsibility is not vague availability. It is concrete responsibility for a position in a known slot layout.

This is also why PolyStore standardizes on striping as the core architecture rather than treating it as an optional flavor. The slot layout is not just a storage efficiency trick. It is the structure that makes routing, reconstruction, and accountability cohere.

## 6. Retrieval Sessions and Settlement

Retrieval sessions are the control-plane object that turns an off-chain byte transfer into a protocol event. Without them, a retrieval is just traffic. With them, a retrieval becomes authorizable, billable, and settleable.

A retrieval session binds the fields that matter: deal identity, provider or slot responsibility, the current `manifest_root`, the requested blob-aligned range, a payer, a nonce, and an expiry. The session's range is blob-aligned because the protocol's accounting and proof model operate at Blob granularity. A retrieval session may be owner-paid, requester-paid, or protocol-paid, depending on who is opening the read and under what policy. That funding distinction matters because public access should not silently drain the owner's long-lived storage escrow.

Once a session is open, serving nodes are expected to serve only within that session's declared scope. Off-chain delivery remains off chain, but it is no longer economically invisible. The provider serves the requested bytes and the associated proof material. The user or requester confirms completion. The provider submits proof-of-retrieval material. The chain can then decide whether the session has become `COMPLETED` under the protocol's rules.

This is the bridge between the data plane and the accounting plane. A provider is not paid merely for claiming that it responded quickly. It is paid when the retrieval has been opened under explicit funding rules, served within explicit scope, tied back to committed data, and completed under explicit confirmation rules.

In the current pricing model, that means retrieval fees are charged at session open and settled at completion. There is a base anti-spam fee, a variable fee tied to blob count, a completion payout to the provider, and defined expiry behavior for sessions that do not complete. Retrieval work is not merely observed. It is priced, bounded, and settled.

## 7. Verification Path: From Served Bytes Back to the Commitment

The whitepaper's central verification claim is that PolyStore can verify a specific retrieval claim against a compact on-chain root. That requires a clear proof path.

PolyStore's answer is the chained, or triple, proof architecture.

The first hop proves identity: the relevant MDU root is committed inside the Deal's manifest commitment. This is a KZG opening against `manifest_root` at the appropriate MDU index.

The second hop proves structure: the Blob commitment used for the retrieval is actually inside the target MDU. This is a Merkle-style structural proof over the MDU's commitment structure.

The third hop proves data: the served byte content is a valid opening of the Blob polynomial at the requested evaluation point. This is another KZG opening, now against the Blob commitment itself.

Taken together, those three hops let the verifier move from a concrete retrieval claim back to the compact root the Deal committed on chain. The chain does not need the whole file. It does not need to trust the gateway. It does not need to take the provider's word for what was served. It only needs the committed root and the compact proof path.

In the striped case, the slot map adds one more discipline: the proof must be attributable to the provider responsible for the relevant slot. That prevents the system from collapsing accountability into a generic multi-provider pool.

## 8. End-to-End Worked Example

Use one fixed example throughout the paper. A data owner wants to store a 64 MiB dataset shard. Under the current default profile, that object becomes `MDU #0`, the required witness MDUs, and 8 user-data MDUs inside PolyFS.

Each user-data MDU is then encoded under RS(8,12). The chain assigns 12 ordered slots with assigned providers. Providers receive the shard data for the slots they are responsible for, along with the replicated PolyFS metadata. Once the owner has prepared the full layout, the owner commits the resulting `manifest_root` on chain. The Deal now has a compact on-chain trust anchor for the full 64 MiB object.

Later, a reader wants a 256 KiB range inside one user-data MDU. Because the protocol is Blob-aligned, that request corresponds to two 128 KiB Blobs. The reader opens a retrieval session naming the Deal, the current `manifest_root`, the relevant provider or slot responsibility, the requested blob range, the payer, and the expiry.

To satisfy that session, the client resolves the file path through PolyFS, identifies the relevant user-data MDU and Blob range, selects the required healthy slots, fetches the slot data and proof material for that range, and reconstructs the requested bytes. The verification step is the important part: the verifier checks that the served bytes open against the Blob commitment, that the Blob commitment is proven inside the target MDU, and that the MDU is opened against `manifest_root`. The chain never needs to make the 64 MiB file itself the verification object.

Once proof material has been submitted and the user confirms successful completion, the session reaches its settled outcome. This one example is enough to show the protocol's whole spine: file layout, compact commitment, slot assignment, direct retrieval, proof path, and settlement.

## 9. Economics and Additional Slot-Aligned Placements

The protocol's economic model follows the retrieval-first architecture.

A Deal has a storage term and a retrieval path. Storage funding keeps the committed content available over time. Retrieval sessions draw explicit fees when users or other authorized requesters consume reads. Completion determines payout. This means provider compensation follows accountable service rather than generic background scoring.

The same logic governs scaling. If demand rises, PolyStore's preferred scaling path is not arbitrary extra replicas. It is additional slot-aligned placements that preserve the same routing and accountability structure as the base stripe. That matters because the protocol does not want to solve traffic spikes by escaping its own model.

At the same time, scaling is budgeted. New placements cost money. Elasticity therefore remains attached to explicit user or protocol budget rather than being treated as a free assumption. This is what keeps the throughput story economically disciplined.

## 10. Security, Privacy, and Trust Boundaries

PolyStore's integrity model is rooted in the commitment chain. If a provider serves wrong data, the proof path should fail. If a provider claims possession of data it does not hold, the KZG-backed opening path should fail. If a provider does not respond, the retrieval session or synthetic challenge path records the absence economically rather than hand-waving around it.

Its availability and accountability model is rooted in slot assignment plus retrieval sessions. The striped layout makes provider responsibility explicit. The session model makes retrieval demand explicit. Taken together, they let the protocol talk concretely about who was responsible for what service event.

Its anti-sybil position comes from deterministic placement and bounded assignment rules rather than from trusting users to choose honest providers. Its anti-wash position comes from the fact that retrievals are not free signaling games. Opening and settling retrievals has explicit cost and accounting consequences.

Privacy is narrower than integrity. PolyStore can support client-side encryption, and that is the right mechanism for confidentiality. But retrieval policy is not the same thing as privacy, and metadata does not disappear automatically. Providers may still learn operational facts such as object size, access timing, or assignment position unless those surfaces are separately minimized. Deletion is best understood through crypto-erasure and term-bounded garbage collection rather than through unverifiable promises of physical wipe.

The gateway boundary is also explicit. A gateway may help with packing, caching, reconstruction, and UX. It is not supposed to be the thing that makes a read trustworthy. The system should still make sense if the client talks to providers directly.

## 11. Client Roles, Scope Discipline, and Conclusion

PolyStore supports several client shapes without changing the trust model. A browser or WASM client can prepare or verify data locally. A gateway can act as a convenience layer for packing, caching, or routing. A provider daemon stores shards, serves reads, and submits proofs. The chain anchors commitments and settles accountable events. Those roles are different, but the trust anchor stays the same: committed PolyFS state plus proof paths back to `manifest_root`.

That division of labor is important because it keeps the protocol from collapsing into "the gateway is the system." The gateway is useful. It is not the source of truth.

The whitepaper's main claim is therefore simple. PolyStore works by choosing a file layout that preserves efficient decentralized verification, committing that layout compactly on chain, distributing responsibility through an ordered striped slot map, and treating retrieval sessions as the accountable event that connects real reads to economics. The protocol is not trying to prove that bytes exist in the abstract. It is trying to prove that committed bytes can be served back under explicit cryptographic and economic rules.

That is what PolyFS is for. That is why retrieval is first-class. And that is why a compact commitment can still anchor a real storage protocol.
