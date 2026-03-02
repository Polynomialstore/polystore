import { motion } from "framer-motion";
import { Clock, ShieldAlert, Cpu, HeartCrack } from "lucide-react";

export const ArgonDeepDive = () => {
  const podeWorkMs = 1000; // Example: PoDE prototype tuned to ~1s
  const networkLatencyMs = 200; // Example: typical WAN latency
  const deadlineMs = podeWorkMs + 100; // Example: deadline margin after compute
  
  // Attacker needs to fetch + compute
  const attackerTotalMs = networkLatencyMs + podeWorkMs;
  const attackerSeconds = attackerTotalMs / 1000;
  
  // Honest node computes only
  const honestTotalMs = podeWorkMs; // Disk read is negligible in comparison
  const honestSeconds = honestTotalMs / 1000;

  return (
    <div className="w-full">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-16"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-destructive/10 rounded-xl border border-destructive/20 shrink-0">
            <HeartCrack className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">Archived: Proof-of-Delayed-Encode (PoDE)</h2>
        </div>

        <p className="text-xl text-muted-foreground mb-12 leading-relaxed">
          PoDE was an early timing-based anti-laziness mechanism. NilStore has since evolved to an <strong>unsealed</strong> design using the <strong>Performance Market</strong> and <strong>Unified Liveness</strong> (retrievals as proofs). This page is kept for historical context.
        </p>

        {/* Section 1: The Concept & Mechanism */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Cpu className="w-5 h-5 text-destructive" /> Memory-Hard Computation
          </h3>
          <p className="text-muted-foreground mb-6">
            In the PoDE model, when challenged, SPs perform a memory-hard computation (<strong>Argon2id</strong>) on a chunk of data. The work was tuned (example) to take about {podeWorkMs/1000} second on a reference CPU.
          </p>
          
          <div className="bg-card border border-border p-8 rounded-2xl shadow-sm flex flex-col items-center">
            <div className="grid grid-cols-8 gap-1 w-full max-w-md aspect-video bg-muted/30 p-2 rounded border border-border">
              {[...Array(64)].map((_, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0.1 }}
                  animate={{ opacity: [0.1, 1, 1] }}
                  transition={{ 
                    duration: 2, 
                    repeat: Infinity, 
                    delay: i * 0.03,
                    repeatDelay: 1
                  }}
                  className="bg-primary/70 rounded-sm w-full h-full"
                />
              ))}
            </div>
            <p className="mt-4 text-xs font-mono text-muted-foreground">Filling a large memory matrix... (15MB buffer)</p>
          </div>
        </section>

        {/* Section 2: The Security Guarantee (Timing Gap) */}
        <section className="mt-16">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Clock className="w-5 h-5 text-accent" /> The Timing Defense
          </h3>
          <p className="text-muted-foreground mb-6">
            PoDE relied on a strict submission deadline: if a node tried to fetch missing data from a remote source on demand, it would miss the deadline and be penalized. In practice, strict deadlines can be brittle, which is why NilStore now uses the Performance Market instead.
          </p>
          <div className="bg-card border border-border p-8 rounded-2xl shadow-sm">
            <div className="grid md:grid-cols-2 gap-8">
                <div>
                    <h4 className="font-bold text-foreground mb-2">Honest Node (Local Storage)</h4>
                    <p className="text-sm text-muted-foreground mb-4">Reads data instantly from local storage, performs computation, and submits proof.</p>
                    <div className="space-y-2">
                        <div className="flex justify-between text-sm text-foreground">
                            <span>Local Compute (Argon2id)</span>
                            <span className="font-bold text-accent">{honestSeconds.toFixed(2)}s</span>
                        </div>
                        <div className="w-full bg-secondary h-4 overflow-hidden border border-border/40">
                            <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: "100%" }}
                            transition={{ duration: 1 }}
                            className="h-full bg-accent"
                            />
                        </div>
                    </div>
                </div>
                <div>
                    <h4 className="font-bold text-foreground mb-2">Adversary (Remote Fetch)</h4>
                    <p className="text-sm text-muted-foreground mb-4">Must fetch data over network, then perform computation. Misses deadline.</p>
                    <div className="space-y-2">
                        <div className="flex justify-between text-sm text-foreground">
                            <span>Network Fetch + Compute</span>
                            <span className="font-bold text-destructive">{attackerSeconds.toFixed(2)}s</span>
                        </div>
                        <div className="w-full bg-secondary h-4 overflow-hidden border border-border/40">
                            <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: "100%" }}
                            transition={{ duration: 1 }}
                            className="h-full bg-destructive"
                            />
                        </div>
                    </div>
                </div>
            </div>
            
            <div className="mt-8 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive flex gap-3 items-start">
              <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5 text-destructive" />
              <p className="text-destructive">
                <strong>PoDE Intuition (Archived):</strong> Under these example parameters, remote fetch + compute exceeds a strict deadline of <strong>{deadlineMs}ms</strong>. 
                <br/>
                This is the core intuition PoDE attempted to encode; the current protocol achieves similar goals via incentives rather than a hard cutoff.
              </p>
            </div>
          </div>
        </section>
      </motion.div>
    </div>
  );
};
