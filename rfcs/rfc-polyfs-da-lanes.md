# RFC: PolyFS DA Lanes and Availability Certificates

**Status:** Proposed / research-track candidate
**Scope:** Protocol, PolyFS, chain state, gateway APIs, storage economics
**Depends on:**
`whitepaper.md`,
`rfcs/rfc-blob-alignment-and-striping.md`,
`rfcs/rfc-polyfs-generation-cas-and-staged-writes.md`,
`rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`,
`rfcs/rfc-challenge-derivation-and-quotas.md`,
`rfcs/rfc-mode2-onchain-state.md`,
`rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`,
`rfcs/rfc-pricing-and-escrow-accounting.md`,
`rfcs/rfc-polyfs-root-contract.md`

-----

## 1. Summary

This RFC proposes **PolyFS DA Lanes**: append-only publication streams backed by
PolyStore deals that can produce explicit **Availability Certificates**.

The intended product is not "current PolyStore storage deals are already a
complete DA layer." The intended product is:

> Applications publish erasure-coded batches to a PolyStore DA Lane, receive an
> availability certificate under a documented sampling/attestation policy, and
> keep the same data retrievable through PolyStore's paid, provable, repairable
> storage layer.

This proposal keeps historical DA archival/retrieval as the near-term product
wedge while defining the technical bridge toward publication-time availability
and a full DAS research track.

-----

## 2. Motivation

DA systems answer a different question than archive systems.

* Historical archive/retrieval asks: **can old data be found, verified, and
  served later?**
* Publication-time DA asks: **was the data behind a newly published commitment
  made available widely enough before downstream systems accepted that
  commitment?**

PolyStore already has many primitives that map well to the second question:

* pinned PolyFS generations and compare-and-swap root updates;
* 128 KiB KZG-aligned blobs and 8 MiB MDUs;
* RS(8,12) striping and accountable provider slots;
* replicated metadata and witness MDUs;
* chained proofs from a PolyFS root to served bytes;
* mandatory retrieval sessions that pin deal, root, slot, range, payer, nonce,
  and expiry;
* public, sponsored, requester-funded, and protocol-funded retrieval flows;
* synthetic liveness and provider-health accounting; and
* repair and provider rotation.

Those primitives make PolyStore a plausible substrate for a DA-style system, but
they do not yet define the missing publication-time semantics: append-only
batch ordering, public write admission, sample-coordinate grammar, delayed
randomness, certificate state, and encoding-correctness evidence.

-----

## 3. Goals

1. Define a formal product/protocol abstraction for DA publication on top of
   PolyStore storage deals.
2. Separate near-term append-only lane work from stronger DAS claims.
3. Specify the chain objects and message shapes needed for DA lanes and
   availability certificates.
4. Reuse existing PolyStore primitives wherever possible.
5. Make provider accountability, retrieval payment, and post-certification
   repair first-class properties of the DA design.
6. Identify the research questions that must be answered before PolyStore can
   make strong light-client DAS claims.

-----

## 4. Non-Goals

This RFC does not:

* claim current PolyStore deals are already a complete consensus DA layer;
* replace the historical DA archive/retrieval strategy;
* specify a final probability bound for every sampling profile;
* define final slashing economics for DA certification failures;
* require a new consensus protocol for PolyStore;
* require every storage provider to store every byte;
* define an L1 bridge contract in detail; or
* implement the proposed messages or state machines.

-----

## 5. Market and Design Context

The DA market is already a named category. Celestia, Ethereum PeerDAS, Avail,
and EigenDA converge around the same primitive set: erasure coding, commitments,
sampling or attestations, and a compact result that rollups or other execution
systems can rely on.

The market is not buying generic storage. It is buying assurances:

* the data behind a batch was actually published;
* withholding is detectable or economically costly;
* light clients or validators do not need to download the whole batch;
* downstream systems can reference a compact commitment or certificate; and
* enough honest participants can recover the data during the relevant window.

PolyStore's differentiated claim should therefore be narrow and stronger:

