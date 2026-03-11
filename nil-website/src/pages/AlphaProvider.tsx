import { Link } from "react-router-dom";
import { ArrowRight, Server, Shield, Globe } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { TrackCard } from "../components/marketing/TrackCard";

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
          title={<h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Run A Provider On Alpha</h1>}
          description="This is the operator path for the alpha testnet. The recommended target is a remote provider host, ideally a home server behind Cloudflare Tunnel or a publicly reachable VPS."
          actions={
            <>
              <Link
                to="/sp-onboarding"
                className="inline-flex items-center justify-center gap-3 rounded-none border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Provider Onboarding
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/devnet"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                View Provider Join Info
              </Link>
            </>
          }
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          <TrackCard
            icon={<Shield className="h-6 w-6 text-accent" />}
            title="Agent First"
            description="The intended alpha operator flow assumes the provider has access to Codex or Claude Code locally and can let the agent configure and verify the machine."
          />
          <TrackCard
            icon={<Globe className="h-6 w-6 text-primary" />}
            title="Home Server Friendly"
            description="The recommended provider path is home server plus Cloudflare Tunnel, with a public HTTPS endpoint registered on-chain."
          />
          <TrackCard
            icon={<Server className="h-6 w-6 text-primary" />}
            title="Ops Visibility"
            description="Provider onboarding, status, and public endpoint visibility will be consolidated under the alpha provider path rather than hidden in generic devnet docs."
          />
        </div>
      </div>
    </div>
  );
}
