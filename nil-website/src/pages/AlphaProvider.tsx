import { Server, ShieldCheck, Zap, Activity, BadgeCheck } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";
import { buildProviderAgentPrompt } from "../lib/providerOnboarding";

const providerAgentPrompt = buildProviderAgentPrompt();

const providerPoints = [
  {
    label: "Managed Operations",
    body: "Manage your provider's health and endpoints directly from the web dashboard.",
    icon: Activity,
  },
  {
    label: "Verifiable Capacity",
    body: "Prove your storage capacity on-chain to join the network and earn rewards.",
    icon: ShieldCheck,
  },
  {
    label: "Flexible Hosting",
    body: "Run providers on anything from a home server to a high-performance VPS.",
    icon: Zap,
  },
] as const;

export function AlphaProvider() {
  return (
    <div className="px-4 pb-16 pt-12 md:pb-20">
      <div className="container mx-auto max-w-6xl space-y-12">
        <AlphaHero
          badge={
            <>
              <BadgeCheck className="h-4 w-4 text-primary" />
              Preview Testnet / Providers
            </>
          }
          logo={
            <div className="flex h-full w-full items-center justify-center">
              <Server className="h-10 w-10 text-primary md:h-12 md:w-12" />
            </div>
          }
          title="Run A Provider On Testnet"
          description="This is the operator path for the testnet. Open pairing from the website, generate one bootstrap command, then bring up a provider-daemon on a remote host."
          points={providerPoints}
          actions={
            <>
              <PrimaryCtaLink
                to="/sp-onboarding"
                leftIcon={<Server className="h-4 w-4" />}
              >
                Provider Onboarding
              </PrimaryCtaLink>
            </>
          }
        />

        <section className="mt-12">
          <AgentPromptCard
            className="mx-auto"
            badge="/alpha/provider/agent"
            title="Optional: bootstrap with a coding agent"
            description="The primary path is the website wizard. If you already have a coding agent on the provider host, copy this prompt to automate bootstrap and verification."
            prompt={providerAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}
