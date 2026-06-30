# RFC: PolyFS DA Lanes and Availability Certificates

**Status:** Proposed / research-track candidate
**Scope:** Protocol, PolyFS, chain state, gateway APIs, provider-daemon
attestations, retrieval economics
**Depends on:**
`whitepaper.md`,
`rfcs/rfc-blob-alignment-and-striping.md`,
`rfcs/rfc-polyfs-generation-cas-and-staged-writes.md`,
`rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`,
`rfcs/rfc-challenge-derivation-and-quotas.md`,
`rfcs/rfc-mode2-onchain-state.md`,
`rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`,
`rfcs/rfc-pricing-and-escrow-accounting.md`,
`rfcs/rfc-polyfs-root-contract.md`,
`rfcs/rfc-chain-funded-da-deals.md`

-----

## 1. Summary

This RFC proposes **PolyFS DA Lanes** as an **attestation-first data
availability service with native durable retrieval**.

The intended product is not "current PolyStore storage deals are already a
complete DA layer." The intended product is:

> Applications publish erasure-coded batches to a PolyStore DA Lane, receive a
> compact Availability Certificate after protocol-selected provider-daemons
> attest to the assigned data, and keep the same data retrievable through
> PolyStore's paid, provable, repairable storage layer.

The first primary-DA path should be attestation-first, not sampling-first. It is
closer to an EigenDA-shaped operator/quorum model than to a Celestia-shaped DAS
chain. PolyStore's differentiation is that a certificate can bind publication
availability to durable retrieval, repair, payment, and retained PolyFS
generations.

The canonical deployment model is a **Chain-Funded DA Deal**:

> A chain funds one DA Deal, publishes batches through one or more DA lanes,
> receives availability certificates, and keeps the data retrievable for as long
> as the Deal remains funded.

This keeps the public product concrete. Chains buy a standing DA service; DA
lanes append and certify batches; backing deals retain and serve the data.

This RFC defines three certificate tiers:

* `DA_CERT_FAST`: quorum attestation that assigned chunks were received,
  verified, stored, and committed by provider-daemons.
* `DA_CERT_RETRIEVABLE`: `DA_CERT_FAST` plus publication-time sample retrievals
  served through PolyStore retrieval sessions before downstream acceptance.
* `DA_CERT_RETAINED`: `DA_CERT_RETRIEVABLE` plus continuing retention, audit,
  repair, and provider-rotation obligations through a declared window.

`DA_CERT_RETRIEVABLE` is the flagship PolyStore target. It is the tier that
makes the availability claim operationally useful: the data was not only
attested, it was sampled as retrievable through the storage network that will
serve it later.

-----

## 2. Design Posture

DA systems answer a different question than archive systems.

* Historical archive/retrieval asks: **can old data be found, verified, and
  served later?**
* Publication-time DA asks: **was the data behind a newly published commitment
  made available widely enough before downstream systems accepted that
  commitment?**

The market has two relevant protocol shapes.

### 2.1 Sampling-first DA

Sampling-first DA, represented by Celestia, Avail, and Ethereum PeerDAS-style
designs, makes random sampling a core security mechanism. A light client or
validator can sample encoded shares/cells and obtain confidence that the whole
block or blob was published without downloading the full data.

This model is strongest when the protocol itself owns consensus headers,
sampling rules, reconstruction assumptions, and light-client semantics.

PolyStore SHOULD NOT claim sampling-first security until it has a formal
sampling network, probability model, encoding-correctness path, and light-client
verification design.

### 2.2 Attestation-first DA

Attestation-first DA, represented by EigenDA-style designs, uses a selected
operator set. A disperser encodes data, sends assigned chunks and proofs to
operators, operators verify and store the chunks, and a quorum signs an
availability statement. A rollup or bridge verifies the resulting certificate
before accepting the batch.

This model is the more natural primary-DA route for PolyStore because PolyStore
already has:

* provider-daemons with accountable storage obligations;
* protocol-selected provider placement;
* KZG-aligned blobs and 8 MiB MDUs;
* RS(8,12)-style striping;
* pinned PolyFS generations and compare-and-swap roots;
* retrieval sessions that bind deal, root, range, payer, nonce, and expiry;
* paid retrieval flows; and
* repair and provider rotation.

### 2.3 PolyStore's DA shape

PolyStore DA should be **attestation-first with retrieval-native hardening**.
The first competitive claim should be:

> PolyStore DA certificates bind publication-time availability to an accountable
> retrieval and retention substrate.

That claim is narrower, easier to defend, and more differentiated. It says the
batch was not merely signed by a quorum. It also says the batch is mapped into a
PolyFS generation, backed by storage deals, subject to retrieval sessions, and
eligible for repair or retained access after certification.

### 2.4 Chain-Funded DA Deals

The DA-lanes protocol should be packaged as a chain-funded service.

A Chain-Funded DA Deal gives a chain:

* a treasury-funded policy object;
* allowed sequencer, batcher, user-gateway, or disperser publishers;
* one or more DA lanes;
* one or more backing storage deals;
* an erasure profile and provider assignment policy;
* a target certificate tier;
* retention and retrieval payment policy;
* repair and provider scale-up policy; and
* public usage and runway accounting.

This is the route from protocol primitive to marketable product. "Launch a
chain with a DA Deal" is not just marketing language. It is the policy layer
that lets a chain autonomously fund publication, certification, retained
retrieval, repair, and provider elasticity.

-----

## 3. Goals