> Most DA systems optimize publication. PolyStore can join publication-time
> availability with long-lived, paid, provable retrieval.

This RFC intentionally avoids claiming the broadest possible DA throughput or
security model before the sampling math and encoding-correctness path are
formalized.

-----

## 6. Terminology

| Term | Meaning |
|---|---|
| **Deal** | Existing PolyStore storage/economic object. Deals remain the substrate for provider placement, escrow, retrieval policy, roots, and repair. |
| **PolyFS generation** | Immutable committed content state identified by a PolyFS root. |
| **DA Lane** | Append-only publication stream backed by one or more deals. |
| **Batch** | One ordered publication unit in a DA Lane. |
| **Publisher** | Account authorized to append a batch to a lane. |
| **Availability Certificate** | Compact record that a batch passed a lane-defined availability policy. |
| **Sample coordinate** | Deterministic coordinate used to request and verify one availability sample. |
| **Sampler** | Actor or protocol process that opens sample sessions and submits evidence. |
| **user-gateway** | Optional client-side or service-side helper that stages, encodes, routes, and queries data. |
| **provider-daemon** | Storage-provider runtime responsible for receiving shards, storing slot data, serving samples, and producing proofs. |

-----

## 7. Design Principle

Deals and DA lanes should not be collapsed into one object.

Deals answer:

* who stores this content;
* what root is current;
* what retrieval policy applies;
* how providers are paid or penalized;
* how repairs are performed; and
* how bytes are retrieved.

DA lanes answer:

* who may publish;
* what order batches were appended in;
* what batch roots and certificates exist;
* what availability policy was used; and
* how external systems reference a published batch.

The lane is the publication abstraction. The deal is the storage and economic
substrate.

-----

## 8. Proposed Chain Objects

### 8.1 `DALane`

```protobuf
message DALane {
  uint64 lane_id = 1;
  string owner = 2;
  WriterPolicy writer_policy = 3;
  RetrievalPolicy retrieval_policy = 4;
  repeated uint64 backing_deal_ids = 5;
  bytes current_lane_root = 6;
  uint64 next_batch_id = 7;
  string erasure_profile = 8;
  RetentionPolicy retention_policy = 9;
  FeePolicy fee_policy = 10;
  CertificatePolicy certificate_policy = 11;
  uint64 created_height = 12;
}
```

Notes:

* `backing_deal_ids` lets one lane start on one deal and later support sharded
  or capacity-expanded layouts.
* `current_lane_root` is the append-only root over batch descriptors, not
  necessarily the same value as a deal's current PolyFS root.
* `writer_policy` controls admission. It is separate from retrieval policy.

### 8.2 `DABatch`

```protobuf
message DABatch {
  uint64 lane_id = 1;
  uint64 batch_id = 2;
  string publisher = 3;
  bytes batch_data_root = 4;
  bytes polyfs_root_or_segment_root = 5;
  bytes previous_lane_root = 6;
  bytes new_lane_root = 7;
  string namespace_or_app_id = 8;
  uint64 size_bytes = 9;
  uint64 total_mdus = 10;
  uint64 witness_mdus = 11;
  string encoding_profile = 12;
  BatchStatus status = 13;
  uint64 publish_height = 14;
  uint64 certificate_id = 15;
  repeated DABatchStorageSegment storage_segments = 16;
}

message DABatchStorageSegment {
  uint64 deal_id = 1;
  bytes polyfs_root_or_segment_root = 2;
  uint64 logical_offset = 3;
  uint64 length = 4;
  uint64 first_mdu = 5;
  uint64 mdu_count = 6;
  uint64 deal_generation = 7;
  uint64 deal_root_height = 8;
  uint64 deal_end_block = 9;
}
```

