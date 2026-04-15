# Terminology Cleanup Follow-up

**Status:** Deferred follow-up  
**Tracking issue:** https://github.com/Polynomialstore/polystore/issues/31

## Context

Recent cleanup work already did the following:

- made the striped / StripeReplica path the active architecture in the spec and active docs
- aligned active docs more closely with the current implementation
- removed speculative heat RFCs
- renamed the live counter surface from `DealHeatState` / `GetDealHeat` / `/heat` to `DealActivityState` / `GetDealActivity` / `/activity`

That pass intentionally stopped short of a full repo-wide naming and artifact sweep.

## Required follow-up

- finish removing `Mode 1` / `Mode 2` terminology from active repo surfaces where it is no longer the right mental model
- rename surviving active filenames and references that still encode `mode2` even though the striped path is canonical
- sweep active planning/runbook/docs files and replace stale naming with `StripeReplica`, `striped`, or `legacy full-replica` as appropriate
- decide whether remaining code/schema/store identifiers like `mode2_*` should be renamed now that breaking changes and full chain reset are acceptable
- if the remaining `mode2_*` identifiers are renamed, update tests, scripts, generated artifacts, and user-facing docs in the same pass

## Optional follow-up

- prune or clearly mark historical snapshot/prompt/context artifacts that still contain old terminology
- trim old planning/debug notes that are no longer useful once the new naming is settled
- decide whether `mode2_reconstruct_*` observability counters should also be renamed, or explicitly left as legacy internals

## Candidate surfaces

Likely active surfaces for the next pass:

- `AGENTS.md`
- `DOCS.md`
- `notes/README.md`
- `notes/mode2-framing.md`
- `notes/mode2-artifacts-v1.md`
- `rfcs/rfc-mode2-onchain-state.md`
- active website/gateway/devnet docs
- active test names and script names that are now misleading

Lower priority / optional:

- `tools/econ_jan2026/docs_snapshot/*`
- `assets_for_prompt.md`
- archived research material

## Exit criteria

- active docs and active code-facing names tell one consistent story
- `mode1` / `mode2` are only present where they are truly historical or unavoidable
- any intentionally retained legacy names are called out explicitly
- grep noise from stale terminology is materially reduced
