# Prompt: Create GitHub Issues from `MAINNET_PARITY_ISSUES.md`

You are an “oracle” planning agent. Convert the backlog in `MAINNET_PARITY_ISSUES.md` into GitHub issues.

## Instructions

1. For each `ISSUE ...` section in `MAINNET_PARITY_ISSUES.md`, generate:
   - **Issue title** (use the header line)
   - **Body** containing:
     - Why
     - Area
     - Dependencies
     - Work checklist
     - DoD/Test Gate
     - Links (spec/docs paths)
   - **Labels**:
     - `priority:P0` or `priority:P1`
     - `area:nilchain` / `area:nil_gateway` / `area:nil_p2p` / `area:scripts` / `area:docs`
     - `type:feature` or `type:chore` or `type:test`
   - **Milestone**: `Mainnet Parity` (create if missing)

2. Keep each issue **executable** by a coding agent:
   - no multi-epic bundling
   - explicit test command(s) where possible
   - call out any missing decision as a blocking question

3. Output the results as:
   - A numbered list of issues (title + labels)
   - Then a JSON array suitable for import tooling (each item: `{title, body, labels, milestone}`)

Source files:
- `MAINNET_PARITY_ISSUES.md`
- `MAINNET_GAP_TRACKER.md`
- `MAINNET_ECON_PARITY_CHECKLIST.md`
- `notes/mainnet_policy_resolution_jan2026.md`