`batch_data_root` is the external DA-facing root. `polyfs_root_or_segment_root`
is the PolyStore storage-facing root or segment root used to retrieve and prove
the underlying bytes. `storage_segments` is the authoritative lane-to-deal
mapping for retrieval and sampling. It lets a lane expand across multiple
backing deals while preserving enough information to open deal-scoped
retrieval/sample sessions for `(lane_id, batch_id, range)` later. Each segment
also binds the committed PolyFS generation and chain height that made the segment
valid, so older certified batches remain addressable after a backing deal
advances to a later root. `deal_end_block` snapshots the backing deal term used
for retention validation. Certificates MUST NOT advertise retention past the
minimum backing deal end block for their segments unless an on-chain renewal or
migration updates the segment's backing term first.

### 8.3 `AvailabilityCertificate`

```protobuf
message AvailabilityCertificate {
  uint64 certificate_id = 1;
  uint64 lane_id = 2;
  uint64 batch_id = 3;
  bytes batch_data_root = 4;
  bytes polyfs_root_or_segment_root = 5;
  string erasure_profile = 6;
  bytes provider_set_hash = 7;
  uint64 sample_policy_id = 8;
  uint64 sample_seed_height = 9;
  bytes sample_result_root = 10;
  uint64 certified_height = 11;
  uint64 retention_until = 12;
  CertificateStatus status = 13;
}
```

The certificate is historical. If later retrieval failures occur, they should
be represented as service-health or degradation evidence. They should not
rewrite the fact that a certificate was issued under a specific policy at a
specific height.

-----

## 9. Proposed Messages

### 9.1 `MsgCreateDALane`

Creates an append-only lane backed by one or more existing deals.

Required checks:

* sender is authorized to create the lane;
* backing deals exist and are compatible with the lane's erasure profile;
* retrieval policy is compatible with the intended public/sponsored sampling
  behavior;
* fee policy can fund publication, certification, and retrieval/audit costs; and
* certificate policy is a recognized protocol policy.

### 9.2 `MsgAppendDABatch`

Appends a pending batch to a lane.

Required fields:

* `lane_id`
* `previous_lane_root`
* `batch_data_root`
* `polyfs_root_or_segment_root` as the storage-facing root/index commitment
  for the batch;
* `storage_segments`, with each segment binding `(deal_id,
  polyfs_root_or_segment_root, logical_offset, length, first_mdu, mdu_count,
  deal_generation, deal_root_height, deal_end_block)`;
* `namespace_or_app_id`
* `size_bytes`
* `total_mdus`
* `witness_mdus`
* `encoding_profile`
* publisher authorization
* publication fee

Required checks:

* lane exists;
* publisher satisfies `writer_policy`;
* `previous_lane_root == lane.current_lane_root`;
* batch size and fee satisfy lane policy;
* every `storage_segments[*].deal_id` is one of the lane's backing deals;
* `storage_segments` covers exactly `size_bytes` with no gaps, overlaps, or
  zero-length segments, and the MDU ranges are compatible with `total_mdus` and
  `witness_mdus`;
* every segment's `(deal_id, deal_generation, polyfs_root_or_segment_root)` maps
  to a committed or pending-to-be-committed PolyFS root transition;
* every segment's `deal_end_block` matches the backing deal state and is high
  enough to satisfy the lane's required retention target, or the batch is marked
  ineligible for certification until the segment is renewed or migrated;
* backing deal root/segment state is known or staged for every segment;
* duplicate batch roots are rejected unless a policy explicitly allows
  idempotent retry; and
* the batch enters `PENDING_DISPERSAL` or `PENDING_RANDOMNESS`, not
  `CERTIFIED`.

The top-level `polyfs_root_or_segment_root` is not a substitute for
`storage_segments`. It can be retained as a compact storage-facing commitment for
single-deal or indexed layouts, but the segment list is the canonical input for
later retrieval and sampling sessions.

### 9.3 `MsgSubmitProviderReadiness`

Lets provider-daemons attest that they have staged their assigned artifacts for
a pending batch.

The attestation should bind:

* lane id;
* batch id;
* provider identity;
* slot id;
* expected root;
* staged artifact digest;
* artifact size;
* expiry; and
* provider signature.

### 9.4 `MsgOpenDASampleSession`

Opens a sample session for one coordinate.

