# Chain-Funded DA Deal Policy Fixtures

**Status:** Planning fixtures for protocol, product, and simulation work
**Related:**
`rfcs/rfc-chain-funded-da-deals.md`,
`rfcs/rfc-polyfs-da-lanes.md`,
`docs/polyfs-chain-funded-da-deals.md`

These fixtures are not final mainnet parameters. They are concrete profiles to
keep implementation, simulations, and founder conversations grounded in real
chain shapes.

-----

## Fixture A: Major L2 Retained DA

**Target public chains:** Base, Arbitrum, World Chain, OP Mainnet, Unichain

**Initial PolyStore role:** retained DA, historical blob retrieval, indexer
backfill, challenger recovery, and public history. Source DA remains the
primary settlement security layer at first.

```yaml
fixture_id: retained-major-l2-v0
default_certificate_tier: DA_CERT_RETAINED
primary_security_source: ethereum_blob_da
logical_da_per_day: 0.5-2 GB
erasure_profile: RS(8,12)
min_providers: 12
max_providers: 24
min_attesting_slots: 10
target_cert_latency: 10s-60s
retention_window: 365d
retrieval_payment_policy: sponsored_for_protocol_reads_requester_pays_public
repair_policy: repair_below_10_healthy_slots
scale_up_policy: add_providers_on_hot_retrieval_or_repair_backlog
```

Why it matters:

* This is the easiest wedge because it does not ask a conservative L2 to switch
  primary DA first.
* It monetizes durable retrieval, backfills, explorer/indexer data, and node
  recovery.
* It creates proof that PolyStore can retain and serve public rollup history
  before asking bridges to trust PolyStore certificates as primary DA.

Required evidence:

* one-year storage projection by chain;
* retrieval throughput for 1, 10, and 50 concurrent backfill readers;
* failed-provider repair time; and
* proof bundle for a retained historical batch.

-----

## Fixture B: OP Stack Alt-DA Primary Pilot

**Target public chains:** Mode, Zora, Soneium, World Chain test environment,
new OP Stack appchains

**Initial PolyStore role:** primary attestation-first DA through an OP Stack
Alt-DA adapter once `DA_CERT_FAST` and `DA_CERT_RETRIEVABLE` verifier fixtures
exist.

```yaml
fixture_id: op-stack-alt-da-primary-v0
default_certificate_tier: DA_CERT_RETRIEVABLE
settlement_context: op_stack_alt_da
logical_da_per_day: 10-500 MB
max_batch_bytes: 8-64 MiB
erasure_profile: RS(8,12)
min_providers: 12
max_providers: 24
min_attesting_slots: 10
target_fast_cert_latency: 2s-10s
target_retrievable_cert_latency: 10s-60s
sample_policy: delayed_randomness_policy_v0
retention_window: 30d-365d
retrieval_payment_policy: chain_sponsored_derivation_requester_pays_public
repair_policy: repair_below_10_healthy_slots
```

Why it matters:

* OP Stack already has the conceptual interface for an Alt-DA server and
  challenge semantics.
* This is the cleanest path from "PolyStore stores and serves DA history" to
  "PolyStore certificates can be accepted before settlement."
* Small and mid-size OP Stack chains are more plausible pilots than the largest
  L2s.

Required evidence:

* adapter can submit and retrieve batches through the PolyStore user-gateway;
* mock verifier rejects wrong-tier, stale, and insufficient-quorum
  certificates;
* derivation path can recover batch bytes from retained PolyStore data; and
* certificate latency stays inside the chosen policy window.

-----

## Fixture C: Orbit / AnyTrust-Style DA Deal

**Target public chains:** Arbitrum Nova, Xai, ApeChain, RARI/Treasure-style
Orbit chains

**Initial PolyStore role:** replace or augment a static committee-shaped DA
assumption with a provider-daemon market, Availability Certificates, retained
retrieval, and repair.

```yaml
fixture_id: orbit-anytrust-da-deal-v0
default_certificate_tier: DA_CERT_RETRIEVABLE
settlement_context: orbit_anytrust_style
logical_da_per_day: 50-500 MB
max_batch_bytes: 8-64 MiB
erasure_profile: RS(8,12)
min_providers: 12
max_providers: 36
min_attesting_slots: 10
target_fast_cert_latency: 2s-10s
target_retrievable_cert_latency: 10s-60s
retention_window: 90d-365d
retrieval_payment_policy: chain_sponsored_for_derivation_and_challenge_reads
repair_policy: repair_below_10_healthy_slots_with_hot_retrieval_scale_up
```

