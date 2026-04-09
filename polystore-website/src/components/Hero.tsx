import { ArrowRight, Database, ShieldCheck, Zap } from "lucide-react";
import { motion } from "framer-motion";

export const Hero = () => {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 lg:pt-48 lg:pb-32">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-5xl lg:text-7xl font-bold tracking-tight mb-8 bg-gradient-to-r from-primary to-foreground bg-clip-text text-transparent">
              The Future of Decentralized Storage
            </h1>
            <p className="text-xl text-muted-foreground mb-12 max-w-2xl mx-auto">
              PolyStore leverages <strong>KZG Commitments</strong> and a <strong>Performance Market</strong> (no sealing) to deliver verifiable, secure, and low-latency decentralized storage.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="flex flex-col sm:flex-row justify-center gap-4"
          >
            <button className="px-8 py-4 bg-primary text-primary-foreground border border-primary/40 font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity dark:drop-shadow-[0_0_8px_hsl(var(--primary)_/_0.30)]">
              Read the Whitepaper <ArrowRight className="w-4 h-4" />
            </button>
            <button className="px-8 py-4 bg-background/60 border border-border text-foreground font-medium hover:bg-secondary/40 transition-colors">
              View Benchmarks
            </button>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-24">
            <FeatureCard
              icon={<ShieldCheck className="w-8 h-8 text-accent" />}
              title="Cryptographically Secure"
              description="Data integrity guaranteed by KZG polynomial commitments and EIP-4844 standards."
              delay={0.3}
            />
            <FeatureCard
              icon={<Database className="w-8 h-8 text-primary" />}
              title="Unsealed + Incentivized"
              description="Providers earn by serving fast. Retrieval receipts and synthetic checks make performance observable without sealing latency."
              delay={0.4}
            />
            <FeatureCard
              icon={<Zap className="w-8 h-8 text-primary" />}
              title="Lightning Fast Verify"
              description="Verifying a proof is sub-millisecond on standard hardware."
              delay={0.5}
            />
          </div>
        </div>
      </div>
    </section>
  );
};

const FeatureCard = ({ icon, title, description, delay }: { icon: React.ReactNode, title: string, description: string, delay: number }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.5, delay }}
    className="p-6 glass-panel industrial-border cyber-grid shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_25px_hsl(var(--border)_/_0.25)] hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,0.08)] dark:hover:shadow-[0_0_35px_hsl(var(--primary)_/_0.10)] transition-shadow text-left"
  >
    <div className="mb-4 p-3 bg-background/40 border border-border w-fit">{icon}</div>
    <h3 className="text-xl font-semibold mb-2">{title}</h3>
    <p className="text-muted-foreground">{description}</p>
  </motion.div>
);
