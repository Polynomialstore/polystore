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
          <div className="p-3 bg-yellow-500/10 rounded-xl border border-yellow-500/20 shrink-0">
            <Trophy className="w-8 h-8 text-yellow-500" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">The Performance Market</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-12">
          NilStore moves beyond binary "Pass/Fail" checks. We use a tiered reward system based on response latency. Speed is revenue. This aligns incentives: users get fast data, and providers are paid to invest in high-performance NVMe hardware.
        </p>

        {/* Visualization: The Latency Racer */}
        <section className="bg-card border border-border p-8 rounded-2xl shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-10">
             <Zap className="w-64 h-64" />
          </div>
          
          <div className="flex justify-between items-center mb-8">
              <h3 className="text-xl font-bold flex items-center gap-2 text-foreground">
                <Zap className="w-5 h-5 text-yellow-500" /> Latency Race Simulation
              </h3>
              <div className="text-xs font-mono text-muted-foreground">
                  Status: {racing ? "CHALLENGE ACTIVE" : "IDLE"}
              </div>
          </div>
          
          <div className="space-y-10 relative">
            {/* Start Line */}
            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-dashed border-l border-white/20 z-10"></div>
            {/* Finish Line (example: Block H+1) */}
            <div className="absolute left-[30%] top-0 bottom-0 w-px bg-cyan-500/30 z-0">
                <div className="absolute -top-6 left-0 text-[10px] text-cyan-500 whitespace-nowrap">Platinum (example: H+1)</div>
            </div>
            {/* Finish Line (example: Block H+5) */}
            <div className="absolute left-[60%] top-0 bottom-0 w-px bg-yellow-500/30 z-0">
                <div className="absolute -top-6 left-0 text-[10px] text-yellow-500 whitespace-nowrap">Gold (example: H+5)</div>
            </div>
             {/* Finish Line (example: Block H+20) */}
             <div className="absolute right-0 top-0 bottom-0 w-px bg-red-500/30 z-0">
                <div className="absolute -top-6 right-0 text-[10px] text-red-500 whitespace-nowrap">Cutoff (example: H+20)</div>
            </div>

            {/* Lane 1: Platinum */}
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-2 text-sm">
                <Server className="w-4 h-4 text-cyan-400" />
                <span className="font-bold text-foreground">Local NVMe Node</span>
                <span className="text-xs text-muted-foreground ml-auto font-mono text-cyan-400">Reward: 1.0 NIL</span>
              </div>
              <div className="w-full bg-secondary/30 h-10 rounded-r-full relative flex items-center px-2">
                <motion.div 
                  initial={{ x: 0 }}
                  animate={{ x: racing ? "30%" : 0 }}
                  transition={{ duration: 1, ease: "easeOut" }}
                  className="absolute w-8 h-8 bg-cyan-500 rounded shadow-[0_0_15px_rgba(6,182,212,0.5)] flex items-center justify-center"
                >
                    <Zap className="w-4 h-4 text-black fill-current" />
                </motion.div>
              </div>
            </div>

            {/* Lane 2: Gold */}
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-2 text-sm">
                <HardDrive className="w-4 h-4 text-yellow-400" />
                <span className="font-bold text-foreground">Standard HDD Node</span>
                <span className="text-xs text-muted-foreground ml-auto font-mono text-yellow-400">Reward: 0.8 NIL</span>
              </div>
              <div className="w-full bg-secondary/30 h-10 rounded-r-full relative flex items-center px-2">
                <motion.div 
                  initial={{ x: 0 }}
                  animate={{ x: racing ? "60%" : 0 }}
                  transition={{ duration: 2.5, ease: "easeOut" }}
                  className="absolute w-8 h-8 bg-yellow-500 rounded shadow-[0_0_15px_rgba(234,179,8,0.5)] flex items-center justify-center"
                >
                    <Zap className="w-4 h-4 text-black fill-current" />
                </motion.div>
              </div>
            </div>

            {/* Lane 3: Fail */}
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-2 text-sm">
                <Cloud className="w-4 h-4 text-red-500" />
                <span className="font-bold text-foreground">S3 Wrapper / Cold</span>
                <span className="text-xs text-muted-foreground ml-auto font-mono text-red-500">Reward: 0.0 NIL</span>
              </div>
              <div className="w-full bg-secondary/30 h-10 rounded-r-full relative flex items-center px-2">
                <motion.div 
                  initial={{ x: 0 }}
                  animate={{ x: racing ? "95%" : 0 }}
                  transition={{ duration: 4, ease: "linear" }}
                  className="absolute w-8 h-8 bg-red-500 rounded shadow-[0_0_15px_rgba(239,68,68,0.5)] flex items-center justify-center"
                >
                    <Zap className="w-4 h-4 text-white fill-current" />
                </motion.div>
              </div>
            </div>
          </div>

          <div className="mt-12 p-4 bg-primary/5 border border-primary/20 rounded-lg text-sm text-muted-foreground">
            <p>
              <strong>Market Logic:</strong> Slow providers aren't banned; they just earn less. This implicitly filters out "Lazy Providers" (S3 wrappers) because the bandwidth costs of fetching data remotely destroy their margins when combined with lower Gold/Silver tier rewards.
            </p>
          </div>
        </section>

        {/* Section 2: Fair Exchange */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Trophy className="w-5 h-5 text-purple-500" /> Fair Exchange: Incremental Signing
          </h3>
          <p className="text-muted-foreground mb-6">
            Speed is worthless if the user refuses to pay. To prevent "Free Riders" (users who download data but don't sign the receipt), NilStore uses an <strong>Incremental Signing Protocol</strong> (Tit-for-Tat).
          </p>
          <div className="bg-card border border-border p-6 rounded-xl shadow-sm grid md:grid-cols-3 gap-4 text-center">
            <div className="p-4 bg-secondary/20 rounded-lg">
                <div className="text-lg font-bold text-foreground mb-1">Step 1</div>
                <div className="text-sm text-muted-foreground">Provider sends <strong>Chunk 1</strong> (e.g. 10MB).</div>
            </div>
            <div className="p-4 bg-secondary/20 rounded-lg">
                <div className="text-lg font-bold text-foreground mb-1">Step 2</div>
                <div className="text-sm text-muted-foreground">User verifies & <strong>Signs Receipt</strong>.</div>
            </div>
            <div className="p-4 bg-secondary/20 rounded-lg">
                <div className="text-lg font-bold text-foreground mb-1">Step 3</div>
                <div className="text-sm text-muted-foreground">Provider unlocks <strong>Chunk 2</strong>.</div>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-4 italic text-center">
            This reduces the "At-Risk" capital to near zero. Trust is established byte-by-byte.
          </p>
        </section>
      </motion.div>
    </div>
  );
};