This MAY be implemented as a specialized retrieval session purpose rather than
a fully separate object, but the semantic fields must include:

* lane id;
* batch id;
* sample coordinate;
* provider slot;
* pinned PolyFS root or segment root;
* payer/funding source;
* nonce; and
* expiry.

### 9.5 `MsgSubmitDASampleProof`

Submits sample evidence for one session or a batch of sessions.

The proof must bind:

* sample session;
* sample coordinate;
* provider slot;
* relevant commitment;
* PolyFS inclusion path;
* KZG opening or equivalent cell proof; and
* served sample bytes or cell data.

### 9.6 `MsgFinalizeAvailabilityCertificate`

Finalizes or fails the pending batch after the lane's certificate policy is
evaluated.

Possible outcomes:

* `CERTIFIED`
* `FAILED`
* `EXPIRED`

The finalization transaction should record the sample policy, sample result
root, provider set hash, and certified height.

Required checks:

* every segment's `(deal_id, deal_generation, polyfs_root_or_segment_root)` is
  committed in the backing deal state, with `deal_root_height` populated from
  that committed transition;
* `retention_until` is no greater than the minimum `deal_end_block` across the
  batch's `storage_segments`;
* `retention_until` satisfies the lane's retention policy; and
* if the lane retention target extends beyond any backing deal term, the batch
  MUST remain uncertified until the affected segments are renewed, extended, or
  migrated to a backing deal whose term covers the advertised retention.

-----

## 10. State Machines

### 10.1 Batch status

```text
PENDING_DISPERSAL
  -> PENDING_RANDOMNESS
  -> SAMPLING
      -> CERTIFIED
      -> FAILED
      -> EXPIRED
```

Rules:

* A batch MUST NOT become `CERTIFIED` before the delayed-randomness and
  sampling/attestation policy has completed.
* `CERTIFIED`, `FAILED`, and `EXPIRED` are sibling terminal outcomes of the
  pending/sampling path. A certified batch MUST NOT later be rewritten as a
  failed or expired batch.
* A batch MUST NOT silently mutate after append. Any change creates a new batch
  or an explicit failed/replaced status.
* A stale `previous_lane_root` MUST reject the append.
* Expired pending batches MUST be visible so publication failures are
  inspectable.

### 10.2 Certificate status

```text
ISSUED
  -> DEGRADED
  -> RETIRED
```

`DEGRADED` is optional in the first implementation. It is useful when later
retrieval evidence shows the certified data is no longer meeting service
expectations. Degradation does not mean the original certificate was invalid.

-----

## 11. Sampling Model

The first research model should evaluate this profile:

* data is encoded into `N` provider slots with `K`-of-`N`
  reconstructability;
* default candidate profile is RS(8,12), matching the current Mode 2 design;
* each user-data MDU has sample coordinates derived from `(mdu_index,
  leaf_index, slot, row)`;
* challenge seed is unknown until after staged upload and pending batch
  publication;
* protocol or third-party samplers open sample sessions for `s` coordinates;
* provider-daemons return proof material before expiry; and
* the certificate policy determines whether enough evidence exists to certify
  the batch.

Open policy questions:

* Are sample coordinates uniform across all slots or weighted by capacity,
  stake, bond, or provider reputation?
* Does a certificate require readiness from all slots, at least `K` slots per
  row, or a separate quorum threshold?
* Does failure of a parity slot block certification or only create degraded
  service health?
* Can any third party submit successful samples, or only selected samplers?
* What confidence bound is advertised for a given batch size, sample count, and
  withholding strategy?

The first production claim should be an explicitly named policy, such as:

> Certified under PolyStore DA Lane Policy v0 with sample count S, delayed
> randomness source R, provider set P, and confidence model M.

It should not claim generic Celestia-equivalent DAS before the proof is written.

-----

## 12. Encoding Correctness

Encoding correctness is the deepest research requirement.

If a malicious publisher or user-gateway creates malformed parity data, local
sample proofs may verify while global reconstruction fails. A DA lane must
therefore define how verifiers know the encoded shards match the source batch.

