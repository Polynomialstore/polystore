import { Link } from "react-router-dom";
import { ArrowRight, Database, Terminal, Wallet } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { TrackCard } from "../components/marketing/TrackCard";

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
          title={<h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Store Data On Alpha</h1>}
          description="This is the storage-user path for the alpha testnet. Start in the browser, connect a wallet, fund your account, and complete your first store and retrieve flow."
          actions={
            <>
              <Link
                to="/first-file"
                className="inline-flex items-center justify-center gap-3 rounded-none border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Start First File
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/dashboard"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                Open Dashboard
              </Link>
            </>
          }
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          <TrackCard
            icon={<Wallet className="h-6 w-6 text-accent" />}
            title="Wallet First"
            description="Connect MetaMask, switch to the NilStore alpha network, and fund your address before creating a deal."
          />
          <TrackCard
            icon={<Database className="h-6 w-6 text-primary" />}
            title="Browser Path"
            description="The alpha storage path is browser-first. You should be able to create a deal, upload a file, and retrieve it without running a server."
          />
          <TrackCard
            icon={<Terminal className="h-6 w-6 text-primary" />}
            title="Power User Mode"
            description="A Codex and Claude Code assisted local path will follow in the next PRs for users who want a local gateway and repo-driven setup."
          />
        </div>
      </div>
    </div>
  );
}
