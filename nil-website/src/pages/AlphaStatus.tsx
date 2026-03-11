import { Link } from "react-router-dom";
import { Activity, ArrowRight, Server, Database } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { TrackCard } from "../components/marketing/TrackCard";

export function AlphaStatus() {
  return (
    <div className="px-4 pb-12 pt-24">
      <div className="container mx-auto max-w-6xl">
        <AlphaHero
          badge="/alpha/status"
          logo={
            <div className="flex h-full w-full items-center justify-center">
              <Activity className="h-14 w-14 text-primary" />
            </div>
          }
          title={<h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Alpha Network Status</h1>}
          description="This is the shared operational entry point for both storage users and provider operators. It will become the single place to verify chain, faucet, provider, and public endpoint health."
          actions={
            <>
              <Link
                to="/proofs"
                className="inline-flex items-center justify-center gap-3 rounded-none border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Open Live Proofs
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/sp-dashboard"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                Open SP Dashboard
              </Link>
            </>
          }
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          <TrackCard
            icon={<Database className="h-6 w-6 text-accent" />}
            title="Storage Signal"
            description="Storage users should be able to tell whether wallet funding, upload, and retrieval paths are healthy before debugging their own browser."
          />
          <TrackCard
            icon={<Server className="h-6 w-6 text-primary" />}
            title="Provider Signal"
            description="Provider operators should be able to tell whether the chain, registration, and public endpoints are healthy before debugging their host."
          />
          <TrackCard
            icon={<Activity className="h-6 w-6 text-primary" />}
            title="Single Truth"
            description="This page is a placeholder for the consolidated alpha status surface that later PRs will wire into live network checks."
          />
        </div>
      </div>
    </div>
  );
}