1. Define PolyStore DA as attestation-first primary DA with native durable
   retrieval.
2. Make `DA_CERT_FAST`, `DA_CERT_RETRIEVABLE`, and `DA_CERT_RETAINED` explicit
   protocol tiers with different verification and service claims.
3. Specify the chain objects and message shapes needed for DA lanes,
   provider-daemon attestations, sample retrievals, failure evidence, and
   Availability Certificates.
4. Keep storage deals as the durable storage and economic substrate, not the DA
   publication object itself.
5. Adopt Chain-Funded DA Deals as the deployment and funding primitive for
   public chains using PolyStore DA.
6. Define a compact certificate verification surface for rollups, bridge
   contracts, and external applications.
7. Reuse existing PolyStore primitives wherever possible.
8. Make provider accountability, retrieval payment, post-certification repair,
   and retained historical generations first-class properties of the design.
9. Keep the future DAS/light-client path available without depending on that
   stronger claim for the first product.

-----

## 4. Non-Goals

This RFC does not:

* claim current PolyStore deals are already a complete consensus DA layer;
* claim storage proofs alone are sufficient for primary DA;
* claim Celestia-equivalent or PeerDAS-equivalent sampling security;
* specify a final probability bound for every sampling profile;
* define final slashing economics for all false attestation cases;
* require a new consensus protocol for PolyStore;
* require every provider-daemon to store every byte;
* define an L1 bridge contract in detail; or
* implement the proposed messages or state machines.

-----

## 5. Terminology

| Term | Meaning |
|---|---|
| **Deal** | Existing PolyStore storage/economic object. Deals remain the substrate for provider placement, escrow, retrieval policy, roots, and repair. |
| **Chain-Funded DA Deal** | Standing service contract that links an external chain or namespace to DA lanes, backing deals, funding accounts, provider policies, retrieval policy, repair, and scale-up. |
| **PolyFS generation** | Immutable committed content state identified by a PolyFS root and generation. |
| **DA Lane** | Append-only publication stream backed by one or more deals. |
| **Batch** | One ordered publication unit in a DA Lane. |
| **DABatchHeader** | DA-facing commitment and metadata that external systems verify or reference. |
| **Publisher** | Account authorized to append a batch to a lane. |
| **Availability Certificate** | Compact record that a batch satisfied a named certificate policy. |
| **`DA_CERT_FAST`** | Certificate tier based on provider-daemon quorum attestations. |
| **`DA_CERT_RETRIEVABLE`** | Certificate tier based on quorum attestations plus publication-time retrieval samples. |
| **`DA_CERT_RETAINED`** | Certificate tier based on retrievable certification plus ongoing retention, audit, and repair obligations. |
| **Provider assignment** | Protocol-selected mapping from encoded cells/chunks to provider-daemons and backing deal slots. |
| **Provider availability attestation** | Signed provider-daemon statement that assigned artifacts were received, verified, stored, and committed under a specific lane/batch/root/policy. |
| **Sample coordinate** | Deterministic coordinate used to request and verify one availability sample. |
| **Challenge window** | Bounded period during which certification samples or failure evidence can be submitted. |
| **Retention window** | Period during which the lane claims certified data remains retrievable through the backing storage substrate. |
| **user-gateway** | Optional client-side or service-side helper that stages, encodes, disperses, aggregates attestations, and queries data. |
| **provider-daemon** | Storage-provider runtime responsible for receiving assigned artifacts, verifying them, storing slot data, serving samples, and producing proofs. |

-----

## 6. Design Principle

Deals and DA lanes MUST NOT be collapsed into one object.

Deals answer:

* who stores this content;
* what root and generation are current or retained;
* what retrieval policy applies;
* how providers are paid or penalized;
* how repairs are performed; and
* how bytes are retrieved.

DA lanes answer:

* who may publish;
* what order batches were appended in;
* what DA-facing batch roots exist;
* which provider set and quorum policy certified each batch;
* which certificate tier was issued;
* which challenge and retention windows apply; and
* how external systems reference a published batch.

The lane is the publication abstraction. The deal is the storage and economic
substrate. The Availability Certificate is the bridge between them.

Chain-Funded DA Deals add the deployment abstraction above both. They answer:

* which external chain or namespace is being served;
* which treasury funds publication, retrieval, retention, and repair;
* which publishers can append;
* which certificate tier is required by default;
* which public retrieval and sampling policy applies; and
* when provider-daemon capacity should scale up.

See `rfcs/rfc-chain-funded-da-deals.md` for the policy object and funding
surface.

-----

## 7. Certificate Tiers

### 7.1 `DA_CERT_FAST`

`DA_CERT_FAST` is the attestation baseline.

A batch MAY receive `DA_CERT_FAST` only after:

* the batch has a canonical `DABatchHeader`;
* encoded artifacts have been assigned to provider-daemons by a protocol policy;
* each attesting provider-daemon has verified its assigned artifact against the
  batch commitment and assignment;
* each attesting provider-daemon has persisted the artifact under the declared
  backing deal/generation/slot;
* enough attestations satisfy the lane's `DAQuorumPolicy`; and
* the backing deal roots required by the batch are committed or otherwise
  blocked from mutation before certification.

This tier is useful for low-latency acceptance paths. It does not by itself
prove that any third party has retrieved a sample through PolyStore.

### 7.2 `DA_CERT_RETRIEVABLE`

`DA_CERT_RETRIEVABLE` is the primary PolyStore DA target.

