import { Database } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const storageAgentPrompt = `You are helping a NilStore testnet storage user complete the first successful storage flow.

Context:
- The repo is already cloned locally.
- Prefer the browser-first path first.
- Use docs/ALPHA_STORAGE_USER_QUICKSTART.md and docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md.

Your job:
1. Verify the website endpoint, EVM RPC, and wallet network settings.
2. Help the user connect MetaMask and fund the wallet.
3. Verify the first create-deal, upload, and retrieve flow.
4. If a local gateway is available, verify it and use it for diagnostics.
5. If anything fails, inspect the relevant browser, gateway, or chain-facing checks and retry until healthy.

At the end, print:
- website URL
- chain ID
- wallet address
- whether deal creation succeeded
- whether upload and retrieval succeeded
- exact commands or files changed`;

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
