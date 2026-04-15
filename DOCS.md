# Documentation Index (Source of Truth)

This repo contains a mix of **normative protocol spec**, **RFC drafts**, **implementation notes**, and **marketing/narrative** documents.

## Canonical (Protocol)

- `spec.md`: Canonical protocol specification. If anything else conflicts with `spec.md`, `spec.md` wins.
- `docs/runtime-personas.md`: Canonical runtime persona naming/ownership contract (`user-gateway` vs `provider-daemon`).

## RFCs (Design Proposals / Deep Dives)

- `rfcs/`: Design proposals and focused deep dives. RFCs may be Draft/Proposed/Approved; check each header.
  - Recommended starting points:
    - `rfcs/rfc-data-granularity-and-economics.md` (thin provisioning + hard cap)
    - `rfcs/rfc-blob-alignment-and-striping.md` (Mode 2 / StripeReplica)
    - `rfcs/rfc-mode2-onchain-state.md` (Mode 2 on-chain fields + repairs)
    - `rfcs/rfc-challenge-derivation-and-quotas.md` (synthetic challenges + quota policy)
    - `rfcs/rfc-pricing-and-escrow-accounting.md` (lock-in pricing + fees + caps)
    - `rfcs/rfc-deal-expiry-and-extension.md` (deal term expiry + renewals)
    - `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md` (sessions-first data-plane gating + batching)
    - `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md` (restricted/public deals + allowlists + vouchers)
    - `rfcs/rfc-content-encoding-and-compression.md` (compression-aware pipeline: compress-before-encrypt)
    - `rfcs/rfc-provider-exit-and-draining.md` (provider exit/draining + repair/GC interactions)
    - `rfcs/rfc-base-reward-pool-and-emissions.md` (issuance + base reward pool)
    - `rfcs/rfc-retrieval-validation.md` and `rfcs/rfc-retrieval-security.md` (retrieval evidence, deputy/griefing)
- `rfcs/archive/`: Historical / research-only materials kept for reference.

## Notes (Working Memory)

- `notes/`: Short working notes that memorialize framing, reviews, and implementation gotchas.
  - See `notes/README.md` for a curated list and status.

## Problem Statements (Non-normative, but important)

- `retrievability-memo.md`: Problem-only statement of retrievability / accountability invariants (no mechanism).

## Narrative / Tokenomics (Non-normative)

- `whitepaper.md`, `litepaper.md`: Canonical narrative docs; may contain example parameters and forward-looking statements.
- `polystore-website/public/whitepaper.md`, `polystore-website/public/litepaper.md`: Synced website copies generated from the repo-root papers via `polystore-website/scripts/sync-papers.mjs`.
- `ECONOMY.md`: Tokenomics overview; values should be treated as examples unless explicitly marked “normative in spec”.

## Implementation Onboarding

- `README.md`: How to run/build/test the repo.
- `docs/branding-transition.md`: Current brand naming contract (`PolyStore`) and intentionally frozen `nil*` technical surfaces.
- `HAPPY_PATH.md`: Local devnet “happy path” runbook.
- `DEVNET_MULTI_PROVIDER.md`: How to run a multi-provider devnet and join as a remote provider.
- `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`: Trusted collaborator devnet soft launch pack (hub + remote providers).
- `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`: “Send this to collaborators” quickstart (website testing + optional SP join).
- `docs/REMOTE_SP_JOIN_QUICKSTART.md`: Remote provider join quickstart (fast path).
- `docs/networking/PROVIDER_ENDPOINTS.md`: Provider endpoint profiles (`direct` and `cloudflare-tunnel`).
- `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md`: Minimal monitoring checklist for the soft launch.

## Agent Runbooks

- `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`: Autonomous phase plan for repo anchoring, deal lifecycle, retrieval policies, protocol hooks, and compression.
- `docs/AGENTS_RUNBOOK_REPO_ANCHORED.md`: Repo-specific index of where things live + what CI actually runs.
- `docs/GAP_REPORT_REPO_ANCHORED.md`: Requirement → implementation gap matrix (repo-anchored).
- `docs/TESTNET_READINESS_REPORT.md`: Phase 8 testnet readiness gates + one-command local stack and e2e.

## Planning / Tracking

- `MAINNET_GAP_TRACKER.md`: Tracked gaps between current implementation and the long-term Mainnet plan.
- `AGENTS_TRUSTED_DEVNET_SOFT_LAUNCH_TODO.md`: PR-by-PR TODO list for the Feb 2026 trusted devnet soft launch.