A batch MAY receive `DA_CERT_RETRIEVABLE` only after all `DA_CERT_FAST`
conditions plus:

* delayed-randomness sample coordinates are derived after artifact commitments
  are fixed;
* sample sessions are opened against the relevant historical PolyFS generation
  and provider assignment;
* assigned provider-daemons serve the challenged cells/ranges before expiry;
* sample proofs bind the served bytes to the batch root, PolyFS generation,
  assignment, provider, range, nonce, and retrieval-session id; and
* the lane's certificate policy accepts the aggregate sample result.

This tier says the data was attested and already sampled as retrievable through
the same retrieval system that will serve it later.

### 7.3 `DA_CERT_RETAINED`

`DA_CERT_RETAINED` extends `DA_CERT_RETRIEVABLE` over a declared retention
window.

A batch MAY receive or maintain `DA_CERT_RETAINED` only while:

* all segments remain inside active backing deal terms or renewed/migrated
  equivalents;
* retained historical generations remain addressable;
* scheduled audits and public/protocol-funded retrieval samples satisfy lane
  policy;
* provider degradation triggers repair or replacement; and
* the lane has enough escrow or fee policy support for continued retrieval and
  repair obligations.

Retention status is service health, not historical truth rewriting. A later
retrieval failure MAY degrade or retire retained status, but it MUST NOT rewrite
the fact that a lower-tier certificate was issued under a specific policy at a
specific height.

-----

## 8. Publication Lifecycle

1. **Lane creation.** The owner creates a `DALane` with writer, retrieval, fee,
   quorum, certificate, and retention policies.
2. **Batch submission.** A publisher submits a pending `DABatchHeader` and
   storage-segment plan.
3. **Canonical encoding.** The user-gateway or publisher converts the batch to
   the lane's encoding profile and emits commitments/proofs.
4. **Provider assignment.** The protocol selects provider-daemons and assigns
   chunks/cells/slots according to `DAQuorumPolicy` and backing deal state.
5. **Dispersal.** The user-gateway sends assigned artifacts to
   provider-daemons.
6. **Provider verification.** Provider-daemons verify headers, roots,
   commitments, assigned coordinates, and local persistence requirements.
7. **Provider attestation.** Provider-daemons submit signed
   `ProviderAvailabilityAttestation` records.
8. **Fast certification.** If the quorum policy passes, the lane may issue
   `DA_CERT_FAST`.
9. **Retrieval sampling.** If the requested tier is `DA_CERT_RETRIEVABLE` or
   `DA_CERT_RETAINED`, delayed-randomness samples are opened as retrieval
   sessions and proof results are submitted.
10. **Retrievable certification.** If the sampling policy passes, the lane may
    issue `DA_CERT_RETRIEVABLE`.
11. **Retained service.** If the requested tier is `DA_CERT_RETAINED`, audits,
    repair, and renewal/migration obligations continue through the retention
    window.
12. **External acceptance.** A rollup, bridge, or app verifies the compact
    certificate and accepts or rejects the batch root according to its own
    policy.

-----

## 9. Proposed Chain Objects

Chain-Funded DA Deal objects live in `rfcs/rfc-chain-funded-da-deals.md`.
Those objects reference the DA lane, batch, provider-assignment, sample, and
certificate objects below.

