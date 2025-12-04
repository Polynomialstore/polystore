import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { File, Hash, Layers, ArrowRightLeft, Spline } from "lucide-react";

export const ShardingDeepDive = () => {
  const [isReversed, setIsReversed] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsReversed((prev) => !prev);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const indices = [0, 1, 2, 3, 4, 5, 6, 7];
  const reversedIndices = [0, 4, 2, 6, 1, 5, 3, 7];
  const currentOrder = isReversed ? reversedIndices : indices;

  return (
    <div className="w-full">      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-16"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-blue-500/10 rounded-xl border border-blue-500/20 shrink-0">
            <Spline className="w-8 h-8 text-blue-500" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">Data Layout: Erasure Coding & Sharding</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-6">
          NilStore achieves unparalleled durability and performance through precise data fragmentation, not simple replication. Files are processed into standardized chunks called <strong>Data Units (DUs)</strong>.
        </p>

        {/* Section 1: Data Units (DUs) */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <File className="w-5 h-5 text-blue-500" /> 8 MiB Mega-Data Units (MDUs)
          </h3>
          <p className="text-muted-foreground mb-6">
            Files are first packed into standardized Data Units. NilStore standardizes all data into <strong>8 MiB (8,388,608 bytes)</strong> Mega-Data Units. This size optimizes batch verification throughput and aligns with our tiered reward structure.
          </p>
          
          <div className="grid md:grid-cols-3 gap-4 items-center bg-secondary/10 p-8 rounded-3xl border">
            <div className="flex flex-col items-center gap-4">
              <motion.div 
                className="w-24 h-32 bg-blue-100 border-2 border-blue-300 rounded-lg flex items-center justify-center shadow-sm relative"
                whileHover={{ scale: 1.05 }}
              >
                <File className="w-8 h-8 text-blue-500" />
                <div className="absolute bottom-2 text-[10px] font-mono text-blue-600">RAW DATA</div>
              </motion.div>
              <div className="text-sm font-medium text-foreground">Input File</div>
            </div>

            <div className="flex items-center justify-center">
              <motion.div
                animate={{ x: [0, 10, 0] }}
                transition={{ repeat: Infinity, duration: 1.5 }}
              >
                <span className="text-4xl text-muted-foreground/50">→</span>
              </motion.div>
            </div>

            <div className="relative h-32 w-full max-w-[200px] mx-auto">
              <div className="absolute inset-0 grid grid-cols-2 gap-2">
                {[...Array(4)].map((_, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, scale: 0.5 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.2, duration: 0.5 }}
                    className="bg-green-100 border border-green-300 rounded flex items-center justify-center text-[10px] font-mono text-green-700 shadow-sm"
                  >
                    8 MiB
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Section 2: Configurable Erasure Coding */}
        <section className="mt-16">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Layers className="w-5 h-5 text-purple-500" /> Configurable Erasure Coding
          </h3>
          <p className="text-muted-foreground mb-6">
            Each DU is mathematically split using Reed-Solomon encoding (RS). You can configure the redundancy level <strong>per file</strong>, choosing from profiles like "Standard", "Archive", or "Mission Critical".
          </p>
          <div className="bg-card border border-border p-6 rounded-xl shadow-sm">
            <p className="text-sm text-muted-foreground mb-4">
              <strong>Example:</strong> A "Standard" profile might use RS(12,9), meaning data is split into 12 shards, and any 9 are needed to reconstruct the original DU.
            </p>
            <div className="flex justify-around items-center text-center mt-6">
              <div className="flex flex-col items-center">
                <span className="text-4xl font-bold text-blue-400">9</span>
                <span className="text-sm text-muted-foreground">Data Shards (k)</span>
              </div>
              <span className="text-3xl text-muted-foreground">+</span>
              <div className="flex flex-col items-center">
                <span className="text-4xl font-bold text-purple-400">3</span>
                <span className="text-sm text-muted-foreground">Parity Shards (n-k)</span>
              </div>
              <span className="text-3xl text-muted-foreground">=</span>
              <div className="flex flex-col items-center">
                <span className="text-4xl font-bold text-green-400">12</span>
                <span className="text-sm text-muted-foreground">Total Shards (n)</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground italic mt-6">
              This means you could lose 3 entire nodes (25% of the network) and your data is still safe.
            </p>
          </div>
        </section>

        {/* Section 3: Distribution & Repair */}
        <section className="mt-16">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <ArrowRightLeft className="w-5 h-5 text-green-500" /> System-Defined Placement
          </h3>
          <p className="text-muted-foreground mb-6">
            To prevent "Sybil Attacks" (where a single user pretends to be 10 different nodes to trick the system), NilStore uses <strong>Deterministic Slotting</strong>.
          </p>
          <div className="bg-card border border-border p-6 rounded-xl shadow-sm mb-6">
            <p className="text-sm text-muted-foreground font-mono">
              Target_Slot = Hash(DealID + BlockHash + ShardIndex)
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              This means the blockchain decides where data goes, not the user. This forces diversity and ensures robust decentralization.
            </p>
          </div>
          <ul className="list-disc list-inside text-muted-foreground space-y-2 mb-6">
            <li><strong>Customizable Resilience:</strong> You choose the safety level for each file.</li>
            <li><strong>Parallel Throughput:</strong> Client software downloads from the fastest available subset of nodes simultaneously.</li>
            <li><strong>Efficient Repair:</strong> If a node fails, the network mathematically reconstructs only the specific missing shard, without needing to move the full file.</li>
          </ul>
        </section>

        {/* Section 4: Mapping to the Field */}
        <section className="mt-16">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
              <Hash className="w-5 h-5 text-green-500" /> Mapping to the Field ($Fr$)
            </h3>
            <div className="bg-card p-6 rounded-xl border border-border mb-6">
              <p className="text-muted-foreground mb-4">
                Cryptographic proofs (KZG) work on numbers, not raw bytes. We map each 128 KiB data unit to an integer modulo a massive prime number $r$. This is the input to our commitment scheme.
              </p>
              <div className="font-mono bg-background/50 text-foreground p-4 rounded-lg text-sm overflow-x-auto mb-4 border border-border shadow-inner">
                r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
              </div>
              <div className="bg-accent/10 border border-accent/50 p-4 rounded-lg">
                <h4 className="font-bold text-sm text-accent-foreground mb-2">⚠️ Engineering Nuance: Big Endian vs Little Endian</h4>
                <p className="text-sm text-muted-foreground">
                  The underlying <code>c-kzg</code> library (based on Ethereum specs) expects field elements in <strong>Big Endian</strong> format. Our core library explicitly handles this conversion to ensure cryptographic compatibility.
                </p>
              </div>
            </div>
          </section>
      </motion.div>
    </div>
  );
};
