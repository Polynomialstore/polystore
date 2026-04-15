# PolyStore Litepaper

*Draft*

## The Core Claim

PolyStore is a decentralized storage protocol built around a narrow claim: storage only matters if the bytes can be retrieved under conditions that are direct, checkable, and economically accountable. A system that can produce isolated proof artifacts but cannot turn real reads into verifiable protocol events is solving the wrong problem.

PolyStore's answer is to organize files as PolyFS, commit that structure on chain through a compact `manifest_root`, and treat retrieval as a first-class protocol action. PolyFS is not just a packing format. It is arranged so data possession and served bytes can be checked through efficient KZG-backed proof paths, without forcing the chain to reason about whole raw files. The chain keeps a compact trust anchor. Providers move and serve the data off chain. Clients and the chain can still verify what was actually stored and served.

This is why PolyStore does not separate file layout, proof structure, and retrieval accounting into unrelated subsystems. PolyFS exists so retrieval can be direct, verifiable, routable, and settleable. Retrieval sessions exist so reads are not invisible side effects; they are named protocol events with a payer, a scope, a commitment root, and a completion condition.

The result is a storage protocol centered on getting bytes back under explicit rules, not just on watching providers pass background audits.

## PolyFS: How Files Become Verifiable Structure

PolyFS is the canonical file layout for a deal. Instead of handing providers an opaque object and hoping later proofs can somehow be attached to it, PolyStore turns the file into a structured layout whose internal units are aligned with retrieval and proof verification.

The basic units are Blobs and MDUs. A Blob is the atomic KZG verification unit. An MDU is the larger retrieval unit that groups Blobs into a layout that is practical for storage, routing, and reconstruction. In the current profile, a Blob is 128 KiB and an MDU is 8 MiB, so each MDU contains 64 Blobs.

PolyFS uses that structure in three layers. `MDU #0` is the filesystem anchor: it carries the file table and root table that let a client resolve a file path into byte ranges and committed storage units. Witness MDUs carry the commitment-bearing metadata needed to verify the structure efficiently. User-data MDUs carry the actual file bytes. The metadata MDUs are replicated. The user-data MDUs are the units that get striped across providers.

This matters because PolyFS is shaped for proof efficiency, not just for neat packing. The chain does not store whole-file state. It stores a compact `manifest_root` commitment that anchors the committed PolyFS structure. When a provider later proves possession or proves that it served a requested range, the proof path runs from the served bytes back through PolyFS and into that commitment root. The chain verifies compact openings against committed structure instead of carrying the overhead of raw-file verification.

That is the core advantage. PolyStore gets decentralized verification with low on-chain overhead because the file layout, commitment model, and retrieval path were designed together from the start.

## Retrieval Is the Protocol Center

Most storage systems treat retrieval as something that happens after the protocol has already decided who is healthy, who gets paid, and what counts as proof. PolyStore does not. In PolyStore, retrieval is the operational center of gravity.

A retrieval session binds the important facts of a read into one accountable object: which deal is being read, which committed `manifest_root` is being referenced, which provider or slot assignment is responsible, which blob-aligned range is being requested, who is paying, and when the request expires. That turns a read into something the protocol can reason about.

This changes the economic model. Providers do not receive protocol credit for vague availability claims. They receive credit for serving bytes that can be tied back to committed data. The user or requester does not just hope the data path worked; successful delivery is connected to proof submission and completion. The chain does not need to become a data mover, but it can still settle the event because the read is bound to a compact commitment and a concrete session.

The practical effect is that payment, verification, and actual demand point at the same thing. A retrieval is no longer a side channel bolted onto storage. It is the place where storage claims meet user reality.

## One File, End to End

Use one fixed example. A data owner wants to store a 64 MiB dataset shard. Under the current default profile, PolyFS packs that object into `MDU #0`, the required witness MDUs, and 8 user-data MDUs. Those 8 user-data MDUs hold the file's actual bytes. Each one is then encoded under the default RS(8,12) profile so it can be distributed across 12 assigned slots or providers.

The owner opens a deal and prepares the file as PolyFS. `MDU #0` records how the file maps into the deal. The witness MDUs carry the proof-oriented metadata. The 8 user-data MDUs carry the content itself. After striping, each assigned provider receives the shard data for its slots plus the replicated PolyFS metadata. Once the full layout is ready, the owner commits the resulting `manifest_root` on chain. At that point the deal has a compact on-chain trust anchor for the whole 64 MiB object without putting the raw file on chain.

Later, a reader wants one 256 KiB range inside one user-data MDU. Because PolyStore accounts in blob-aligned units, this retrieval corresponds to two 128 KiB Blobs. The reader opens a retrieval session naming the deal, the current `manifest_root`, the assigned provider or slot responsibility, the requested blob range, the payer, and the expiry. The session creates an accountable envelope for the read before any bytes move.

Providers then serve the needed bytes together with compact proof material tied to the committed PolyFS structure. The client verifies that the bytes came from the committed data, and the chain can verify the corresponding KZG-backed path rooted in `manifest_root` without treating the whole 64 MiB file as the verification object. The point is not that the chain replays the full retrieval. The point is that the retrieval can be checked against the same compact commitment that anchored the original deal.

Once the provider has supplied the required proof material and the session reaches completion, the protocol can settle the event. The read is no longer an off-ledger anecdote. It is a real protocol action: authorized, served, checked, and paid.

## Roles, Economics, and Scaling

The data owner's role is straightforward. Fund a deal, commit content, choose retrieval exposure, and, if confidentiality matters, encrypt before upload. PolyFS does not require the owner to trust a gateway as the source of truth. A gateway may help with convenience, packing, or routing, but the trust anchor is still the committed structure and the proof path back to `manifest_root`.

The provider role is also concrete. Providers store the shard data assigned to their slots, store the replicated PolyFS metadata, serve reads for the slots they are responsible for, and submit proof material tied to committed data. "Being fast" is not a slogan here. It means responding to retrieval demand in a way that can be checked and settled.

The money flow follows that operational model. A deal has a storage term and a retrieval path. Retrieval sessions consume budget when they are opened and settle when they complete. That means demand is not merely observed. It is priced and accounted for.

Scaling follows the same discipline. When demand grows, PolyStore's preferred expansion path is additional slot-aligned placements. The important point is that this is not fuzzy replication rhetoric. It is budgeted elasticity attached to the slot structure the protocol already uses for routing, accountability, and reconstruction.

## Why This Design Matters, and Where It Stops

PolyStore's main distinction is not that it has erasure coding, or KZG commitments, or a gateway, or a retrieval API. Those pieces exist elsewhere. The distinction is that PolyFS, compact commitments, retrieval sessions, and settlement are designed as one system. The file layout is chosen so decentralized verification remains practical. The retrieval path is chosen so real reads can count as accountable protocol work. The commitment model is chosen so the chain can anchor large datasets without turning into the storage layer itself.

That gives PolyStore a cleaner answer to a basic question: what should a storage protocol actually verify? The answer is not merely that a provider can answer synthetic challenges in the abstract. The answer is that committed data can be served back under explicit economic and cryptographic rules.

There are also clear limits. PolyStore is not a magical universal filesystem. It is a protocol for verifiable storage coordination and retrieval settlement. Encryption does not eliminate all metadata leakage by itself. Repair policy, long-horizon elasticity, and retrieval ergonomics still need disciplined design. None of those caveats weaken the core claim. They just keep it honest.

PolyStore should be understood as a system that organizes files as PolyFS so real reads can be verified, routed, and paid for under explicit on-chain rules.
