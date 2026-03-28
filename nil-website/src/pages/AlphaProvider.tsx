import { Server } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { AgentPromptCard } from "../components/marketing/AgentPromptCard";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const providerAgentPrompt = `You are setting up this machine as a NilStore testnet Storage Provider.

Repo bootstrap (required unless already inside a fresh nil-store checkout):
1. If repo is missing:
   - git clone https://github.com/Nil-Store/nil-store.git
   - cd nil-store
2. Refresh checkout:
   - git fetch origin --prune
   - git checkout main
   - git pull --ff-only origin main

Context:
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use docs/ALPHA_PROVIDER_QUICKSTART.md, docs/REMOTE_SP_JOIN_QUICKSTART.md, and docs/networking/PROVIDER_ENDPOINTS.md.
- Use hub-supplied values for CHAIN_ID, HUB_NODE, HUB_LCD, NIL_GATEWAY_SP_AUTH, and provider hostname.
- Never print secrets/private keys in full; redact sensitive values (especially NIL_GATEWAY_SP_AUTH).

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. Register provider on-chain.
5. Start provider service.
6. Verify:
   - ./scripts/run_devnet_provider.sh doctor
   - local http://127.0.0.1:8091/health
   - public https://sp.<domain>/health
   - LCD provider visibility
7. If anything fails, inspect logs, repair, and retry until healthy.

Final output:
1. JSON summary with:
   - provider_address
   - registered_endpoint
   - local_health_url
   - public_health_url
   - local_health_ok
   - public_health_ok
   - lcd_visible
   - service_status
   - commands_run
   - files_changed
2. A short human-readable summary.`;

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
