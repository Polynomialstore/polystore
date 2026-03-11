import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Database, Download, Upload, Wallet } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { DashboardCta } from "../components/DashboardCta";
import { PromptPanel } from "../components/marketing/PromptPanel";
import { ConnectWallet } from "../components/ConnectWallet";
import { FaucetWidget } from "../components/FaucetWidget";
import { FaucetAuthTokenInput } from "../components/FaucetAuthTokenInput";

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
              <Link
                to="/first-file"
                className="inline-flex items-center justify-center gap-3 rounded-none border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Start First File
                <ArrowRight className="w-4 h-4" />
              </Link>
              <DashboardCta className="inline-flex justify-center font-mono-data" label="Dashboard" to="/dashboard" />
            </>
          }
        />
        <section className="mt-12 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="glass-panel industrial-border p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
              /alpha/storage/browser-first
            </div>
            <h2 className="mt-3 text-2xl font-bold text-foreground">Start in the browser</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              The testnet storage experience should work without any local server. The intended happy path is connect wallet,
              request funds, create a deal, upload a small file, then retrieve it back and confirm the bytes match.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <ConnectWallet />
              <FaucetWidget />
              <Link
                to="/first-file"
                className="inline-flex items-center gap-2 rounded-none border border-border bg-background px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                Guided Wizard
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <FaucetAuthTokenInput className="mt-4" />

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <StepCard
                step="1"
                icon={<Wallet className="h-5 w-5 text-accent" />}
                title="Connect + switch network"
                detail="Connect MetaMask and make sure it is pointed at the NilStore testnet RPC."
                ctaLabel="Open Dashboard"
                ctaTo="/dashboard"
              />
              <StepCard
                step="2"
                icon={<Database className="h-5 w-5 text-primary" />}
                title="Fund your wallet"
                detail="Use the faucet if enabled. If the faucet requires an auth token, store it in your browser here first."
              />
              <StepCard
                step="3"
                icon={<Upload className="h-5 w-5 text-primary" />}
                title="Create + upload"
                detail="Create a deal, pick a small file, and upload it through the browser-first flow."
                ctaLabel="Open First File"
                ctaTo="/first-file"
              />
              <StepCard
                step="4"
                icon={<Download className="h-5 w-5 text-accent" />}
                title="Retrieve + confirm"
                detail="Download the file back and verify retrieval succeeds cleanly before moving to larger files."
                ctaLabel="Open Dashboard"
                ctaTo="/dashboard"
              />
            </div>
          </div>

          <div className="glass-panel industrial-border p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
              /alpha/storage/checklist
            </div>
            <h2 className="mt-3 text-2xl font-bold text-foreground">Success criteria</h2>
            <div className="mt-5 space-y-3">
              <ChecklistRow text="Wallet connects and shows the expected NilStore testnet network." />
              <ChecklistRow text="Faucet request succeeds, or the wallet is funded manually." />
              <ChecklistRow text="A deal is created successfully." />
              <ChecklistRow text="A small file uploads without provider/session errors." />
              <ChecklistRow text="The same file downloads back successfully." />
            </div>

            <div className="mt-6 rounded-none border border-border bg-background/60 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Operator note</div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                This page is the testnet user quickstart. A later PR in the stack will add a repo-local Codex and Claude Code
                prompt for storage power users who want local gateway setup and local diagnostics.
              </p>
            </div>

            <div className="mt-6 flex flex-col gap-3">
              <Link
                to="/first-file"
                className="inline-flex items-center justify-center gap-2 rounded-none border border-primary bg-primary px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Start Guided Flow
                <ArrowRight className="h-4 w-4" />
              </Link>
              <DashboardCta className="inline-flex justify-center font-mono-data" label="Dashboard" to="/dashboard" />
            </div>
          </div>
        </section>

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

function StepCard({
  step,
  icon,
  title,
  detail,
  ctaLabel,
  ctaTo,
}: {
  step: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
  ctaLabel?: string;
  ctaTo?: string;
}) {
  return (
    <div className="rounded-none border border-border bg-background/70 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-border bg-card text-xs font-bold text-muted-foreground">
          {step}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-foreground">
            {icon}
            <h3 className="text-sm font-semibold">{title}</h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{detail}</p>
          {ctaLabel && ctaTo ? (
            <Link
              to={ctaTo}
              className="mt-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary transition-colors hover:text-foreground"
            >
              {ctaLabel}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-none border border-border bg-background/70 px-4 py-3">
      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
      <div className="text-sm leading-relaxed text-muted-foreground">{text}</div>
    </div>
  );
}
