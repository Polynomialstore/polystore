import { motion } from "framer-motion";
import { Trophy, Zap, HardDrive, Cloud, Server } from "lucide-react";
import { useState, useEffect } from "react";

export const PerformanceDeepDive = () => {
  const [racing, setRacing] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setRacing(true);
      setTimeout(() => setRacing(false), 4000); // Race duration + pause
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="w-full">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-16"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-primary/10 rounded-none border border-primary/20 shrink-0">
            <Trophy className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">The Performance Market</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-12">
          NilStore moves beyond binary "Pass/Fail" checks. We use a tiered reward system based on response latency. Speed is revenue. This aligns incentives: users get fast data, and providers are paid to invest in high-performance NVMe hardware.
        </p>

        {/* Visualization: The Latency Racer */}
        <section className="bg-card border border-border p-8 rounded-none shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-10">
             <Zap className="w-64 h-64" />
          </div>
          
          <div className="flex justify-between items-center mb-8">
              <h3 className="text-xl font-bold flex items-center gap-2 text-foreground">
                <Zap className="w-5 h-5 text-primary" /> Latency Race Simulation
              </h3>
              <div className="text-xs font-mono-data text-muted-foreground uppercase tracking-[0.2em]">
                  Status: {racing ? "CHALLENGE ACTIVE" : "IDLE"}
              </div>
          </div>
          
          <div className="space-y-10 relative">
            {/* Start Line */}
            <div className="absolute left-0 top-0 bottom-0 w-px bg-border/40 z-10" />
            {/* Finish Line (example: Block H+1) */}
            <div className="absolute left-[30%] top-0 bottom-0 w-px bg-accent/30 z-0">
                <div className="absolute -top-6 left-0 text-[10px] text-accent whitespace-nowrap">Platinum (example: H+1)</div>
            </div>
            {/* Finish Line (example: Block H+5) */}
            <div className="absolute left-[60%] top-0 bottom-0 w-px bg-primary/30 z-0">
                <div className="absolute -top-6 left-0 text-[10px] text-primary whitespace-nowrap">Gold (example: H+5)</div>
            </div>
             {/* Finish Line (example: Block H+20) */}
             <div className="absolute right-0 top-0 bottom-0 w-px bg-destructive/30 z-0">
                <div className="absolute -top-6 right-0 text-[10px] text-destructive whitespace-nowrap">Cutoff (example: H+20)</div>
            </div>

            {/* Lane 1: Platinum */}
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-2 text-sm">
                <Server className="w-4 h-4 text-accent" />
                <span className="font-bold text-foreground">Local NVMe Node</span>
                <span className="text-xs text-muted-foreground ml-auto font-mono-data text-accent uppercase tracking-[0.2em]">Reward: 1.0x</span>
              </div>
              <div className="w-full bg-secondary/30 h-10 rounded-none relative flex items-center px-2">
                <motion.div 
                  initial={{ x: 0 }}
                  animate={{ x: racing ? "30%" : 0 }}
                  transition={{ duration: 1, ease: "easeOut" }}
                  className="absolute w-8 h-8 bg-accent shadow-[0_0_15px_hsl(var(--accent)_/_0.35)] flex items-center justify-center"
                >
                    <Zap className="w-4 h-4 text-accent-foreground fill-current" />
                </motion.div>
              </div>
            </div>

            {/* Lane 2: Gold */}
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-2 text-sm">
                <HardDrive className="w-4 h-4 text-primary" />
                <span className="font-bold text-foreground">Standard HDD Node</span>
                <span className="text-xs text-muted-foreground ml-auto font-mono-data text-primary uppercase tracking-[0.2em]">Reward: 0.8x</span>
              </div>
              <div className="w-full bg-secondary/30 h-10 rounded-none relative flex items-center px-2">
                <motion.div 
                  initial={{ x: 0 }}
                  animate={{ x: racing ? "60%" : 0 }}
                  transition={{ duration: 2.5, ease: "easeOut" }}
                  className="absolute w-8 h-8 bg-primary shadow-[0_0_15px_hsl(var(--primary)_/_0.35)] flex items-center justify-center"
                >
                    <Zap className="w-4 h-4 text-primary-foreground fill-current" />
                </motion.div>
              </div>
            </div>

            {/* Lane 3: Fail */}
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-2 text-sm">
                <Cloud className="w-4 h-4 text-destructive" />
                <span className="font-bold text-foreground">S3 Wrapper / Cold</span>
                <span className="text-xs text-muted-foreground ml-auto font-mono-data text-destructive uppercase tracking-[0.2em]">Reward: 0.0x</span>
              </div>
              <div className="w-full bg-secondary/30 h-10 rounded-none relative flex items-center px-2">
                <motion.div 
                  initial={{ x: 0 }}
                  animate={{ x: racing ? "95%" : 0 }}
                  transition={{ duration: 4, ease: "linear" }}
                  className="absolute w-8 h-8 bg-destructive shadow-[0_0_15px_hsl(var(--destructive)_/_0.35)] flex items-center justify-center"
                >
                    <Zap className="w-4 h-4 text-destructive-foreground fill-current" />
                </motion.div>
              </div>
            </div>
          </div>

          <div className="mt-12 p-4 bg-primary/5 border border-primary/20 rounded-none text-sm text-muted-foreground">
            <p>
              <strong>Market Logic:</strong> Slow providers aren't banned; they just earn less. The market rewards low-latency service without brittle slashing rules, and real-time demand naturally pressures providers to keep hot data local.
            </p>
          </div>
        </section>

        {/* Section 2: Fair Exchange */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Trophy className="w-5 h-5 text-primary" /> Fair Exchange: Retrieval Sessions
          </h3>
          <p className="text-muted-foreground mb-6">
            Speed is worthless if the user refuses to pay. NilStore uses <strong>retrieval sessions</strong>: users open a
            session on-chain, lock a base fee plus a per-blob budget, and only release payment when the session is confirmed.
          </p>
          <div className="bg-card border border-border p-6 rounded-none shadow-sm grid md:grid-cols-3 gap-4 text-center">
            <div className="p-4 bg-secondary/20 rounded-none">
                <div className="text-lg font-bold text-foreground mb-1">Step 1</div>
                <div className="text-sm text-muted-foreground">
                  User opens a session and locks the <strong>base fee</strong> + <strong>per-blob budget</strong>.
                </div>
            </div>
            <div className="p-4 bg-secondary/20 rounded-none">
                <div className="text-lg font-bold text-foreground mb-1">Step 2</div>
                <div className="text-sm text-muted-foreground">
                  Provider serves data with the session ID and proves the blobs served.
                </div>
            </div>
            <div className="p-4 bg-secondary/20 rounded-none">
                <div className="text-lg font-bold text-foreground mb-1">Step 3</div>
                <div className="text-sm text-muted-foreground">
                  User confirms the session to release payment; unused budget can be refunded on expiry.
                </div>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-4 italic text-center">
            This keeps provider risk bounded while keeping payment confirmation explicit and on-chain.
          </p>
        </section>
      </motion.div>
    </div>
  );
};
