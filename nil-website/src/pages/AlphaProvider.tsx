import { Link } from "react-router-dom";
import { Copy, Server, Shield, Globe, Terminal } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { TrackCard } from "../components/marketing/TrackCard";
import { PromptPanel } from "../components/marketing/PromptPanel";
import { PrimaryCtaLink } from "../components/PrimaryCta";

const providerCodexPrompt = `You are setting up this machine as a NilStore testnet Storage Provider.

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

const providerClaudePrompt = `Set up this machine as a NilStore testnet Storage Provider.

Assumptions:
- The repository is already cloned locally.
- Preferred mode is home server + Cloudflare Tunnel.
- Use docs/ALPHA_PROVIDER_QUICKSTART.md, docs/REMOTE_SP_JOIN_QUICKSTART.md, and docs/networking/PROVIDER_ENDPOINTS.md.

Tasks:
1. Check the local machine and repo prerequisites.
2. Create or import the provider key.
3. Configure endpoint and local listener values.
4. Register the provider on-chain.
5. Start the provider and persist it under a service manager if appropriate.
6. Verify local /health, public https reachability, and LCD provider visibility.
7. Loop on failures until the provider is healthy.

Final output:
- provider address
- registered endpoint
- local and public health URLs
- service status
- files changed`;

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
              <Link
                to="/alpha/status"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                View Testnet Status
              </Link>
            </>
          }
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          <TrackCard
            icon={<Shield className="h-6 w-6 text-accent" />}
            title="Agent First"
            description="The intended testnet operator flow assumes the provider has access to Codex or Claude Code locally and can let the agent configure and verify the machine."
          />
          <TrackCard
            icon={<Globe className="h-6 w-6 text-primary" />}
            title="Home Server Friendly"
            description="The recommended provider path is home server plus Cloudflare Tunnel, with a public HTTPS endpoint registered on-chain."
          />
          <TrackCard
            icon={<Server className="h-6 w-6 text-primary" />}
            title="Ops Visibility"
            description="Provider onboarding, status, and public endpoint visibility will be consolidated under the testnet provider path rather than hidden in generic devnet docs."
          />
        </div>

        <section className="mt-12 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="glass-panel industrial-border p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
              /alpha/provider/recommended
            </div>
            <h2 className="mt-3 text-2xl font-bold text-foreground">Recommended testnet path</h2>
            <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Use a dedicated provider machine. Preferred order:
                <span className="ml-2 font-mono text-foreground">home server + Cloudflare Tunnel</span>,
                then <span className="ml-2 font-mono text-foreground">public VPS / direct ingress</span>.
              </p>
              <p>
                The operator should clone the repo locally and let Codex or Claude Code drive setup, verification, and repair loops.
              </p>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <TrackCard
                icon={<Globe className="h-6 w-6 text-accent" />}
                title="Home Server + Tunnel"
                description="Best fit for friends-and-family testnet. No public inbound port required; publish the provider over Cloudflare Tunnel HTTPS."
              />
              <TrackCard
                icon={<Server className="h-6 w-6 text-primary" />}
                title="Public Host"
                description="Use this when the provider already has a public hostname and ingress path. It is simpler but less home-server friendly."
              />
            </div>
          </div>

          <div className="glass-panel industrial-border p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
              /alpha/provider/cta
            </div>
            <h2 className="mt-3 text-2xl font-bold text-foreground">Next actions</h2>
            <div className="mt-5 space-y-3">
              <PrimaryCtaLink to="/sp-onboarding" size="md" fullWidth leftIcon={<Terminal className="h-4 w-4" />} withArrow={false}>
                Open Remote-First Onboarding
              </PrimaryCtaLink>
              <Link
                to="/alpha/status"
                className="inline-flex w-full items-center justify-center gap-2 rounded-none border border-border bg-card px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                <Globe className="h-4 w-4" />
                Check Network Status
              </Link>
            </div>

            <div className="mt-6 rounded-none border border-border bg-background/60 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Copy className="h-4 w-4 text-primary" />
                Agent-first
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                The onboarding page now includes a copyable agent bootstrap brief. A later PR in this stack will upgrade that to generated Codex and Claude Code prompts plus downloadable onboarding bundles.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-12 grid gap-6 lg:grid-cols-2">
          <PromptPanel
            badge="/alpha/provider/codex"
            title="Codex prompt"
            description="Clone the repo on the provider host, open Codex locally, paste this prompt, then let the agent run the full provider setup and verification loop."
            prompt={providerCodexPrompt}
            copyLabel="Copy Codex Prompt"
            links={[
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/ALPHA_PROVIDER_QUICKSTART.md", label: "Testnet provider quickstart" },
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/onboarding-prompts/provider_codex.md", label: "Prompt in repo" },
            ]}
          />
          <PromptPanel
            badge="/alpha/provider/claude"
            title="Claude Code prompt"
            description="This is the same operator flow phrased for Claude Code. The repo-local docs stay the source of truth, and the prompt tells the agent exactly where to look."
            prompt={providerClaudePrompt}
            copyLabel="Copy Claude Prompt"
            links={[
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/REMOTE_SP_JOIN_QUICKSTART.md", label: "Remote SP quickstart" },
              { href: "https://github.com/Nil-Store/nil-store/blob/main/docs/onboarding-prompts/provider_claude_code.md", label: "Prompt in repo" },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
