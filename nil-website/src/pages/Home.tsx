import { ArrowRight, Database, Shield, Activity, Server } from "lucide-react"
import { Link } from "react-router-dom"
import { AlphaHero } from "../components/marketing/AlphaHero"
import { TrackCard } from "../components/marketing/TrackCard"

export const Home = () => {
  return (
    <div className="pt-24 pb-12 px-4">
      <div className="container mx-auto max-w-6xl">
        <AlphaHero
          badge="/nilstore/overview"
          logo={
            <>
              <img
                src="/brand/logo-light-256.png"
                srcSet="/brand/logo-light-256.png 1x, /brand/logo-light-512.png 2x"
                alt="NilStore Logo (Light)"
                className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity dark:opacity-0"
              />
              <img
                src="/brand/logo-dark-256.png"
                srcSet="/brand/logo-dark-256.png 1x, /brand/logo-dark-512.png 2x"
                alt="NilStore Logo (Dark)"
                className="absolute inset-0 h-full w-full object-contain opacity-0 transition-opacity dark:opacity-100"
              />
            </>
          }
          title={
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl md:text-7xl">
              <span className="text-foreground">NIL</span>
              <span className="text-primary">STORE</span>
            </h1>
          }
          description="NilStore alpha has two primary user paths: people who want to store data, and operators who want to run storage providers. Start from the path that matches your job."
          actions={
            <>
              <Link
                to="/alpha/storage"
                className="inline-flex items-center justify-center gap-3 rounded-none border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Store Data
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/alpha/provider"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                Run A Provider
              </Link>
              <Link
                to="/alpha/status"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                Alpha Status
              </Link>
            </>
          }
        />

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <TrackCard
            icon={<Database className="w-6 h-6 text-accent" />}
            title="Store Data"
            description="Connect a wallet, fund your account, create a deal, upload a file, and retrieve it back. This is the browser-first alpha path."
          />
          <TrackCard
            icon={<Server className="w-6 h-6 text-primary" />}
            title="Run A Provider"
            description="Set up a provider host, expose a public endpoint, register on-chain, and verify health. This path is being optimized for local coding agents."
          />
        </div>

        <div className="mt-12 grid md:grid-cols-3 gap-6">
          <TrackCard
            icon={<Shield className="w-6 h-6 text-accent" />}
            title="Unified Liveness"
            description="User retrievals are proofs. Every byte is bound to the deal root through the Triple Proof chain."
          />
          <TrackCard
            icon={<Activity className="w-6 h-6 text-primary" />}
            title="Performance Market"
            description="Tiered rewards incentivize low-latency service without brittle hard deadlines."
          />
          <TrackCard
            icon={<Database className="w-6 h-6 text-primary" />}
            title="Elasticity & Privacy"
            description="StripeReplica scaling, self-healing erasure coding, and end-to-end encryption without sacrificing verification."
          />
        </div>
      </div>
    </div>
  )
}