Candidate approaches:

1. **Fraud proof path**
   * Providers and third parties can reconstruct rows and submit invalid
     encoding evidence.
   * Lower proving cost up front.
   * Requires a fraud window and clear challenge incentives.

2. **Provider-side verification**
   * Provider-daemons verify assigned shards against a disperser proof or
     deterministic reconstruction rule before readiness attestation.
   * Moves more work to providers.
   * Gives readiness attestations more meaning.

3. **KZG homomorphism checks**
   * Use the homomorphic properties already relevant to RS parity commitments.
   * Potentially compact.
   * Needs formalization and test vectors for the exact PolyStore profile.

4. **Validity proof**
   * Publisher or disperser proves the encoded data is correctly derived.
   * Strongest certification surface.
   * Heaviest implementation and proving requirement.

This RFC recommends starting with a formal fraud-proof plus provider-verification
design, then evaluating whether KZG homomorphism gives a compact first-class
check for RS(8,12).

-----

## 13. Retrieval and Payment Semantics

DA sampling should reuse the mandatory retrieval-session architecture wherever
possible.

Rules:

* Sample sessions SHOULD be paid or explicitly protocol-funded.
* Public lanes SHOULD allow third-party funded samples and retrievals.
* A lane MUST NOT let third-party verification drain the publisher's escrow
  unless the lane explicitly sponsors that behavior.
* Samples, user reads, protocol audits, and repairs SHOULD feed one provider
  service-history surface.
* Post-certification retrieval failures SHOULD affect provider health and repair
  state even when the original certificate remains historically valid.

This is PolyStore's main differentiation: publication-time availability and
long-lived retrieval accountability share one economic proof surface.

### 13.1 Historical-Generation Sessions

Current retrieval sessions are rooted in the backing deal's current committed
PolyFS root. DA lanes need one additional mode because certified batch history is
append-only while backing deals may continue to advance.

For DA lane retrieval and sampling, the session opener MUST resolve
`(lane_id, batch_id, range)` to the batch's `storage_segments`, then open a
session against the recorded `(deal_id, deal_generation,
polyfs_root_or_segment_root, logical_offset, length)` tuple. A historical segment
is valid if:

* the referenced batch is `CERTIFIED` or still within an active certification
  window;
* the segment's `deal_root_height` proves that the root was committed for the
  backing deal;
* the requested byte range is covered by the segment list; and
* the segment is still inside both the lane's retention window and the backing
  deal term recorded by `deal_end_block`.

This requires providers and gateways to keep DA-retained committed generations
addressable by `(deal_id, deal_generation/root)` even when the deal's current
root has moved forward. The current-root retrieval rule remains correct for
ordinary mutable PolyFS reads; DA lane reads use the certificate and segment
metadata as the authorization to open a historical-generation session.

Historical-generation sessions MUST also obey the underlying deal/session
constraints: the backing deal must still be active at session open, and the
session expiry MUST be no later than both the lane retention deadline and the
segment's `deal_end_block`. If a lane needs to retain a certified batch beyond
the original backing deal term, the lane must renew the deal or migrate the
segment before issuing or maintaining that retention claim.

If an implementation does not support historical-generation sessions, it MUST use
immutable backing deals or otherwise ensure that every certified segment remains
the current retrievable root for its full retention period. That mode is simpler
but less capacity-efficient, so it should be treated as a fallback rather than
the preferred DA lane design.

-----

## 14. Gateway and Provider Requirements

### 14.1 user-gateway

The user-gateway should support:

* batch packing;
* deterministic erasure encoding;
* append-only lane submission;
* staged artifact upload;
* certificate polling;
* range retrieval by `(lane_id, batch_id, range)`, including segment-generation
  resolution;
* namespace or application id lookup; and
* proof bundle export.

### 14.2 provider-daemon

The provider-daemon should support:

* validating staged artifact headers;
* rejecting stale expected roots before accepting large uploads;
* binding stored artifacts to lane id, batch id, slot id, and root;
* keeping DA-retained committed generations addressable until their retention
  windows expire or their backing deal terms end;
