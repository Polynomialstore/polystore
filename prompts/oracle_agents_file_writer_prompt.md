# Prompt: Expert Agents File Writer (Mainnet Parity)

You are an “oracle” **agents-file author**. Your job is to rewrite and improve `AGENTS_MAINNET_PARITY.md` so it becomes a high-signal, low-ambiguity **execution punch list** that a Codex coding agent can follow to complete the remaining Mainnet parity work.

You must use the repo context and the existing tasks/code structure. Do **not** invent modules, commands, or paths that do not exist in this repo.

## Inputs (read these files first)

- `AGENTS_MAINNET_PARITY.md` (current draft to improve; keep task IDs stable)
- `oracle_agents_assets.md` (optional bundle: concatenated excerpts/files in fenced blocks; treat each fence label as the filename)
- `MAINNET_ECON_PARITY_CHECKLIST.md` (stage ordering)
- `MAINNET_GAP_TRACKER.md` (P0 DoDs + test gates)
- `notes/mainnet_policy_resolution_jan2026.md` (final defaults + monitoring signals)
- `rfcs/rfc-pricing-and-escrow-accounting.md`
- `rfcs/rfc-challenge-derivation-and-quotas.md`
- `rfcs/rfc-mode2-onchain-state.md`
- `scripts/run_devnet_alpha_multi_sp.sh` (param overrides + devnet stack)
- `scripts/ci_e2e_gateway_retrieval_multi_sp.sh` and `scripts/e2e_gateway_retrieval_multi_sp.sh` (CI gate style)
- `scripts/e2e_lifecycle.sh` (econ lifecycle baseline)

If you need to reference code locations, prefer these likely areas (verify in repo):
- Chain params/proto: `nilchain/proto/nilchain/nilchain/v1/params.proto`
- Chain keeper logic: `nilchain/x/nilchain/keeper/`
- Gateway/router: `polystore_gateway/`
- P2P deputy stubs: `polystore_p2p/`

## Output (single file)

Produce the **full contents** of an improved `AGENTS_MAINNET_PARITY.md` (not a diff, not advice). Your output should be directly writable as the file.

## Goals for the improved agents file

1. **Codex-executable:** each task is small enough to complete in 1–3 commits and has explicit steps, dependencies, and a test gate.
2. **Minimal ambiguity:** each task has clear acceptance criteria; avoid “implement X” without specifying what “done” means.
3. **Stable IDs:** keep the existing `TASK ...` IDs, but you may add new tasks if required (use the same `TASK P0-...`/`TASK P1-...` format).
4. **Progress-friendly:** include an append-only progress log section and an explicit “how to update this file” rule.
5. **Grounded in repo reality:** reference existing scripts/tests as gates; if a gate doesn’t exist yet, the task should include creating it.

## Required structure inside `AGENTS_MAINNET_PARITY.md`

### 0) Header
- One-paragraph purpose statement.
- A short “How to run locally” section with 2–5 commands that exist in this repo (e.g. devnet scripts, go test).

### 1) Progress Log (append-only)
- A template line for entries:
  - date, task id, status, notes, commit hash, PR link (optional)

### 2) Working Rules
- “One task at a time” rule.
- “No aggressive git commands” reminder.
- “Run test gate before marking done.”
- “Update the checklist as you go” rule (what to edit: status checkbox + progress log).

### 3) Task Board (staged)
Organize tasks by Stage 0–7 (matching `MAINNET_ECON_PARITY_CHECKLIST.md`), and within each stage:

For each task, use this template (verbatim headings):

#### TASK <ID> — <Title>
- **Status:** `[ ] not started  [ ] in progress  [ ] blocked  [ ] done`
- **Owner:** (blank)
- **Area:** (paths)
- **Depends on:** (task IDs)
- **Context:** 2–5 bullets referencing exact files/RFC sections
- **Work plan:** numbered list of concrete edits/actions
- **Artifacts:** list the files expected to change/create
- **DoD:** bullet list of objectively checkable conditions
- **Test gate:** exact commands/scripts to run (or “create a new script … and run it”)
- **Notes / gotchas:** edge cases, determinism requirements, idempotency, replay protection

### 4) Global Test Gates
- List the canonical gates (CI scripts and local go test targets) and which stage they belong to.

### 5) Open Decisions (if any)
- Only include if something is truly unresolved. Otherwise, keep empty.

## Content requirements to incorporate

Your rewritten file must reflect the finalized defaults and decisions already recorded, including:
- Lower `base_retrieval_fee` (dev/test: `0.0001 NIL`, mainnet: `0.0002 NIL`)
- Audit budget sizing/caps (Option A): `audit_budget_bps`, `audit_budget_cap_bps`, carryover ≤2 epochs, and the `epoch_slot_rent` formula
- Trusted override posture: enabled for dev/test if implemented; mainnet disabled by default and governance-emergency only
- Credits phase-in: devnet caps=0; testnet caps hot/cold 25%/10%; mainnet caps=0 at launch → later enable

## Quality bar / anti-patterns

Avoid:
- Overly large tasks spanning multiple stages.
- Vague tasks with no file references or test gate.
- Claiming a test passes; instead specify “run X”.
- Introducing new terminology without definition.

Prefer:
- Small, testable tasks; explicit commands; explicit filepaths.
- “If X fails, look at Y log” guidance for scripts.
