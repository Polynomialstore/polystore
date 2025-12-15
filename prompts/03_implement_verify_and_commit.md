# Prompt 3 — Implement, Verify, and Iterate (→ Commits + Tests)

You are working in `nilcoin2`. Prompts 1–2 established a detailed TODO plan in `AGENTS.md` and aligned specs/docs.

## Task
Implement the plan end-to-end, in small verified increments:

### A) NilFS Source of Truth (Remove CID/Index Fallback)
- Remove reliance on the local CID/index lookup path(s) for fetch/UX.
- Ensure all required data for fetch/listing is resolvable from the slab on disk (`uploads/<manifest_root>/mdu_0.bin`, witness MDUs, user MDUs, manifest blob) and works after process restart.
- Preserve compatibility for existing clients where feasible (explicitly document any breaking changes).

### B) Dynamic Sizing / No Capacity Tiers Cleanup
- Remove legacy tier fields and assumptions across:
  - chain proto/types + any EIP-712 verification logic,
  - gateway request/response shapes,
  - web typed-data signing and UI.
- Update any migrations and tests needed for the new semantics.

### C) Browser Smoke E2E (Playwright or Cypress)
- Add a lightweight browser e2e suite under `nil-website`.
- Add a smoke test that drives: connect wallet (test account) → create deal → upload file → commit content → assert manifest root and non-zero size → fetch file from explorer.
- Make it runnable against `./scripts/run_local_stack.sh start` and stable in CI/local.

## Verification Requirements
- Run the most relevant tests per change:
  - `nil_gateway`: Go unit tests, plus `./scripts/e2e_lifecycle.sh` as a backend gate.
  - `nilchain`: `go test ./...` and any proto generation/build steps required by your changes.
  - `nil-website`: unit tests + new browser e2e suite.
- If you must deviate from the plan, update `AGENTS.md` and the relevant specs/docs to reflect the new reality (in the same PR/commit series).

## Commit Protocol
- Commit frequently in small chunks with descriptive messages.
- Avoid destructive git commands.
- Stage only what you intend to ship (avoid committing local deploy artifacts like `nil_bridge/broadcast/**` run logs).
- If you push, push to **both** remotes: `origin` and `nil-store`.

## Iteration Logic
- Check if your work defined in this prompt is **fully complete**.
- If valid work remains (you did "moderate work"), **ensure the file `@PROMPT_03_COMPLETE` DOES NOT exist** (delete it if present).
- If the work is already done or the changes were trivial, **create the empty file `@PROMPT_03_COMPLETE`**.
