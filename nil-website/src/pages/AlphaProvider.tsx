import { Server } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const providerAgentPrompt = `You are setting up this machine as a NilStore testnet Storage Provider.

Context:
- The repo is already cloned locally.
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use docs/ALPHA_PROVIDER_QUICKSTART.md, docs/REMOTE_SP_JOIN_QUICKSTART.md, and docs/networking/PROVIDER_ENDPOINTS.md.
- Use the values supplied by the hub operator for CHAIN_ID, HUB_NODE, HUB_LCD, NIL_GATEWAY_SP_AUTH, and the provider hostname.

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import the provider key.
3. Configure the local listener and public endpoint.
4. Register the provider on-chain.
5. Start the provider service.
6. Verify local /health, public reachability, and on-chain provider visibility.
7. If anything fails, inspect logs, repair, and retry until healthy.

At the end, print:
- provider address
- registered endpoint
- local health URL
- public health URL
- service status
- exact files changed`;

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
          description="This is the operator path for the testnet. The recommended target is a remote provider host, ideally a home server behind Cloudflare Tunnel or a publicly reachable VPS."
          actions={
            <>
              <PrimaryCtaLink to="/sp-onboarding">Provider Onboarding</PrimaryCtaLink>
            </>
          }
        />

        <section className="mt-12">
          <AgentPromptCard
            badge="/alpha/provider/agent"
            title="Onboard with a coding agent"
            description="If you have Codex or Claude Code on the provider host, copy the bootstrap prompt and let the agent run the full provider setup and verification loop."
            prompt={providerAgentPrompt}
          />
        </section>
      </div>
    </div>
  );
}