Why it matters:

* AnyTrust-style systems already understand availability certificates and data
  committees.
* Xai and ApeChain-like game/consumer systems produce public history that can
  be valuable for replay, analytics, indexers, and explorers.
* PolyStore can differentiate by attaching retained retrieval and repair to the
  certificate rather than stopping at committee signatures.

Required evidence:

* provider assignment can scale beyond a static committee;
* public retrieval remains available during a simulated game/indexer burst;
* retained status degrades and repairs without rewriting historical certificate
  issuance; and
* usage accounting separates publication, retrieval, retention, and repair.

-----

## Fixture D: Small Appchain Launch Deal

**Target public chains:** new OP Stack, Orbit, game, NFT, social, and appchain
launches

**Initial PolyStore role:** "DA included at launch" package with one treasury
account, one DA Deal, one lane, default retention, and predictable budget
runway.

```yaml
fixture_id: small-appchain-launch-v0
default_certificate_tier: DA_CERT_RETRIEVABLE
settlement_context: generic_rollup_or_appchain
logical_da_per_day: 10-100 MB
max_batch_bytes: 1-16 MiB
erasure_profile: RS(8,12)
min_providers: 12
max_providers: 18
min_attesting_slots: 10
target_fast_cert_latency: 2s-10s
target_retrievable_cert_latency: 10s-60s
retention_window: 90d
retrieval_payment_policy: chain_sponsored_limited_public_reads
repair_policy: repair_below_10_healthy_slots
scale_up_policy: manual_or_policy_triggered_after_sustained_heat
```

Why it matters:

* This is the simplest customer story: the chain funds one Deal and receives
  availability certificates plus retained retrieval.
* The scale is small enough for devnet and early testnet proof without masking
  protocol issues behind huge infrastructure.
* It gives a clean path for founder-led design partners.

Required evidence:

* end-to-end local devnet launch fixture;
* policy-created lane and backing storage deal;
* `DA_CERT_FAST` and `DA_CERT_RETRIEVABLE` issuance;
* public retrieval with rate limits; and
* low-funding pause behavior.

-----

## Fixture E: Modular DA Retained Retrieval

**Target public chains/ecosystems:** Manta Pacific, Eclipse, Initia-style and
Movement-style modular chains

**Initial PolyStore role:** retained retrieval and recovery layer while the
source DA system remains primary for publication security.

```yaml
fixture_id: modular-retained-retrieval-v0
default_certificate_tier: DA_CERT_RETAINED
primary_security_source: external_modular_da
logical_da_per_day: 100 MB-10 GB
erasure_profile: RS(8,12) or wider profile for high-throughput chains
min_providers: 12
max_providers: 48
min_attesting_slots: 10
target_cert_latency: 30s-300s
retention_window: 180d-730d
retrieval_payment_policy: requester_pays_with_chain_sponsored_recovery_budget
repair_policy: repair_below_policy_health_threshold
scale_up_policy: add_providers_on_retrieval_heat_or_retention_growth
```

Why it matters:

* This does not require displacing Celestia or another source DA layer.
* It gives modular chains durable recovery, public history, and paid retrieval.
* It keeps PolyStore in the DA stack while the sampling-first research track
  remains separate.

Required evidence:

* external source-DA commitment can be mapped to a PolyStore retained
  generation;
* historical range retrieval works by source namespace and height;
* recovery reads are economically accounted for; and
* retention renewal/migration is visible before service degradation.

-----

## Cross-Fixture Defaults

Recommended provider profile:

```yaml
erasure_profile: RS(8,12)
min_attesting_slots: 10
hard_reconstructability_floor: 8
repair_trigger: fewer_than_10_healthy_slots
initial_provider_count: 12
scale_up_provider_count: 18-48
```

Recommended budget classes:

```yaml
publication_budget: required
retrieval_budget: required
retention_budget: required
repair_budget: required
```

Recommended public reporting:

```yaml
usage_window:
  batches_published: true
  logical_bytes_published: true
  encoded_bytes_stored: true
  certificate_count_by_tier: true
  retrieval_bytes_served: true
  repair_bytes_moved: true
  projected_runway_by_budget: true
```

These defaults should become test fixtures once the chain objects exist.
