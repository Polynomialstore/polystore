# Prompt 2 — Review Plan, Add Implementation Detail, Align Specs (→ Commit)

You are working in `nilcoin2`. Prompt 1 created/updated an “Immediate Goals” TODO plan in `AGENTS.md`.

## Task
1. Review the new TODO plan in `AGENTS.md` and refine it:
   - Fill in significant implementation details (APIs to change, invariants, migrations, backwards-compat rules, and expected test coverage).
   - Identify any risky parts (e.g., fetch path compatibility, EIP-712 breaking changes, browser wallet automation).
2. Update specs/docs so they match the intended end state of the TODO plan:
   - Protocol/architecture: `spec.md`, `notes/triple-proof.md` (and any other referenced notes).
   - Gateway/API: `nil_s3/nil-s3-spec.md` (or other gateway docs).
   - Web: `nil-website/website-spec.md` and relevant pages/docs if the flow changes.
3. Ensure the specs are consistent about:
   - “No tiers / thin provisioning” semantics.
   - NilFS as the source of truth (no CID/index dependence).
   - Browser E2E expectations and how the wallet is handled in tests (real extension vs injected shim).
4. Commit the spec/doc updates with a descriptive message.

## Constraints / Repo Protocol
- Keep commits small and scoped to docs/spec alignment.
- Avoid destructive git commands.
- Stage only the files you intend to commit (avoid accidentally committing local deploy artifacts like `nil_bridge/broadcast/**` run logs).
- If you push, push to **both** remotes: `origin` and `nil-store`.

## Iteration Logic
- Check if your work defined in this prompt is **fully complete**.
- If valid work remains (you did "moderate work"), **ensure the file `@PROMPT_02_COMPLETE` DOES NOT exist** (delete it if present).
- If the work is already done or the changes were trivial, **create the empty file `@PROMPT_02_COMPLETE`**.
