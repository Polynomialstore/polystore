# PolyStore Litepaper

*Revised Draft*

PolyStore is a decentralized storage protocol built around one simple claim: **retrieval is storage proof when it completes under protocol rules**. Instead of treating storage audits and user reads as separate systems, PolyStore turns retrieval into an accountable protocol event. A compact on-chain root anchors each committed generation, the chain assigns providers to ordered stripe slots, and completed retrieval sessions become evidence that the network is actually serving committed data.

This litepaper describes the canonical striped design at the protocol level. It is an overview, not a line-by-line specification.

## 1. Why decentralized storage still has a proof gap

Most decentralized storage systems split two questions that users experience as one.

The first question is whether a provider can pass an audit or periodic proof. The second is whether a user can actually retrieve the requested bytes, within a useful time window, from a provider that can be held accountable for the result. In many systems those answers come from different mechanisms: background storage proofs on one side, ordinary downloads or gateway behavior on the other.

That separation creates a persistent gap. A network can look healthy in audit terms while real reads are slow, expensive, hard to attribute, or hard to settle fairly. Users, however, do not buy abstract proof participation. They buy the ability to retrieve committed data when they ask for it.

PolyStore is designed around that operational reality. Its goal is not merely to show that someone probably still has data somewhere. Its goal is to make actual reads direct, checkable, attributable, and payable under one protocol model.

## 2. PolyStore’s core claim: Unified Liveness

PolyStore closes the proof gap by treating retrieval as the primary liveness event. A completed retrieval session is not just a download that happened to pass through the network. It is protocol evidence that assigned providers served committed data under a pinned scope and within explicit settlement rules.

This is the protocol’s **Unified Liveness** model: **retrieval is storage proof** when it completes under protocol rules.

That matters for both hot and cold data. When demand is organic, real user retrievals supply the evidence. When demand is low, the protocol can open the same kind of session itself and act as the **user of last resort**. Synthetic retrieval is therefore not a separate trust model layered beside ordinary reads. It reuses the same accountable session path.

The result is a demand-driven performance market. Providers do not earn only for claiming long-term possession in the abstract. They earn for completing retrieval sessions that prove they can serve committed data when demand appears, whether that demand comes from users or from the protocol’s own synthetic checks.

PolyStore makes three narrower verification claims inside that model:

- it can verify that specific served shard or Blob bytes belong to a committed generation;
- it can verify that a requested logical range is reconstructable from any `K` healthy slot contributions per affected row under the deal’s striped profile; and
- it can verify that a paid retrieval session completed under protocol rules and should settle.

The second claim is intentionally operational. It is a claim about reconstructability of requested ranges under a striped retrieval model, not a consensus-style data-availability-sampling claim.

The blockchain’s role is therefore specific. It does not store raw files. It anchors one compact `manifest_root` for each committed generation, assigns providers to ordered slot responsibilities, authorizes and funds retrieval sessions, verifies the compact proof and completion conditions needed for settlement, and turns completed retrievals into attributable liveness evidence.

## 3. One committed generation at a time

A PolyStore Deal is mutable as an on-chain object, but its content is not treated as mutable in place. Every content update produces a new committed **generation** with a new `manifest_root`.

That generation model matters because retrieval must remain unambiguous while content changes, repairs, or later updates happen elsewhere in the system. PolyStore therefore uses a strict rule: a retrieval session is pinned to the generation that is current at the moment the session opens. It does not float to a newer root later.

If a Deal advances from generation `H1` to `H2` while a read against `H1` is still in flight, the open session remains bound to `H1`. New reads may target `H2`, but the old session does not silently migrate. That keeps retrieval, proof verification, and settlement scoped to one immutable snapshot.

Updates follow compare-and-swap semantics. The signed update names the previous `manifest_root` it expects to replace. The chain rejects the write if the Deal has already advanced in the meantime. That prevents concurrent writers, stale gateways, or stale local state from overwriting the wrong generation.

Inside each generation, PolyStore uses **PolyFS**, the deal filesystem that makes files path-resolvable, proof-addressable, and stripeable under one committed root.

> Current protocol constants: **Blob = 128 KiB** and **MDU = 8 MiB**. The default striped profile is **RS(8,12)**.

PolyFS organizes a generation into three functional layers:

- **`MDU #0`** is the filesystem anchor used for path resolution.
- **Witness MDUs** carry proof-index metadata that helps any assigned provider assemble proof paths.
- **User-data MDUs** carry the committed payload bytes that are later striped across slots.

The key design point is not the naming. It is the alignment. The structure that tells a client where a file lives is also the structure that tells the client how to verify served bytes and how to plan reconstruction.

## 4. Placement and retrieval

PolyStore’s canonical placement model uses an ordered slot map rather than vague replica ownership. Clients may express hot or cold intent, but placement remains system-defined. The chain assigns providers to named slot positions drawn from the eligible set, which reduces direct self-dealing and makes responsibility attributable.

For striped user data, responsibility attaches to the slot, not to a general claim like “one of the replica holders.” Under the default RS(8,12) profile, each row can be reconstructed from any 8 healthy slots, so up to 4 missing slots per row can be tolerated.

