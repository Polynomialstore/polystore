import { motion } from "framer-motion";
import { Trophy, Clock, Zap } from "lucide-react";

export const PerformanceDeepDive = () => {
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
        <section className="bg-card border border-border p-8 rounded-2xl shadow-sm">
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2 text-foreground">
            <Zap className="w-5 h-5 text-yellow-500" /> Latency Tiers (Block Height)
          </h3>
          
          <div className="space-y-8">
            {/* Lane 1: Platinum */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="font-bold text-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cyan-400"></span> Local NVMe Node
                </span>
                <span className="font-mono text-cyan-400">Block H+1 (100% Reward)</span>
              </div>
              <div className="w-full bg-secondary/50 h-8 rounded-full overflow-hidden relative">
                <motion.div 
                  initial={{ width: 0 }}
                  whileInView={{ width: "100%" }}
                  transition={{ duration: 1, ease: "easeOut" }}
                  className="h-full bg-cyan-500"
                />
              </div>
            </div>

            {/* Lane 2: Gold */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="font-bold text-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-yellow-400"></span> Standard HDD Node
                </span>
                <span className="font-mono text-yellow-400">Block H+5 (80% Reward)</span>
              </div>
              <div className="w-full bg-secondary/50 h-8 rounded-full overflow-hidden relative">
                <motion.div 
                  initial={{ width: 0 }}
                  whileInView={{ width: "60%" }}
                  transition={{ duration: 2, ease: "easeOut" }}
                  className="h-full bg-yellow-500"
                />
              </div>
            </div>

            {/* Lane 3: Fail */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="font-bold text-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500"></span> S3 / Cold Storage
                </span>
                <span className="font-mono text-red-500">Block H+20 (0% Reward)</span>
              </div>
              <div className="w-full bg-secondary/50 h-8 rounded-full overflow-hidden relative">
                <motion.div 
                  initial={{ width: 0 }}
                  whileInView={{ width: "20%" }}
                  transition={{ duration: 3, ease: "easeOut" }}
                  className="h-full bg-red-500"
                />
              </div>
            </div>
          </div>

          <div className="mt-8 p-4 bg-primary/5 border border-primary/20 rounded-lg text-sm text-muted-foreground">
            <p>
              <strong>Market Logic:</strong> Slow providers aren't banned; they just earn less. This implicitly filters out "Lazy Providers" (S3 wrappers) because the bandwidth costs of fetching data remotely destroy their margins when combined with lower Gold/Silver tier rewards.
            </p>
          </div>
        </section>
      </motion.div>
    </div>
  );
};
