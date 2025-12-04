import { ArrowRight, Database, Shield, Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

export const Home = () => {
  return (
    <div className="pt-24 pb-12 px-4">
      <div className="container mx-auto max-w-6xl">
        
        {/* Hero Section */}
        <div className="text-center mb-24">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8 }}
            className="mx-auto w-64 h-64 mb-4 relative"
          >
             <img 
               src="/logo_dark.jpg" 
               alt="NilStore Logo" 
               className="absolute inset-0 w-full h-full object-contain dark:hidden mix-blend-multiply"
             />
             <img 
               src="/logo_light.jpg" 
               alt="NilStore Logo" 
               className="absolute inset-0 w-full h-full object-contain hidden dark:block mix-blend-screen"
             />
          </motion.div>

          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-5xl md:text-6xl font-extrabold tracking-widest uppercase mb-6"
            style={{
              fontFamily: "'Montserrat', sans-serif",
              backgroundImage: "linear-gradient(90deg, #00E5FF 0%, #E056FD 50%, #7B2CBF 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 0 8px rgba(0, 229, 255, 0.3))"
            }}
          >
            NilStore
          </motion.h2>

          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="text-6xl md:text-8xl font-bold mb-6 tracking-tight text-foreground"
          >
            Storage, <br/>
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600">
              Unsealed.
            </span>
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.8 }}
            className="text-xl md:text-2xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            The first decentralized storage network powered by <strong>Proof-of-Useful-Data</strong>. 
            No massive hardware. No sealing delay. Just instant, verifiable cloud storage.
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
            title="Verifiable Security"
            desc="Every byte is protected by KZG Commitments. Mathematical proof of existence, instantly verified on-chain."
          />
          <FeatureCard 
            icon={<Activity className="w-8 h-8 text-purple-400" />}
            title="High Performance"
            desc="Proof-of-Delayed-Encode (PoDE) replaces slow sealing with fast timing checks. Data is ready to serve in milliseconds."
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
    <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
      {desc}
    </p>
  </motion.div>
);