```text
metadata ........ replicated to all assigned providers
user-data row ... slot0 slot1 slot2 slot3 slot4 slot5 slot6 slot7 slot8 slot9 slot10 slot11

retrieve from any 8 healthy slots for that row
```

A protocol-accounted read then follows one control-plane path:

1. The client resolves the requested file path and byte range from replicated metadata.
2. For each affected row, the client chooses healthy slots.
3. The client opens retrieval sessions pinned to the Deal, the generation current at session open, the named slot responsibilities, the requested Blob-aligned range, the payer, and the expiry.
4. Providers serve the requested shard Blobs directly, or through an optional gateway that helps with routing or caching.
5. The client verifies the returned shard Blobs, reconstructs the requested logical bytes from any `K` healthy slot contributions, and decides whether the read completed successfully.
6. The session settles only if the required proof material and the completion signal arrive before expiry.

This flow makes retrieval legible to the protocol. The bytes move off-chain, but the session boundary, proof boundary, and settlement boundary are explicit.

The client is responsible for path resolution, slot selection, and immediate verification of the bytes it is about to use. The chain is responsible for compact proof validation, expiry rules, and the settlement conditions that determine whether the session completed.

Funding is explicit as well. Retrieval sessions may be **owner-paid**, **requester-paid**, or **protocol-paid**. That matters because public or third-party reads do not need to silently drain long-term storage escrow, and cold-data checks can be funded by the protocol itself without introducing a separate audit system.

The same model also makes failure legible. A session can expire. A provider can fail to answer. A client can route around an unhealthy slot and open a new session against another healthy slot. The replacement read is a new accountable event, not an invisible retry buried inside an off-chain gateway.

## 5. Triple Proof: how a compact root verifies a read

PolyStore does not ask the chain to store full files or replay full retrievals. It asks the chain to anchor one compact `manifest_root` and verify that served bytes link back to that root through a bounded proof path.

That path is the **Triple Proof**:

```text
manifest_root
   -> target MDU root
      -> shard/blob commitment
         -> served bytes
```

In plain language, the verifier checks three linked facts:

1. the committed generation includes the target MDU;
2. the target MDU includes the relevant shard or Blob commitment; and
3. the served bytes are a valid opening of that commitment.

Witness MDUs help providers and clients assemble that path, but the proof claim remains about the user-data bytes being served, not about witness bytes themselves.

This is why the protocol can keep the trust anchor small. Verification stays at Blob-sized units and MDU-local structure. The system does not need to drag entire raw files on chain to verify a real read. It verifies exactly the committed data that was served and exactly the sessions that are meant to settle.

## 6. What this architecture buys

The first consequence is **accountable retrieval**. PolyStore does not rely on a vague statement that storage and retrieval are somehow related. It uses the same session object to authorize the read, bind it to a pinned generation, prove the served bytes, and settle the event. Real retrievals become real evidence.

The second consequence is **parallel fan-out with bounded outage tolerance**. A large read does not need to wait on one full replica holder when the requested rows can be reconstructed from any `K` healthy slots. Under the default RS(8,12) profile, a row remains readable through up to four missing slots, and the client can pull shard contributions from multiple providers in parallel.

The third consequence is **direct verification without a privileged gateway**. Gateways may still help with packing, routing, caching, proof assembly, or UX, but they are optional helpers. A client can verify served bytes against the committed generation root without trusting a gateway to be the source of truth.

The fourth consequence is a clearer separation between **integrity**, **availability**, and **confidentiality**. Integrity comes from the Triple Proof back to `manifest_root`. Reconstructability comes from obtaining enough valid slot contributions under the striped profile. Confidentiality comes from client-side encryption, not from retrieval policy alone.

Those properties support three natural operating modes:

- **Hot public content**, where parallel reads and explicit retrieval funding matter most.
- **Private encrypted datasets**, where served bytes must still be verifiable even though confidentiality lives above the storage layer.
- **Cold archival content**, where the protocol can become the user of last resort and maintain liveness through synthetic retrieval sessions.

## 7. Trust boundaries, current status, and next steps

PolyStore’s integrity model is narrower than its marketing risk would suggest, and that is deliberate.

It does not claim that access control is the same as privacy. Restricted retrieval policy controls who may open user or sponsored retrieval sessions, but confidentiality still depends on client-side encryption. It does not claim that gateways disappear. Gateways remain useful for convenience and performance, but they are not the trust anchor. It does not claim that a compact root removes all retrieval complexity. The protocol still has to plan slot selection, move bytes, and handle failure explicitly.

This litepaper also distinguishes the canonical design from the full roadmap. The striped generation model, ordered slot accountability, retrieval-session funding and settlement model, and Triple Proof are the design center. Historical full-replica behavior is compatibility only. The document should not be read as a claim that every policy module is already shipped end to end. Some broader policy layers remain under active development, including elastic multi-stripe scaling, provider rotation and rebalancing, deputy or proxy serving patterns, and some quota and penalty parameters for long-horizon challenge policy.

The core thesis does not depend on every one of those policy layers being finalized. One compact generation root, explicit generation pinning, system-defined placement, slot-accountable striping, and sessionized retrieval are already enough to state the protocol’s main claim clearly:

**decentralized storage should prove itself through served bytes, not only through separate audit theater.**

By making retrieval the accountable event, PolyStore ties storage, performance, and payment to the same read path.
