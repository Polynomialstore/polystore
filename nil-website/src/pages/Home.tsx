import { ArrowRight, Database, Shield, Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

export const Home = () => {
  return (
    <div className="pt-8 pb-12 px-4">
      <div className="container mx-auto max-w-6xl">
        
        {/* Hero Section */}
        <div className="text-center mb-24">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8 }}
            className="mx-auto w-64 h-64 mb-8 relative"
          >
             <img 
               src="/brand/logo-light-256.png"
               srcSet="/brand/logo-light-256.png 1x, /brand/logo-light-512.png 2x"
               alt="NilStore Logo" 
               className="absolute inset-0 w-full h-full object-contain dark:hidden"
             />
             <img 
               src="/brand/logo-dark-256.png"
               srcSet="/brand/logo-dark-256.png 1x, /brand/logo-dark-512.png 2x"
               alt="NilStore Logo" 
               className="absolute inset-0 w-full h-full object-contain hidden dark:block"
             />
          </motion.div>

                              <motion.h1 // This is the "NilStore" text

                                initial={{ opacity: 0, y: 20 }}

                                animate={{ opacity: 1, y: 0 }}

                                transition={{ duration: 0.8, delay: 0.2 }}

                                className="group text-6xl md:text-8xl font-extrabold tracking-tight mb-6"

                              >

            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600 drop-shadow-lg">
              NilStore
            </span>
          </motion.h1>

                    
                                          <motion.h2 // This is "Storage, Unsealed."
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.8 }}
                      className="text-5xl md:text-6xl font-bold mb-6 tracking-tight text-foreground"
                    >
                      Storage, <br/>
                      <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600">
                        Unsealed.
                      </span>
                    </motion.h2>          
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.8 }}
            className="text-xl md:text-2xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            <p className="text-xl md:text-2xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
              <strong className="text-purple-600 dark:text-purple-400">NilStore</strong> is a <strong className="text-purple-600 dark:text-purple-400">Decentralized</strong>, <strong className="text-purple-600 dark:text-purple-400">Autonomous</strong> and <strong className="text-purple-600 dark:text-purple-400">Self-Governing</strong><br/><strong className="text-purple-600 dark:text-purple-400">Storage</strong> and <strong className="text-purple-600 dark:text-purple-400">Distribution Network</strong>.
            </p>
          </motion.p>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="flex flex-col md:flex-row justify-center gap-4"
          >
            <Link to="/testnet" className="px-8 py-4 bg-primary text-primary-foreground rounded-full font-bold text-lg hover:opacity-90 transition-all flex items-center justify-center gap-2">
              Join "Store Wars" Testnet <ArrowRight className="w-5 h-5" />
            </Link>
            <div className="flex flex-col md:flex-row gap-4">
              <Link to="/whitepaper" className="px-8 py-4 bg-secondary text-secondary-foreground rounded-full font-bold text-lg hover:bg-secondary/80 transition-all">
                Read Whitepaper
              </Link>
              <Link to="/litepaper" className="px-8 py-4 bg-secondary text-secondary-foreground rounded-full font-bold text-lg hover:bg-secondary/80 transition-all">
                Read Litepaper
              </Link>
            </div>
          </motion.div>
        </div>

        {/* Feature Grid */}
        <div className="grid md:grid-cols-3 gap-8 mb-24">
          <FeatureCard 
            icon={<Shield className="w-8 h-8 text-green-400" />}
            title="Unified Liveness"
            desc="Zero Wasted Work. User retrievals *are* the storage proofs. Triple Proof verification guarantees integrity for every byte. High traffic = High security."
          />
          <FeatureCard 
            icon={<Activity className="w-8 h-8 text-blue-400" />}
            title="The Performance Market"
            desc="Tiered Rewards (example windows). Responses in Block H+1 earn Platinum rewards. Slow adapters earn dust. Speed is incentivized, not just enforced."
          />
          <FeatureCard 
            icon={<Database className="w-8 h-8 text-purple-400" />}
            title="Elasticity & Privacy"
            desc="Stripe-Aligned Scaling. Viral content spawns 'Hot Replicas' automatically. Self-Healing (Mode 2) ensures durability even if nodes fail. Zero-Knowledge encryption."
          />
        </div>

      </div>
    </div>
  );
};

interface FeatureCardProps {
  icon: React.ReactNode
  title: string
  desc: string
}

const FeatureCard = ({ icon, title, desc }: FeatureCardProps) => (
  <motion.div
    whileHover={{ y: -5 }}
    className="p-8 rounded-2xl bg-card border border-border hover:border-primary/50 transition-all shadow-sm"
  >
    <div className="mb-4 bg-secondary/50 w-14 h-14 rounded-xl flex items-center justify-center">
      {icon}
    </div>
    <h3 className="text-xl font-bold mb-3 text-card-foreground">{title}</h3>
    <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
      {desc}
    </p>
  </motion.div>
);
