# Prompt 1 — Outline the Work (Plan → TODOs → Commit)

You are working in `nilcoin2`.

## Immediate Goals (High-Level)
1. **Close NilFS “single source of truth”**: remove CID/index fallback fetch paths so the system derives state from the on-disk slab (`MDU #0` + Witness/User MDUs) and works after restart.
2. **Finish “dynamic sizing / no capacity tiers” cleanup** end-to-end.
3. **Add a real browser smoke E2E suite** (Playwright or Cypress) that runs against `./scripts/run_local_stack.sh start`.

**Explicitly deprioritized for now:** native↔WASM parity tests.

## Task
1. Read `AGENTS.md` (especially §11).
2. Produce a concrete TODO checklist in `AGENTS.md` that breaks the 3 goals into small, testable steps with:
   - file-level pointers (what files will change),
   - “pass gates” (what behavior must be verified),
   - “test gates” (what commands/tests should be run before merging).
3. Note that the current Dashboard MDU #0 inspector + commit-content UX is “good enough for this demo” and that further polish is a backlog item.
4. Commit the `AGENTS.md` TODO plan update to git with a descriptive message.

## Constraints / Repo Protocol
- Keep commits small and scoped.
- Avoid destructive git commands (`git clean`, `git reset --hard`, etc.).
- Stage only the files you intend to commit (avoid accidentally committing local deploy artifacts like `nil_bridge/broadcast/**` run logs).
- If you push, push to **both** remotes: `origin` and `nil-store`.

## Iteration Logic
- Check if your work defined in this prompt is **fully complete**.
- If valid work remains (you did "moderate work"), **ensure the file `@PROMPT_01_COMPLETE` DOES NOT exist** (delete it if present).
- If the work is already done or the changes were trivial, **create the empty file `@PROMPT_01_COMPLETE`**.
