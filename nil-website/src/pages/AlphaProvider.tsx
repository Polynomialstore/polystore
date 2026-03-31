import { Server } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";
import { buildProviderAgentPrompt } from "../lib/providerOnboarding";

const providerAgentPrompt = buildProviderAgentPrompt();

export function AlphaProvider() {
  return (
    <div className="px-4 pb-12 pt-24">
      <div className="container mx-auto max-w-6xl">
        <AlphaHero
          badge="/alpha/provider"
          logo={
            <div className="flex h-full w-full items-center justify-center">
              <Server className="h-14 w-14 text-primary" />
            </div>
          }
          title={<h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Run A Provider On Testnet</h1>}
          description="This is the operator path for the testnet. Open pairing from the website, generate one bootstrap command, then bring up a provider-daemon on a remote host such as a home server behind Cloudflare Tunnel or a publicly reachable VPS."
          actions={
            <>
              <PrimaryCtaLink to="/sp-onboarding">Provider Onboarding</PrimaryCtaLink>
            </>
          }
        />

        <section className="mt-12">
          <AgentPromptCard
            className="mx-auto max-w-2xl"
            badge="/alpha/provider/agent"
            title="Alternatively: Onboard with a coding agent"
            description="If you have a coding agent on the provider host, copy the bootstrap prompt and let it run the full provider setup and verification loop."
            prompt={providerAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}