### 9.1 `DALane`

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
  uint64 quorum_policy_id = 11;
  uint64 certificate_policy_id = 12;
  repeated CertificateTier allowed_tiers = 13;
  uint64 created_height = 14;
}
```

`current_lane_root` is the append-only root over batch descriptors. It is not
necessarily the same value as a deal's current PolyFS root.

### 9.2 `DAQuorumPolicy`

```protobuf
message DAQuorumPolicy {
  uint64 quorum_policy_id = 1;
  string assignment_policy = 2;
  uint32 min_attesting_slots = 3;
  uint32 min_reconstructable_slots = 4;
  string stake_threshold = 5;
  string capacity_threshold = 6;
  string bandwidth_threshold = 7;
  uint64 challenge_window_blocks = 8;
  uint64 retention_window_blocks = 9;
}
```

`min_attesting_slots` is the attestation threshold. `min_reconstructable_slots`
is the reconstruction threshold, for example `K` in RS(K,N). Stake, capacity,
and bandwidth thresholds are policy inputs and MUST be defined before they are
used in a certificate claim.

### 9.3 `DABatchHeader`

```protobuf
message DABatchHeader {
  uint64 lane_id = 1;
  uint64 batch_id = 2;
  bytes batch_data_root = 3;
  bytes previous_lane_root = 4;
  bytes new_lane_root = 5;
  string namespace_or_app_id = 6;
  uint64 size_bytes = 7;
  string encoding_profile = 8;
  uint64 total_mdus = 9;
  uint64 witness_mdus = 10;
  uint64 publish_height = 11;
  bytes domain_separator = 12;
}
```

This is the external DA-facing object. Rollups and bridge contracts should not
need to understand arbitrary PolyFS file metadata in order to verify it.

### 9.4 `DABatch`

```protobuf
message DABatch {
  DABatchHeader header = 1;
  string publisher = 2;
  bytes polyfs_root_or_segment_root = 3;
  repeated DABatchStorageSegment storage_segments = 4;
  repeated ProviderAssignment provider_assignments = 5;
  BatchStatus status = 6;
  CertificateTier requested_tier = 7;
  uint64 certificate_id = 8;
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

`storage_segments` is the authoritative lane-to-deal mapping for retrieval and
sampling. Each segment binds the committed PolyFS generation and chain height
that made the segment valid, so older certified batches remain addressable
after a backing deal advances to a later root.

`deal_end_block` snapshots the backing deal term used for retention validation.
Certificates MUST NOT advertise retention past the minimum backing deal end
block for their segments unless an on-chain renewal or migration updates the
segment's backing term first.

### 9.5 `ProviderAssignment`

```protobuf
message ProviderAssignment {
  uint64 lane_id = 1;
  uint64 batch_id = 2;
  string provider = 3;
  uint32 slot = 4;
  uint64 deal_id = 5;
  uint64 deal_generation = 6;
  bytes polyfs_root_or_segment_root = 7;
  uint64 first_mdu = 8;
  uint64 mdu_count = 9;
  uint64 logical_offset = 10;
  uint64 length = 11;
  bytes assignment_digest = 12;
}
```

Assignments MUST be derived by protocol policy or verified against protocol
policy. Publisher-selected friendly placement is not sufficient for primary DA.

### 9.6 `ProviderAvailabilityAttestation`

```protobuf
message ProviderAvailabilityAttestation {
  uint64 lane_id = 1;
  uint64 batch_id = 2;
  string provider = 3;
  uint32 slot = 4;
  bytes batch_data_root = 5;
  bytes assignment_digest = 6;
  bytes artifact_digest = 7;
  bytes polyfs_root_or_segment_root = 8;
  uint64 deal_id = 9;
  uint64 deal_generation = 10;
  uint64 challenge_window_end = 11;
  uint64 retention_until = 12;
  uint64 signed_height = 13;
  bytes signature = 14;
}
```

The signature MUST bind lane id, batch id, batch root, encoding profile,
provider identity, assigned cell/chunk ranges, backing deal id, deal generation,
PolyFS root or segment root, challenge window, retention window, chain height,
and a domain separator.

The attestation means:

* the provider received its assigned artifact;
* the provider verified the artifact against the assignment and batch
  commitment according to the lane policy;
* the provider persisted the artifact under the referenced deal/generation; and
* the provider accepts challenge and retrieval obligations for the declared
  windows.

### 9.7 `DASampleChallenge`

```protobuf
message DASampleChallenge {
  uint64 challenge_id = 1;
  uint64 lane_id = 2;
  uint64 batch_id = 3;
  uint64 sample_policy_id = 4;
  uint64 seed_height = 5;
  bytes seed = 6;
  string provider = 7;
  uint32 slot = 8;
  uint64 mdu_index = 9;
  uint64 cell_or_leaf_index = 10;
  uint64 byte_offset = 11;
  uint64 byte_length = 12;
  uint64 expiry_height = 13;
}
```

The seed MUST be unknown until after artifacts and provider attestations are
fixed. Challenges derived before commitment are vulnerable to grinding.

### 9.8 `DASampleResult`

```protobuf
message DASampleResult {
  uint64 challenge_id = 1;
  uint64 retrieval_session_id = 2;
  string provider = 3;
  bytes served_digest = 4;
  bytes proof_digest = 5;
  uint64 served_height = 6;
  SampleResultStatus status = 7;
}
```

The sample proof MUST bind the retrieval session, provider, pinned root or
segment root, historical deal generation, range, nonce, expiry, and served
bytes/cell proof.

### 9.9 `DAFailureEvidence`

```protobuf
message DAFailureEvidence {
  uint64 evidence_id = 1;
  uint64 lane_id = 2;
  uint64 batch_id = 3;
  string provider = 4;
  FailureKind failure_kind = 5;
  bytes attestation_digest = 6;
  bytes challenge_digest = 7;
  bytes proof_or_transcript = 8;
  string submitter = 9;
  uint64 submitted_height = 10;
}
```

Failure evidence is used to fail pending certification, degrade retained
service, slash or penalize providers, and trigger repair. The exact penalty
schedule is policy-specific.

### 9.10 `AvailabilityCertificate`

```protobuf
message AvailabilityCertificate {
  uint64 certificate_id = 1;
  uint64 lane_id = 2;
  uint64 batch_id = 3;
  CertificateTier tier = 4;
  bytes batch_data_root = 5;
  bytes batch_header_digest = 6;
  bytes provider_set_hash = 7;
  uint64 quorum_policy_id = 8;
  bytes quorum_result_root = 9;
  bytes aggregate_signature_or_proof = 10;
  uint64 sample_policy_id = 11;
  uint64 sample_seed_height = 12;
  bytes sample_result_root = 13;
  uint64 certified_height = 14;
  uint64 challenge_window_end = 15;
  uint64 retention_until = 16;
  CertificateStatus status = 17;
}
```

The certificate is historical. Later retrieval failures may degrade service
status or retained status. They MUST NOT rewrite the fact that a certificate was
issued under a specific tier, policy, provider set, and height.

-----

## 10. Proposed Messages

### 10.1 `MsgCreateDALane`

Creates an append-only lane backed by one or more existing deals. A lane MAY be
created directly by its owner or through a Chain-Funded DA Deal policy.

Required checks:

* sender is authorized to create the lane;
* backing deals exist and are compatible with the lane's erasure profile;
* retrieval policy is compatible with public, sponsored, or requester-funded
  sampling behavior;
* fee policy can fund publication, certification, retrieval, audit, and repair
  costs for the requested tiers;
* quorum policy is a recognized protocol policy; and
* certificate policy is a recognized protocol policy.

If created through a Chain-Funded DA Deal, the lane's writer, fee, retrieval,
retention, and certificate policies MUST be compatible with that DA Deal policy.

### 10.2 `MsgAppendDABatch`

Appends a pending batch to a lane.

Required checks:

* lane exists;
* publisher satisfies `writer_policy`;
* `previous_lane_root == lane.current_lane_root`;
* batch size and fee satisfy lane policy;
* requested tier is allowed by the lane;
* every `storage_segments[*].deal_id` is one of the lane's backing deals;
* `storage_segments` covers exactly `size_bytes` with no gaps, overlaps, or
  zero-length segments;
* every segment's `(deal_id, deal_generation, polyfs_root_or_segment_root)` maps
  to a committed or pending-to-be-committed PolyFS root transition;
* every segment's `deal_end_block` matches backing deal state and is high enough
  to satisfy the lane's requested retention target, or the batch remains
  ineligible for the requested tier; and
* the batch enters `PENDING_ASSIGNMENT`, not `CERTIFIED`.

### 10.3 `MsgAssignDAProviders`

Records or verifies the provider assignment for a pending batch.

Required checks:

* assignment policy matches `DAQuorumPolicy`;
* assigned providers are active and eligible;
* assigned slots/ranges are covered by backing deal state;
* provider set hash is deterministic; and
* assignments cannot be changed after the attestation window starts except by
  explicit failure/replacement rules.

### 10.4 `MsgSubmitProviderAvailabilityAttestation`

Submits a provider-daemon attestation for one assignment.

Required checks:

* provider identity matches the assignment;
* signature verifies under the provider key;
* signed digest binds all fields required by this RFC;
* artifact/root/generation state is compatible with the backing deal;
* attestation arrives before the attestation deadline; and
* duplicate or equivocated attestations are rejected or recorded as failure
  evidence.

### 10.5 `MsgOpenDASampleSession`

Opens a sample session for one challenge coordinate.

This SHOULD extend the mandatory retrieval-session architecture rather than
creating a parallel payment/proof path.

The semantic fields MUST include:

* lane id;
* batch id;
* sample coordinate;
* provider slot;
* pinned PolyFS root or segment root;
* historical deal generation;
* payer or funding source;
* nonce; and
* expiry.

### 10.6 `MsgSubmitDASampleResult`

Submits successful or failed sample evidence for one session or a batch of
sessions.

The result MUST bind:

* sample session;
* sample coordinate;
* provider slot;
* relevant commitment;
* PolyFS inclusion path;
* KZG opening or equivalent cell proof; and
* served sample bytes or cell data when successful.

### 10.7 `MsgSubmitDAFailureEvidence`

Submits failure evidence for attestation equivocation, invalid encoding,
missing artifact, failed sample, stale backing root, or retained-service failure.

Evidence MAY:

* block certification for a pending batch;
* slash or penalize a provider;
* reduce provider service history;
* mark retained service as degraded;
* trigger repair or provider replacement; or
* reward the evidence submitter.

### 10.8 `MsgFinalizeAvailabilityCertificate`

Finalizes or fails the pending batch after the lane's certificate policy is
evaluated.

Possible batch outcomes:

* `CERTIFIED_FAST`
* `CERTIFIED_RETRIEVABLE`
* `CERTIFIED_RETAINED`
* `FAILED`
* `EXPIRED`

Required checks:

* every segment's `(deal_id, deal_generation, polyfs_root_or_segment_root)` is
  committed in the backing deal state, with `deal_root_height` populated from
  that committed transition;
* quorum attestations satisfy `DAQuorumPolicy`;
* for `DA_CERT_RETRIEVABLE` and `DA_CERT_RETAINED`, sample results satisfy the
  certificate policy;
* `retention_until` is no greater than the minimum `deal_end_block` across the
  batch's `storage_segments`; and
* if the lane retention target extends beyond any backing deal term, the batch
  remains uncertified for retained status until the affected segments are
  renewed, extended, or migrated.

-----

## 11. State Machines

### 11.1 Batch status

```text
PENDING_ASSIGNMENT
  -> PENDING_DISPERSAL
  -> PENDING_ATTESTATION
      -> CERTIFIED_FAST
          -> PENDING_RETRIEVAL_SAMPLES
              -> CERTIFIED_RETRIEVABLE
                  -> RETAINED_ACTIVE
                      -> RETAINED_DEGRADED
                      -> RETAINED_RETIRED
      -> FAILED
      -> EXPIRED
```

Rules:

* A batch MUST NOT become `CERTIFIED_FAST` before quorum attestations pass.
* A batch MUST NOT become `CERTIFIED_RETRIEVABLE` before retrieval samples pass.
* `CERTIFIED_FAST`, `CERTIFIED_RETRIEVABLE`, and `RETAINED_ACTIVE` are
  historical certification achievements. Later service failures may degrade
  retained service but must not rewrite prior certification facts.
* A stale `previous_lane_root` MUST reject the append.
* Expired pending batches MUST remain inspectable.

### 11.2 Certificate status

```text
ISSUED
  -> SERVICE_DEGRADED
  -> RETIRED
```

`SERVICE_DEGRADED` is useful when later retrieval evidence shows the certified
data is not meeting retained-service expectations. It does not mean the original
certificate was invalid.

-----

## 12. External Verification Surface

External rollups, bridge contracts, and applications should verify a compact
object. They should not need to replay the full PolyStore retrieval protocol.

The minimum verifier surface is:

* `certificate_id`
* `lane_id`
* `batch_id`
* `tier`
* `batch_data_root`
* `batch_header_digest`
* `provider_set_hash`
* `quorum_policy_id`
* `aggregate_signature_or_proof`
* `certified_height`
* `challenge_window_end`
* `retention_until`
* bridge-facing domain separator

A verifier MAY require `DA_CERT_FAST` for low-latency workflows,
`DA_CERT_RETRIEVABLE` for dispute/proof/audit workflows, or
`DA_CERT_RETAINED` when it needs continuing service through a longer window.

-----

## 13. Retrieval and Payment Semantics

DA sampling MUST reuse the mandatory retrieval-session architecture wherever
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

### 13.1 Historical-generation sessions

Current retrieval sessions are rooted in the backing deal's current committed
PolyFS root. DA lanes need one additional mode because certified batch history is
append-only while backing deals may continue to advance.

For DA lane retrieval and sampling, the session opener MUST resolve
`(lane_id, batch_id, range)` to the batch's `storage_segments`, then open a
session against the recorded `(deal_id, deal_generation,
polyfs_root_or_segment_root, logical_offset, length)` tuple. A historical
segment is valid if:

* the referenced batch is certified or still within an active certification
  window;
* the segment's `deal_root_height` proves that the root was committed for the
  backing deal;
* the requested byte range is covered by the segment list; and
* the segment is still inside both the lane's retention window and the backing
  deal term recorded by `deal_end_block`.

Providers and user-gateways MUST keep DA-retained committed generations
addressable by `(deal_id, deal_generation/root)` until the relevant retention
window expires or the segment is explicitly migrated.

If an implementation does not support historical-generation sessions, it MUST
use immutable backing deals or otherwise ensure that every certified segment
remains the current retrievable root for its full retention period.

-----

## 14. Sampling and Challenge Model

The first research model should evaluate this profile:

* data is encoded into `N` provider slots with `K`-of-`N` reconstructability;
* default candidate profile is RS(8,12), matching the current Mode 2 design;
* each user-data MDU has sample coordinates derived from `(mdu_index,
  leaf_index, slot, row)` or an equivalent cell grammar;
* challenge seed is unknown until after staged upload, assignment, and provider
  attestations are fixed;
* protocol-funded or third-party samplers open retrieval sessions for `s`
  coordinates;
* provider-daemons return proof material before expiry; and
* the certificate policy determines whether enough evidence exists to certify
  or retain the batch.

Open policy questions:

* Are sample coordinates uniform across all slots or weighted by capacity,
  stake, bond, or provider service history?
* Does `DA_CERT_FAST` require readiness from all slots, at least `K` slots per
  row, or a separate quorum threshold?
* Does failure of a parity slot block retrievable certification or only create
  degraded retained service?
* Can any third party submit successful samples, or only selected samplers?
* What confidence bound is advertised for a given batch size, sample count, and
  withholding strategy?

The first production claim should be an explicitly named policy, such as:

> Certified as `DA_CERT_RETRIEVABLE` under PolyStore DA Lane Policy v0 with
> quorum policy Q, sample count S, delayed randomness source R, provider set P,
> and confidence model M.

-----

## 15. Encoding Correctness

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
     deterministic reconstruction rule before attestation.
   * Moves more work to providers.
   * Gives readiness attestations more meaning.

3. **KZG homomorphism checks**
   * Use the homomorphic properties already relevant to RS parity commitments.
   * Potentially compact.
   * Needs formalization and test vectors for the exact PolyStore profile.

4. **Validity proof**
   * Publisher or user-gateway proves the encoded data is correctly derived.
   * Strongest certification surface.
   * Heaviest implementation and proving requirement.

This RFC recommends starting with a formal fraud-proof plus provider-verification
design, then evaluating whether KZG homomorphism gives a compact first-class
check for RS(8,12).

-----

## 16. Failure Semantics

### 16.1 Certification failure

A pending batch MUST fail or expire if:

* the provider assignment cannot be derived or verified;
* required providers do not attest before the deadline;
* providers equivocate over roots, assignments, or artifact digests;
* backing deal roots are not committed before finalization;
* delayed-randomness samples fail for the requested tier;
* invalid encoding evidence is accepted; or
* the backing deal term cannot support the requested retention window.

### 16.2 Post-certification failure

Post-certification retrieval failures SHOULD:

* update provider service history;
* trigger repair or provider replacement when possible;
* degrade or retire retained service status; and
* generate slashable or penalty-bearing evidence if the provider signed a false
  attestation or violated a retained-service obligation.

Post-certification retrieval failures MUST NOT rewrite the historical fact that
the certificate was issued under a specific policy at a specific height.

### 16.3 Slashing and penalties

This RFC does not finalize slashing economics, but it requires that each
certificate policy define:

* what evidence is slashable;
* who may submit evidence;
* when evidence expires;
* whether penalties apply to providers, publishers, user-gateways, or lane
  escrows;
* whether successful evidence submitters are rewarded; and
* how repair is funded after a penalty event.

-----

## 17. Threat Model

### 17.1 Malicious publisher or user-gateway

Risk: a publisher or user-gateway submits malformed, incomplete, or equivocated
artifacts while trying to obtain a certificate.

Required controls:

* canonical `DABatchHeader`;
* provider-daemon verification before attestation;
* artifact digests in attestations;
* delayed randomness after commitment; and
* invalid-encoding evidence.

### 17.2 Colluding providers

Risk: assigned providers sign and answer narrow samples while withholding enough
data to break reconstruction or future retrieval.

Required controls:

* protocol-selected provider assignment;
* provider-set hash in certificates;
* quorum policies with stake/capacity/bandwidth assumptions stated explicitly;
* publication-time samples for `DA_CERT_RETRIEVABLE`; and
* ongoing retained-service audits for `DA_CERT_RETAINED`.

### 17.3 Sampling grinding

Risk: sample coordinates are predictable and only those coordinates are made
available.

Required controls:

* delayed randomness;
* artifact commitments fixed before seed;
* no artifact rewriting after seed; and
* sample proofs bound to batch root, assignment, provider, and generation.

### 17.4 Stale backing roots

Risk: a certificate references a PolyFS root or generation that was never
committed, is no longer addressable, or falls outside the backing deal term.

Required controls:

* finalization guard requiring committed roots;
* `deal_generation`, `deal_root_height`, and `deal_end_block` in segments;
* historical-generation retrieval sessions; and
* renewal or migration before retained claims exceed backing terms.

### 17.5 Retrieval liquidity failure

Risk: samples are theoretically possible but no one can fund or route them in
practice.

Required controls:

* protocol-funded or lane-funded sampling budgets;
* public paid retrieval paths;
* explicit escrow accounting; and
* rate limits that prevent griefing without blocking honest verification.

-----

## 18. Gateway and Provider Requirements

### 18.1 user-gateway

The user-gateway should support:

* batch packing;
* deterministic erasure encoding;
* append-only lane submission;
* protocol assignment lookup;
* staged artifact dispersal;
* attestation aggregation;
* certificate polling;
* sample-session opening or coordination;
* range retrieval by `(lane_id, batch_id, range)`, including
  segment-generation resolution;
* namespace or application id lookup; and
* certificate/proof bundle export for rollups and bridges.

The user-gateway MUST be treated as untrusted by the protocol. It may aggregate
and relay evidence, but certificates depend on provider-daemon attestations,
chain checks, and sample results.

### 18.2 provider-daemon

The provider-daemon should support:

* validating staged artifact headers;
* rejecting stale expected roots before accepting large uploads;
* binding stored artifacts to lane id, batch id, slot id, assignment digest,
  root, and generation;
* verifying assigned artifacts before attestation;
* keeping DA-retained committed generations addressable until their retention
  windows expire or their backing deal terms end;
* surfacing renewal or migration requirements before a certified segment's
  backing deal term falls below the advertised retention window;
* availability attestation;
* sample serving;
* sample proof construction;
* repair participation; and
* service-health reporting.

-----

## 19. Compatibility and Migration

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
`manifest_root` are reused during transition, they must be documented as aliases
only.

-----

## 20. Implementation Roadmap

### Phase 0: RFC and tracker hardening

Deliverables:

* formal certificate tier semantics;
* Chain-Funded DA Deal policy and funding RFC;
* public-chain sizing and positioning memo;
* tracker issue with milestones and gates
  (`https://github.com/Polynomialstore/polystore/issues/231`);
* implementation boundaries for chain, user-gateway, provider-daemon, and
  external verifier work; and
* non-claim language for sampling-first DA.

Exit criteria:

* this RFC clearly defines `DA_CERT_FAST`, `DA_CERT_RETRIEVABLE`, and
  `DA_CERT_RETAINED`;
* Chain-Funded DA Deals are defined as the canonical deployment model;
* tracker issue exists and is linked from the RFC PR; and
* no public messaging depends on full DAS claims.

### Phase 1: `DA_CERT_FAST` MVP

Deliverables:

* `DADealPolicy` and funding-account linkage for one Chain-Funded DA Deal;
* `DABatchHeader`;
* `DAQuorumPolicy`;
* fixed provider assignment policy;
* `ProviderAssignment`;
* `ProviderAvailabilityAttestation`;
* `AvailabilityCertificate` for `DA_CERT_FAST`;
* query API; and
* local devnet demo with one lane and fixed provider set.

Exit criteria:

* a Chain-Funded DA Deal can create or link a lane and pay for publication;
* a batch moves from append to attested certificate;
* invalid or missing provider attestations fail certification;
* certificate verification surface is compact enough for a mock rollup verifier;
* existing storage deal behavior is unchanged.

### Phase 2: `DA_CERT_RETRIEVABLE` MVP

Deliverables:

* delayed-randomness sample coordinate derivation;
* DA sample retrieval sessions;
* `DASampleChallenge`;
* `DASampleResult`;
* `sample_result_root`;
* failed sample evidence; and
* mock rollup verifier that can require retrievable tier.

Exit criteria:

* retrievable certification requires successful sample serving;
* failed samples block retrievable certification;
* sample proof transcripts bind provider, root, range, generation, session,
  nonce, and expiry;
* a demo can publish, certify retrievable, and reconstruct the batch later.

### Phase 3: `DA_CERT_RETAINED`

Deliverables:

* retained-generation addressability;
* scheduled audits;
* repair/rotation hooks;
* retained status transitions;
* renewal or migration requirements; and
* service-health dashboard/query surface.

Exit criteria:

* retained status degrades when service evidence fails;
* repair restores retained service without rewriting the historical certificate;
* backing deal terms cap advertised retention.

### Phase 4: External integration

Deliverables:

* generic verifier SDK;
* bridge-contract verifier sketch or prototype;
* OP Stack alt-DA prototype or equivalent integration;
* certificate polling;
* fallback retrieval from PolyStore; and
* proof bundle export.

Exit criteria:

* one live design partner demo can publish, certify, verify, retrieve, and
  reconstruct a batch.

### Phase 5: DAS research track

Deliverables:

* confidence-bound documentation;
* invalid-encoding evidence;
* sample aggregation;
* collusion simulations;
* lane economics simulations; and
* light-client sampling design if justified.

Exit criteria:

* stronger sampling-first claims are either supported by a formal model or kept
  out of public positioning.

-----

## 21. Tests and Evidence

Every implementation PR should state which certificate tier it affects.

Minimum test categories:

* DA Deal create/fund/update/query tests;
* DA Deal low-watermark and pause-watermark funding tests;
* DA Deal to DA lane linkage authorization tests;
* append CAS and lane-root tests;
* provider assignment determinism tests;
* attestation signature/domain-separator tests;
* quorum threshold pass/fail tests;
* stale root and stale generation rejection tests;
* failed sample rejection tests;
* historical-generation retrieval tests;
* retained-service degradation tests;
* repair/rotation tests for retained status; and
* external verifier fixtures for each certificate tier.

Performance evidence should be added before production claims:

* batch size;
* encoding profile;
* provider count;
* DA Deal budget runway by publication, retrieval, retention, and repair class;
* disperser egress during certification;
* per-slot provider-daemon ingress;
* attestation aggregation latency;
* certification latency by tier;
* sample count and sample-serving latency;
* retrieval throughput after certification at 1, 10, and 50 concurrent readers;
* repair time after provider loss; and
* bridge/verifier cost.

-----

## 22. Product Positioning

Suggested name family:

* PolyStore DA Lanes
* PolyFS Availability Certificates
* PolyStore Retrievable DA
* PolyDA, only after the security model is strong enough

Suggested one-liner:

> Launch a chain with a DA Deal: publish batches, receive availability
> certificates, and keep data retrievable for as long as the chain funds the
> Deal.

Suggested protocol one-liner:

> PolyStore DA Lanes let applications publish erasure-coded batches, receive an
> availability certificate, and keep the same data retrievable through paid,
> provable, repairable storage.

Suggested technical claim for the first product:

> PolyStore DA is attestation-first DA with native durable retrieval: provider
> attestations certify publication, while PolyFS generations, retrieval
> sessions, and repair preserve access after acceptance.

Suggested claim to avoid:

> PolyStore already provides sampling-first DA security.

-----

## 23. Open Questions

1. What is the exact confidence bound for retrievable sample counts under
   RS(8,12)?
2. Should quorum policies be slot-weighted, stake-weighted, capacity-weighted,
   bandwidth-weighted, or multi-dimensional?
3. Can KZG homomorphism over the current RS parity construction support compact
   encoding-correctness checks?
4. What aggregate signature or quorum-proof scheme minimizes bridge verifier
   cost?
5. What is the minimum `DA_CERT_RETRIEVABLE` certificate shape an external
   settlement contract can verify safely?
6. Which false attestation cases are slashable on-chain versus only
   service-history penalties?
7. How should public paid sampling be rate-limited by lane policy, protocol
   policy, or both?
8. Does the 8 MiB MDU remain appropriate for small rollup batches, or should DA
   lanes aggregate many small batches into larger PolyFS segments?
9. What retention and garbage-collection policy should DA-retained historical
   generations use relative to provisional-generation cleanup?
10. Which external integration should be first: OP Stack alt-DA, a generic SDK,
    or a source-DA archive bridge?
11. Should `DADealPolicy` embed full lane policy or reference separately
    versioned quorum, sample, retrieval, repair, and scale-up policies?
12. Which provider scale-up triggers should be automatic protocol behavior
    versus premium service requests from the chain treasury?

-----

## 24. Recommendation

Adopt PolyFS DA Lanes as an attestation-first DA direction with Chain-Funded DA
Deals as the deployment model and `DA_CERT_RETRIEVABLE` as the flagship
certificate target.

The recommended sequencing is:

1. Keep historical DA archive/retrieval as the near-term commercial wedge.
2. Implement Chain-Funded DA Deal policy, funding, and lane linkage.
3. Implement `DA_CERT_FAST` as the smallest primary-DA certificate.
4. Implement `DA_CERT_RETRIEVABLE` before making differentiated DA claims.
5. Implement `DA_CERT_RETAINED` after retrievable certification and repair hooks
   work in devnet.
6. Keep sampling-first DAS as a research track rather than the first product
   claim.

This direction avoids cloning existing DA systems. It focuses PolyStore on the
point where it can be differentiated: publication-time attestations,
publication-time retrieval samples, long-term retrieval, repair, and economic
accountability as one continuous system.

-----

## 25. References

Local:

* `whitepaper.md`
* `docs/notes/HISTORICAL_DA_ARCHIVAL_RETRIEVAL_MARKET.md`
* `docs/polyfs-chain-funded-da-deals.md`
* `docs/chain-funded-da-deal-policy-fixtures.md`
* `rfcs/rfc-blob-alignment-and-striping.md`
* `rfcs/rfc-chain-funded-da-deals.md`
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
* EigenDA overview:
  `https://docs.eigencloud.xyz/eigenda/core-concepts/overview`
* Avail DA docs:
  `https://docs.availproject.org/docs/da/concepts/how-avail-da-works`
