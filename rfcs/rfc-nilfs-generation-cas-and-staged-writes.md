# RFC: NilFS Generation CAS and Staged Writes

## Status
Draft

## Problem
NilFS is a mutable filesystem layered on top of content-committed slab generations. Without an explicit compare-and-swap rule, two browser or gateway instances can both derive new NilFS states from the same base generation and race to overwrite each other. Without staged-generation semantics, providers and gateways can also discard live bytes too early when an upload churns or aborts.

This creates two distinct risks:
1. **Stale overwrite risk:** a second writer can unintentionally replace a newer committed generation with a mutation built from an older base.
2. **Upload-churn griefing risk:** repeated provisional uploads can consume storage, bandwidth, and operator attention even when the final chain swap never succeeds.

## Goals
* Define the authoritative overwrite guard for NilFS generation updates.
* Define the client/browser bootstrap rule for append and rewrite flows.
* Define provider/gateway staged-generation behavior before and after chain confirmation.
* Make the griefing surface explicit so cleanup/accounting policy can evolve intentionally.

## Non-Goals
* This RFC does not define the final pricing or governance response to churn.
* This RFC does not require providers to understand filesystem semantics beyond generation identifiers and byte-addressed artifacts.

## Model
Every NilFS mutation is a generation swap:
* base generation: `previous_manifest_root = H1`
* proposed generation: `new_manifest_root = H2`

The owner signs an update intent containing both values. The chain only accepts the mutation if the currently committed deal root is still `H1`.

## Normative Rules

### 1. Signed CAS
* `previous_manifest_root` MUST be part of the owner-signed `MsgUpdateDealContent*` payload.
* The chain MUST validate `previous_manifest_root == Deal.manifest_root` at execution time.
* If the comparison fails, the transaction MUST be rejected as stale.
* Any provider- or gateway-supplied copy of `previous_manifest_root` is preflight/advisory only.

### 2. Browser and gateway bootstrap
* A client MUST compare its local cached generation to on-chain `Deal.manifest_root` before preparing an append or rewrite.
* If the cache is missing or stale, the client MUST bootstrap the current committed generation from the retrieval path before mutating.
* A client MUST NOT silently rebuild from empty state when a committed generation already exists.

### 3. Staged generations at providers/gateways
* Uploaded bytes for `new_manifest_root` SHOULD be staged provisionally until the chain swap succeeds.
* The currently committed generation `previous_manifest_root` MUST remain available while `new_manifest_root` is provisional.
* Provider/gateway artifact ingest MAY accept an advisory expected-base header for the staged generation; the current reference header is `X-Nil-Previous-Manifest-Root`.
* If that expected-base header is present and stale, the provider/gateway SHOULD reject the upload before consuming artifact bytes.
* A stale or failed chain swap MUST NOT delete or replace the current generation.

## Browser OPFS Guidance
Browser clients should persist reconstructed slab generations in OPFS, keyed by deal and manifest root. The browser happy path for reads should prefer a fresh OPFS generation over network retrieval. A fresh browser append flow should reconstruct the committed generation into OPFS before computing new NilFS state.

## Griefing / Churn Surface
Provisional generations can be abused to create storage churn:
* repeated uploads that never complete the chain swap
* repeated stale attempts from concurrent browser instances
* intentionally conflicting rewrites intended only to force cleanup work

Future policy needs:
* retention TTL for abandoned provisional generations
* cleanup/GC triggers
* metrics for provisional bytes and stale-write frequency
* pricing or rate limits for excessive churn

Current devnet reference policy:
* complete provisional generations older than 24 hours may be garbage-collected during gateway/provider startup or recovery cleanup
* the active committed generation is never subject to this provisional TTL
* the gateway exposes the effective retention window as `NIL_PROVISIONAL_GENERATION_RETENTION_TTL` and reports it in `/status` as `nilfs_generation_provisional_retention_ttl_seconds`
* `NIL_PROVISIONAL_GENERATION_RETENTION_TTL=0` disables age-based provisional-generation GC
* the gateway SHOULD expose stale CAS preflight pressure in `/status` so concurrent-writer / abandoned-upload churn is observable; the current reference keys are `nilfs_cas_preflight_conflicts_total`, `nilfs_cas_preflight_conflicts_legacy`, `nilfs_cas_preflight_conflicts_evm`, and `nilfs_cas_preflight_conflicts_upload`

## Implementation Notes
Current implementation anchors signed CAS at:
* chain `MsgUpdateDealContent*`
* precompile / EIP-712 intent hashing
* gateway relay preflight rejection for stale roots

Follow-on implementation work:
* browser bootstrap of committed generations before append
* provider/gateway provisional generation directories and cleanup policy
