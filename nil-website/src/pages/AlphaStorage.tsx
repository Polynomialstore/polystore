import { Database } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";
import { buildStorageAgentPrompt } from "../lib/storageOnboarding";

const storageAgentPrompt = buildStorageAgentPrompt();

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
            title="Optional: onboard with a coding agent"
            description="Use the canonical storage prompt from the repo: autonomous local setup, burner-wallet bootstrap, MetaMask handoff, then browser continuity across /first-file and /dashboard."
            prompt={storageAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}

// (Checklist and wizard cards removed; prompts remain.)
