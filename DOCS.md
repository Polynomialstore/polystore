# Documentation Index (Source of Truth)

This repo contains a mix of **normative protocol spec**, **RFC drafts**, **implementation notes**, and **marketing/narrative** documents.

## Canonical (Protocol)

- `spec.md`: Canonical protocol specification. If anything else conflicts with `spec.md`, `spec.md` wins.

## RFCs (Design Proposals / Deep Dives)

- `rfcs/`: Design proposals and focused deep dives. RFCs may be Draft/Proposed/Approved; check each header.
  - Recommended starting points:
    - `rfcs/rfc-data-granularity-and-economics.md` (thin provisioning + hard cap)
    - `rfcs/rfc-blob-alignment-and-striping.md` (Mode 2 / StripeReplica)
    - `rfcs/rfc-retrieval-validation.md` and `rfcs/rfc-retrieval-security.md` (retrieval evidence, deputy/griefing)
    - `rfcs/rfc-heat-and-dynamic-placement.md` (heat/placement instrumentation)
- `rfcs/archive/`: Historical / research-only materials kept for reference.

## Notes (Working Memory)

- `notes/`: Short working notes that memorialize framing, reviews, and implementation gotchas.
  - See `notes/README.md` for a curated list and status.

## Problem Statements (Non-normative, but important)

- `retrievability-memo.md`: Problem-only statement of retrievability / accountability invariants (no mechanism).

## Narrative / Tokenomics (Non-normative)

- `whitepaper.md`, `litepaper.md`: Narrative docs; may contain example parameters and forward-looking statements.
- `ECONOMY.md`: Tokenomics overview; values should be treated as examples unless explicitly marked “normative in spec”.

## Implementation Onboarding

- `README.md`: How to run/build/test the repo.
- `HAPPY_PATH.md`: Local devnet “happy path” runbook.

