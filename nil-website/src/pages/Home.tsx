import { ArrowRight, Database, Shield, Activity } from "lucide-react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"

export const Home = () => {
  return (
    <div className="pt-24 pb-12 px-4">
      <div className="container mx-auto max-w-6xl">
        {/* Hero */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="relative overflow-hidden glass-panel industrial-border p-10 md:p-14 text-center shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]"
        >
          <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
          <div className="absolute inset-0 opacity-10 pointer-events-none animate-scan" />

          <div className="relative mx-auto mb-6 h-28 w-28 glass-panel industrial-border p-3 dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.18)]">
            <img
              src="/brand/logo-light-256.png"
              srcSet="/brand/logo-light-256.png 1x, /brand/logo-light-512.png 2x"
              alt="NilStore Logo (Light)"
              className="absolute inset-0 h-full w-full object-contain opacity-100 dark:opacity-0 transition-opacity"
            />
            <img
              src="/brand/logo-dark-256.png"
              srcSet="/brand/logo-dark-256.png 1x, /brand/logo-dark-512.png 2x"
              alt="NilStore Logo (Dark)"
              className="absolute inset-0 h-full w-full object-contain opacity-0 dark:opacity-100 transition-opacity"
            />
          </div>

          <div className="relative mx-auto inline-flex items-center border border-border/50 bg-background/40 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
            /nilstore/overview
          </div>

          <h1 className="relative mt-5 text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight">
            <span className="text-foreground">NIL</span>
            <span className="text-primary">STORE</span>
          </h1>

          <p className="relative mt-5 text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            NilStore is a decentralized, autonomous, self-governing storage and distribution network built for verifiable retrieval at protocol speed.
          </p>

          <div className="relative mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/testnet"
              className="inline-flex items-center justify-center gap-3 bg-primary text-primary-foreground px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.22)] hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] transition-all"
            >
              Join Store Wars
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/whitepaper"
              className="inline-flex items-center justify-center border border-border/60 bg-background/50 px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-muted/40 transition-colors"
            >
              Read Whitepaper
            </Link>
            <Link
              to="/litepaper"
              className="inline-flex items-center justify-center border border-border/60 bg-background/50 px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-muted/40 transition-colors"
            >
              Read Litepaper
            </Link>
          </div>
        </motion.section>

        {/* Feature Grid */}
        <div className="mt-12 grid md:grid-cols-3 gap-6">
          <FeatureCard
            icon={<Shield className="w-6 h-6 text-accent" />}
            title="Unified Liveness"
            desc="User retrievals are proofs. Every byte is bound to the deal root through the Triple Proof chain."
          />
          <FeatureCard
            icon={<Activity className="w-6 h-6 text-primary" />}
            title="Performance Market"
            desc="Tiered rewards incentivize low-latency service without brittle hard deadlines."
          />
          <FeatureCard
            icon={<Database className="w-6 h-6 text-primary" />}
            title="Elasticity & Privacy"
            desc="StripeReplica scaling, self-healing erasure coding, and end-to-end encryption without sacrificing verification."
          />
        </div>
      </div>
    </div>
  )
}

interface FeatureCardProps {
  icon: React.ReactNode
  title: string
  desc: string
}

const FeatureCard = ({ icon, title, desc }: FeatureCardProps) => (
  <motion.div
    whileHover={{ y: -5 }}
    className="relative overflow-hidden glass-panel industrial-border p-8 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.05)] hover:ring-1 hover:ring-primary/20"
  >
    <div className="absolute inset-0 cyber-grid opacity-20 pointer-events-none" />
    <div className="relative mb-4 glass-panel industrial-border w-14 h-14 flex items-center justify-center">
      {icon}
    </div>
    <h3 className="relative text-xl font-bold mb-3 text-card-foreground">{title}</h3>
    <p className="relative text-muted-foreground leading-relaxed">
      {desc}
    </p>
  </motion.div>
)
