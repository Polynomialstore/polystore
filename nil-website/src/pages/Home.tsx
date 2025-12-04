import { ArrowRight, Code, Database, Shield, Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

export const Home = () => {
  return (
    <div className="pt-24 pb-12 px-4">
      <div className="container mx-auto max-w-6xl">
        
        {/* Hero Section */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="text-center mb-24 relative"
        >
          {/* Geometric Background (Ricci Flow Concept) */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-full blur-3xl -z-10 animate-pulse"></div>

          <h1 className="text-6xl md:text-8xl font-bold mb-6 tracking-tight text-foreground">
            The Self-Healing <br/>
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600">
              Nilmanifold
            </span>
          </h1>
          
          <p className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto mb-10 leading-relaxed">
            A decentralized storage network built on <strong>Homogeneity</strong>. 
            Just as a Nilmanifold allows continuous transformation between points, 
            NilStore enables fluid data movement and automatic repair across a topological lattice.
          </p>

          <div className="flex flex-col md:flex-row justify-center gap-4">
            <Link to="/testnet" className="px-8 py-4 bg-primary text-primary-foreground rounded-full font-bold text-lg hover:opacity-90 transition-all flex items-center justify-center gap-2">
              Join "Store Wars" Testnet <ArrowRight className="w-5 h-5" />
            </Link>
            <Link to="/technology" className="px-8 py-4 bg-secondary text-secondary-foreground rounded-full font-bold text-lg hover:bg-secondary/80 transition-all">
              Read the Whitepaper
            </Link>
          </div>
        </motion.div>

        {/* Feature Grid */}
        <div className="grid md:grid-cols-3 gap-8 mb-24">
          <FeatureCard 
            icon={<Shield className="w-8 h-8 text-green-400" />}
            title="Sealing-Free Consensus"
            desc="Proof-of-Useful-Data (PoUD) replaces wasteful sealing with real-time KZG verification, enabling instant data availability."
          />
          <FeatureCard 
            icon={<Activity className="w-8 h-8 text-blue-400" />}
            title="Ricci Flow Routing"
            desc="Network traffic flows like heat along the curvature of the manifold, automatically balancing load and healing failures."
          />
          <FeatureCard 
            icon={<Database className="w-8 h-8 text-purple-400" />}
            title="Web2 Compatible"
            desc="Native S3 Adapter allows existing applications to seamlessly transition to decentralized storage without code changes."
          />
        </div>

      </div>
    </div>
  );
};

const FeatureCard = ({ icon, title, desc }: any) => (
  <motion.div 
    whileHover={{ y: -5 }}
    className="p-8 rounded-2xl bg-card border border-border hover:border-primary/50 transition-all shadow-sm"
  >
    <div className="mb-4 bg-secondary/50 w-14 h-14 rounded-xl flex items-center justify-center">
      {icon}
    </div>
    <h3 className="text-xl font-bold mb-3 text-card-foreground">{title}</h3>
    <p className="text-muted-foreground leading-relaxed">
      {desc}
    </p>
  </motion.div>
);
