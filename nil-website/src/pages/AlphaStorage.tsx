import { Database } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { DashboardCta } from "../components/DashboardCta";
import { PromptPanel } from "../components/marketing/PromptPanel";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const storageCodexPrompt = `You are helping a NilStore testnet storage user complete the first successful storage flow.

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

const storageClaudePrompt = `Help a NilStore testnet storage user complete the first successful store and retrieve cycle.

Assumptions:
- The repository is already cloned locally.
- Start with the browser-first flow and only use local gateway steps if needed.
- Use docs/ALPHA_STORAGE_USER_QUICKSTART.md and docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md.

Tasks:
1. Confirm website and EVM RPC reachability.
2. Confirm the wallet is on the expected NilStore testnet chain.
3. Help the user get test funds.
4. Verify create deal, upload, and retrieve.
5. If there is a failure, inspect the relevant checks and loop until the path is healthy.

Final output:
- website URL
- chain ID
- wallet address
- deal/upload/retrieve result
- files changed`;

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
              <PrimaryCtaLink to="/first-file">Start First File</PrimaryCtaLink>
              <DashboardCta className="inline-flex justify-center font-mono-data" label="Dashboard" to="/dashboard" />
            </>
          }
        />

        <section className="mt-12 grid gap-6 lg:grid-cols-2">
          <PromptPanel
            badge="/alpha/storage/codex"
            title="Codex prompt"
            description="For power users who want a local repo-driven setup, this prompt tells Codex to validate the browser path first, then use local gateway diagnostics only when needed."
            prompt={storageCodexPrompt}
            copyLabel="Copy Codex Prompt"
            links={[
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/ALPHA_STORAGE_USER_QUICKSTART.md", label: "Testnet storage quickstart" },
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/onboarding-prompts/storage_codex.md", label: "Prompt in repo" },
            ]}
          />
          <PromptPanel
            badge="/alpha/storage/claude"
            title="Claude Code prompt"
            description="This gives Claude Code the same storage-user job: check the website path, help with wallet and funding, then verify create, upload, and retrieve."
            prompt={storageClaudePrompt}
            copyLabel="Copy Claude Prompt"
            links={[
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md", label: "Collaborator packet" },
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/onboarding-prompts/storage_claude_code.md", label: "Prompt in repo" },
            ]}
          />
        </section>
      </div>
    </div>
  );
}

// (Checklist and wizard cards removed; prompts remain.)
