import { Database, ShieldCheck, Zap, Globe, BadgeCheck } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";
import { buildStorageAgentPrompt } from "../lib/storageOnboarding";

const storageAgentPrompt = buildStorageAgentPrompt();

const storagePoints = [
  {
    label: "Local First",
    body: "Upload data directly from your browser to the decentralized network.",
    icon: Zap,
  },
  {
    label: "End-to-End Proofs",
    body: "Verify your data is correctly stored and retrievable via cryptographic proofs.",
    icon: ShieldCheck,
  },
  {
    label: "Global Availability",
    body: "Data is sharded and distributed across a network of independent providers.",
    icon: Globe,
  },
] as const;

export function AlphaStorage() {
  return (
    <div className="px-4 pb-16 pt-12 md:pb-20">
      <div className="container mx-auto max-w-6xl space-y-12">
        <AlphaHero
          badge={
            <>
              <BadgeCheck className="h-4 w-4 text-primary" />
              Preview Testnet / Storage
            </>
          }
          logo={
            <div className="flex h-full w-full items-center justify-center">
              <Database className="h-10 w-10 text-primary md:h-12 md:w-12" />
            </div>
          }
          title="Store Data On Testnet"
          description="For the full local onboarding path, bootstrap a wallet locally, import it into MetaMask, then verify browser and gateway flows with that same identity."
          points={storagePoints}
          actions={
            <>
              <PrimaryCtaLink to="/first-file" leftIcon={<Database className="h-4 w-4" />}>
                Store First File
              </PrimaryCtaLink>
            </>
          }
        />

        <section className="mt-12">
          <AgentPromptCard
            className="mx-auto"
            badge="/alpha/storage/agent"
            title="Alternative: Onboard With A Coding Agent Prompt"
            description="Use the canonical storage prompt from the repo: autonomous local setup, burner-wallet bootstrap, MetaMask handoff, then browser continuity across /first-file and /dashboard."
            prompt={storageAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}

// (Checklist and wizard cards removed; prompts remain.)