* surfacing renewal or migration requirements before a certified segment's
  backing deal term falls below the advertised retention window;
* readiness attestation;
* sample serving;
* sample proof construction;
* repair participation; and
* service-health reporting.

-----

## 15. Security Considerations

### 15.1 Publisher withholding

Risk: a publisher gets a batch certified while withholding enough data that
reconstruction later fails.

Required work:

* model withholding under RS(8,12);
* quantify sample counts against partial withholding;
* define invalid encoding evidence;
* define challenge windows; and
* define submitter rewards or provider/publisher penalties.

### 15.2 Provider collusion

Risk: assigned providers answer samples but later fail broad retrieval.

Required work:

* quantify failure under slot concentration;
* connect placement policy to anti-Sybil assumptions;
* consider bond/stake/capacity weighting for certificate claims;
* expose provider-set hash in certificates; and
* treat later retrieval failures as economic evidence.

### 15.3 Sampling grinding

Risk: a publisher predicts sample coordinates and only makes those coordinates
available.

Required work:

* use delayed randomness;
* commit staged artifacts before the sample seed is known;
* prevent artifact rewriting after seed;
* bind samples to batch root and provider set; and
* reject certification if artifact commitments are not fixed before randomness.

### 15.4 Encoding fraud

Risk: malformed parity makes samples pass but reconstruction fail.

Required work:

* define row-level reconstruction fraud proofs;
* define compact parity commitment checks if possible;
* require provider verification before readiness where feasible; and
* produce canonical test vectors.

### 15.5 Data equivocation

Risk: a user-gateway or publisher serves inconsistent staged data to different
providers.

Required work:

* bind uploads to lane id, batch id, expected root, provider slot, and artifact
  digest;
* require provider-daemons to verify staged headers;
* include artifact digests in readiness attestations; and
* make mismatches certificate-failing evidence.

-----

## 16. Compatibility and Migration

This proposal is additive.

* Existing deals continue to work as storage deals.
* Existing historical DA archive/retrieval positioning remains valid.
* Existing public and sponsored retrieval policy can be reused by DA lanes.
* Existing retrieval sessions can likely be extended with a new purpose instead
  of replaced.
* Existing Mode 2 state is the preferred backing layout for the first lane
  profile.

The main compatibility risk is root terminology. New DA-lane objects should use
`polyfs_root` or `polyfs_segment_root` terminology. If legacy fields such as
`manifest_root` are reused for transition, they must be documented as aliases
only.

-----

## 17. Phased Plan

### Phase 0: Research specification

Deliverables:

* sample-coordinate grammar;
* certificate policy v0;
* encoding-correctness proposal;
* withholding probability model;
* provider-collusion model;
* sample-session economics; and
* bridge/API requirements.

Exit criteria:

* one accepted research RFC or annex;
* test-vector plan for encoding/proof verification;
* clear claims and non-claims for public messaging.

### Phase 1: Append-only lane prototype

Deliverables:

* `DALane` state;
* `DABatch` state;
* `MsgCreateDALane`;
* `MsgAppendDABatch`;
* lane-level CAS;
* batch root history;
* user-gateway append API;
* retrieval by `(lane_id, batch_id, range)`.

Exit criteria:

* append-only storage lane works over existing deals;
* no full DAS claim is made;
* stale append and concurrent append tests pass.

### Phase 2: Certificate MVP

Deliverables:

* provider readiness attestation;
* delayed-randomness sample selection;
* protocol-funded sample sessions;
* `AvailabilityCertificate` state;
* certificate query API;
* failed and expired batch states;
* provider health effects from failed samples.

Exit criteria:

* batches can move from pending to certified/failed/expired;
* certificates expose policy and assumptions;
* proof failures are attributable.

### Phase 3: DAS hardening

Deliverables:

* confidence-bound documentation;
* invalid-encoding evidence;
* sample aggregation;
* collusion simulations;
* lane economics simulations;
* bridgeable certificate verifier.

Exit criteria:

