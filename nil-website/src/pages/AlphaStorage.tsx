import { Database } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const storageAgentPrompt = `You are helping a NilStore testnet storage user complete a full local onboarding run.

Goal:
- leave the user with a working local gateway
- complete CLI bootstrap with a burner wallet
- import that same wallet into MetaMask
- verify browser and gateway flows with the same identity

Repo bootstrap (required unless already inside a fresh nil-store checkout):
1. If repo is missing:
   - git clone https://github.com/Nil-Store/nil-store.git
   - cd nil-store
2. Refresh checkout:
   - git fetch origin --prune
   - git checkout main
   - git pull --ff-only origin main

Execution order:
- Perform repo bootstrap and sync first.
- Do local environment readiness before opening the website.
- Prefer one identity end-to-end:
  1. bootstrap with scripts/testnet_burner_upload.sh
  2. import that wallet into MetaMask
  3. verify browser and gateway flows with the same address
- Downgrade to browser-only only if local gateway or CLI cannot be brought up.

Context:
- Primary homepage: https://nilstore.org/#/first-file.
- Primary local gateway: http://localhost:8080.
- Use docs/ALPHA_STORAGE_USER_QUICKSTART.md and docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md.
- Never print secrets or private keys in full.

Operating mode:
- This is a guided onboarding run, not a test automation run.
- The user performs wallet approvals and file picker actions in the browser.
- Provide precise step-by-step instructions and wait for confirmation before advancing.
- Keep a running evidence ledger so wallet, gateway, and deal state stay consistent across milestones.

Canonical onboarding milestones:
1. Environment Ready
   - repo synced
   - website and EVM RPC reachable
   - required local tools installed
   - local gateway healthy at http://localhost:8080
2. Bootstrap Wallet
   - run scripts/testnet_burner_upload.sh with a small file (10-100 KiB)
   - capture EVM address, nil address, keystore path, deal ID, manifest root, and commit tx hash
3. MetaMask Handoff
   - import the exported keystore into MetaMask
   - confirm the MetaMask address exactly matches the CLI-generated address
4. Browser Continuity Check
   - open https://nilstore.org/#/first-file
   - connect the imported MetaMask wallet
   - verify the site sees the same address and local gateway
   - perform retrieval and/or a small browser upload/retrieve using that same wallet
5. Gateway Large-File Check
   - re-run upload/commit/retrieve with a larger file (64 MiB+)
   - capture gateway health, route or cache behavior, and retrieval evidence
6. Advanced CLI Check
   - relay-capable environments: try scripts/enterprise_upload_job.sh <file_path> [deal_id] [nilfs_path]
   - wallet-first/public environments: follow Public CLI smoke in docs/TRUSTED_DEVNET_SOFT_LAUNCH.md
   - capture remaining UX friction

Failure handling:
- Retry with intent, not indefinitely.
- If Environment Ready cannot be completed, explicitly downgrade to browser-only and record why.
- If a later milestone fails after bounded retries, mark it blocked, capture raw evidence, and continue only if the next milestone still makes sense.

Final output:
1. JSON summary with:
   - flow_mode
   - website_url
   - chain_id
   - wallet_address
   - nil_address
   - gateway_base
   - gateway_health
   - keystore_path
   - deal_created
   - deal_id
   - create_tx_hash
   - commit_tx_hash
   - manifest_root
   - upload_succeeded
   - uploaded_file_name
   - uploaded_file_size_bytes
   - retrieval_succeeded
   - retrieved_matches_upload
   - retrieve_tx_hash
   - used_local_gateway
   - milestone_environment_ready
   - milestone_bootstrap_wallet
   - milestone_metamask_handoff
   - milestone_browser_continuity
   - milestone_gateway_large_file
   - milestone_cli_advanced
   - milestone_notes
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
          description="For the full local onboarding path, bootstrap a wallet locally, import it into MetaMask, then verify browser and gateway flows with that same identity."
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
            description="If you have a coding agent locally, use the milestone-based prompt: local readiness, burner-wallet bootstrap, MetaMask handoff, browser continuity, then gateway and CLI verification."
            prompt={storageAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}

// (Checklist and wizard cards removed; prompts remain.)
