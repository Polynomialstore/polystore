import { Database } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const storageAgentPrompt = `You are helping a NilStore testnet storage user complete the first successful storage flow.

Repo bootstrap (required unless already inside a fresh nil-store checkout):
1. If repo is missing:
   - git clone https://github.com/Nil-Store/nil-store.git
   - cd nil-store
2. Refresh checkout:
   - git fetch origin --prune
   - git checkout main
   - git pull --ff-only origin main

Context:
- Prefer browser-first path first.
- Primary homepage for this deployment: https://nilstore.org (fallback https://web.nilstore.org if needed).
- Use docs/ALPHA_STORAGE_USER_QUICKSTART.md and docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md.
- If local gateway is unavailable, continue browser-only flow and note skipped diagnostics.
- Never print secrets/private keys in full; redact sensitive values.

Operating mode:
- This is a guided onboarding run, not a test automation run.
- The user performs wallet approvals and file picker actions in the browser.
- You provide precise step-by-step instructions, then wait for user confirmation before advancing.
- If the user prefers terminal flow, run the equivalent CLI path and report the same evidence fields.

Canonical path stages (run in order unless the user asks to skip):
1. First File Wizard: browser-first small file upload (10-100 KiB).
2. Local Gateway path: set up local gateway and upload a larger file (64 MiB+).
3. CLI path (optimistic): perform a CLI-driven upload/commit/retrieve flow and note UX friction.

Your job:
1. Run preflight checks: website URL reachable, EVM RPC reachable, wallet on expected chain ID.
2. Align on flow mode with the user:
   - website (default): guided browser flow
   - cli (optional): command-line flow
3. Stage 1 (First File Wizard): guide and verify each checkpoint:
   - wallet connected
   - funded for gas
   - deal created
   - file uploaded and committed
   - file retrieved
   - retrieved content matches uploaded content
4. Stage 2 (Local Gateway + large file):
   - help the user set up local gateway at http://localhost:8080
   - re-run upload/commit/retrieve with a larger file (64 MiB+)
   - capture gateway health and retrieval evidence
5. Stage 3 (CLI path, optimistic):
   - relay-capable environments: try scripts/enterprise_upload_job.sh <file_path> [deal_id] [nilfs_path]
   - wallet-first/public environments: follow Public CLI smoke in docs/TRUSTED_DEVNET_SOFT_LAUNCH.md
   - capture command output, artifacts, and CLI UX friction points
6. On failures, inspect browser/gateway/chain checks and retry until healthy.

Final output:
1. JSON summary with:
   - flow_mode
   - website_url
   - chain_id
   - wallet_address
   - deal_created
   - deal_id
   - create_tx_hash
   - upload_succeeded
   - uploaded_file_name
   - uploaded_file_size_bytes
   - retrieval_succeeded
   - retrieved_matches_upload
   - retrieve_tx_hash
   - used_local_gateway
   - stage1_first_file_wizard
   - stage2_gateway_large_file
   - stage3_cli_upload
   - stage3_cli_notes
   - commands_run
   - files_changed
2. A short human-readable summary.`;

export function AlphaStorage() {
  return (
    <div className="px-4 pb-12 pt-24">
      <div className="container mx-auto max-w-6xl">
        <AlphaHero
          badge="/alpha/storage"
          logo={
            <div className="flex h-full w-full items-center justify-center">
              <Database className="h-14 w-14 text-primary" />
            </div>
          }
          title={<h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Store Data On Testnet</h1>}
          description="This is the storage-user path for the testnet. Start in the browser, connect a wallet, fund your account, and complete your first store and retrieve flow."
          actions={
            <>
              <PrimaryCtaLink to="/first-file">Store First File</PrimaryCtaLink>
            </>
          }
        />

        <section className="mt-12">
          <AgentPromptCard
            className="mx-auto max-w-2xl"
            badge="/alpha/storage/agent"
            title="Alternatively: Onboard with a coding agent"
            description="If you have a coding agent available locally, copy the bootstrap prompt and run the three canonical paths: First File wizard, Local Gateway large-file flow, and CLI flow."
            prompt={storageAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}

// (Checklist and wizard cards removed; prompts remain.)
