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
- Use docs/ALPHA_STORAGE_USER_QUICKSTART.md and docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md.
- If local gateway is unavailable, continue browser-only flow and note skipped diagnostics.
- Never print secrets/private keys in full; redact sensitive values.

Your job:
1. Run preflight checks: website URL reachable, EVM RPC reachable, wallet on expected chain ID.
2. Help user connect MetaMask and fund wallet.
3. Verify first create-deal, upload, and retrieve flow.
4. If local gateway is available, verify it and use it for diagnostics.
5. On failures, inspect browser/gateway/chain checks and retry until healthy.

Final output:
1. JSON summary with:
   - website_url
   - chain_id
   - wallet_address
   - deal_created
   - upload_succeeded
   - retrieval_succeeded
   - used_local_gateway
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
            description="If you have Codex or Claude Code available locally, copy the bootstrap prompt and let the agent drive the full storage flow to a verified first upload and download."
            prompt={storageAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}

// (Checklist and wizard cards removed; prompts remain.)
