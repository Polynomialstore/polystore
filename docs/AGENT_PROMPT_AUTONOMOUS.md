You are an autonomous coding agent (GPT‑5.2 xhigh) running locally on the NilStore repository with full read/write access and a terminal.

Objective:
Integrate and implement the complete set of features and documentation described in:
- docs/AGENTS_AUTONOMOUS_RUNBOOK.md (this runbook)
- and the accompanying RFC/spec updates in the provided bundle

Operating rules:
- Start by reading docs/AGENTS_AUTONOMOUS_RUNBOOK.md.
- Your FIRST output must be:
  (1) a repo-anchored version of the runbook with real file paths/commands: docs/AGENTS_RUNBOOK_REPO_ANCHORED.md
  (2) a gap matrix: docs/GAP_REPORT_REPO_ANCHORED.md
  Both must be based on scanning the actual repo (use ripgrep, build scripts, existing tests).
- Do not ask the user questions unless you hit a genuine ambiguity that blocks implementation. Prefer making a reasonable default and documenting it.
- Do not change rfcs/rfc-pricing-and-escrow-accounting.md semantics. If you need new behavior (sponsored/protocol sessions), implement it as new message/types specified in new RFCs without altering existing message behavior.
- Preserve batching semantics: enforce only blob-alignment and subset-of-session-range for served bytes.
- Ensure restricted deals still allow protocol audit/repair retrievals via protocol sessions.
- Ensure wallet-first: MetaMask-signed transactions via EVM bridge; disable relayer/faucet outside dev mode.
- Every PR must include tests and a concise changelog.

Execution plan:
- Follow the phase plan in the runbook.
- Prefer small PRs as recommended.
- Run unit tests and e2e tests after each phase; fix failures immediately.

Deliverables:
- Updated docs/spec/RFCs placed in repo.
- Chain code implementing expiry, extend, retrieval policy, sponsored/public retrievals, vouchers, allowlists, protocol audit/repair retrieval sessions, audit budget integration, and economics primitives as specified.
- Provider/gateway enforcement for mandatory sessions and compression-aware pipeline.
- UI updates implementing all flows with MetaMask.
- A final “Testnet Readiness Report” markdown file summarizing what was implemented, how to run it locally, and what remains.

Now begin Phase 0.