* credible security model for a named lane policy;
* no unresolved overclaim in public positioning;
* at least one design partner can evaluate the claim.

### Phase 4: Rollup integration

Deliverables:

* generic DA client SDK;
* OP Stack alt-DA prototype or equivalent integration;
* certificate polling;
* fallback retrieval from PolyStore;
* archive continuity after DA window;
* coverage/health dashboard.

Exit criteria:

* one live design partner demo;
* end-to-end publish, certify, retrieve, and verify workflow.

-----

## 18. Product Positioning

Suggested name family:

* PolyStore DA Lanes
* PolyFS Availability Certificates
* PolyStore Availability Service
* PolyDA, only after the security model is strong enough

Suggested one-liner:

> PolyStore DA Lanes let applications publish erasure-coded batches, receive an
> availability certificate, and keep the same data retrievable through paid,
> provable, repairable storage.

Suggested technical claim before full DAS proof:

> PolyStore can evolve from historical DA retrieval into a publication and
> retrieval layer where availability samples, user reads, repairs, and provider
> accountability share one economic proof surface.

Suggested claim to avoid:

> PolyStore is already a Celestia replacement.

-----

## 19. Open Questions

1. What is the exact confidence bound for sample counts under RS(8,12)?
2. Should certificate policies be slot-weighted, stake-weighted, capacity
   weighted, or bond weighted?
3. Can KZG homomorphism over the current RS parity construction support compact
   encoding-correctness checks?
4. What is the minimum certificate shape that a rollup settlement contract can
   use safely?
5. How should post-certification retrieval failures degrade visible
   certificate status?
6. Should public paid sampling be rate-limited by lane policy, protocol policy,
   or both?
7. Does the 8 MiB MDU remain appropriate for small rollup batches, or should DA
   lanes aggregate many small batches into larger PolyFS segments?
8. What retention and garbage-collection policy should DA-retained historical
   generations use relative to provisional-generation cleanup?
9. Which external integration should be first: OP Stack alt-DA, a generic SDK,
   or a source-DA archive bridge?
10. What exact language is allowed in marketing before the Phase 3 proof work
    is complete?

-----

## 20. Recommendation

Adopt PolyFS DA Lanes as a formal research and protocol direction.

The recommended sequencing is:

1. Keep historical DA archive/retrieval as the near-term commercial wedge.
2. Specify DA lanes as an additive layer over existing deals.
3. Build append-only lane semantics before claiming full DAS.
4. Add availability certificates with explicit assumptions.
5. Use the DAS research track to earn stronger "DA layer" claims later.

This direction avoids the weak framing of cloning existing DA systems. It
focuses PolyStore on the point where it can be genuinely differentiated:
publication-time availability, long-term retrieval, repair, and economic
accountability as one continuous system.

-----

## 21. References

Local:

* `whitepaper.md`
* `docs/notes/HISTORICAL_DA_ARCHIVAL_RETRIEVAL_MARKET.md`
* `rfcs/rfc-blob-alignment-and-striping.md`
* `rfcs/rfc-polyfs-generation-cas-and-staged-writes.md`
* `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`
* `rfcs/rfc-challenge-derivation-and-quotas.md`
* `rfcs/rfc-mode2-onchain-state.md`
* `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`
* `rfcs/rfc-pricing-and-escrow-accounting.md`
* `rfcs/rfc-polyfs-root-contract.md`
* `polystorechain/proto/polystorechain/polystorechain/v1/types.proto`
* `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto`

External:

* Celestia data availability docs:
  `https://docs.celestia.org/learn/celestia-101/data-availability/`
* Ethereum EIP-7594 PeerDAS:
  `https://eips.ethereum.org/EIPS/eip-7594`
* Teku PeerDAS docs:
  `https://docs.teku.consensys.io/concepts/peer-das`
* EigenDA overview:
  `https://docs.eigencloud.xyz/eigenda/core-concepts/overview`
* Avail DA docs:
  `https://docs.availproject.org/docs/da/concepts/how-avail-da-works`
