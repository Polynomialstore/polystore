import { motion } from "framer-motion";
import { File, Hash, Layers, ArrowRightLeft, Spline } from "lucide-react";

export const ShardingDeepDive = () => {
  return (
    <div className="w-full">      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-16"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-primary/10 rounded-none border border-primary/20 shrink-0">
            <Spline className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">Data Layout: Erasure Coding & Sharding</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-6">
          PolyStore achieves unparalleled durability and performance through precise data fragmentation, not simple replication. Files are processed into standardized chunks called <strong>Data Units (DUs)</strong>.
        </p>

        {/* Section 1: Data Units (DUs) */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <File className="w-5 h-5 text-primary" /> 8 MiB Mega-Data Units (MDUs)
          </h3>
          <p className="text-muted-foreground mb-6">
            Files are first packed into standardized Data Units. PolyStore standardizes all data into <strong>8 MiB (8,388,608 bytes)</strong> Mega-Data Units. Each MDU contains <strong>64 × 128 KiB blobs</strong>, the atomic unit of KZG verification.
          </p>
          
          <div className="grid md:grid-cols-3 gap-4 items-center bg-secondary/10 p-8 rounded-none border">
            <div className="flex flex-col items-center gap-4">
              <motion.div 
                className="w-24 h-32 bg-primary/10 border-2 border-primary/30 rounded-none flex items-center justify-center shadow-sm relative"
                whileHover={{ scale: 1.05 }}
              >
                <File className="w-8 h-8 text-primary" />
                <div className="absolute bottom-2 text-[10px] font-mono-data text-primary uppercase tracking-[0.2em] font-bold">RAW DATA</div>
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
                    className="bg-accent/10 border border-accent/30 rounded-none flex items-center justify-center text-[10px] font-mono-data text-accent shadow-sm uppercase tracking-[0.2em] font-bold"
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
            <Layers className="w-5 h-5 text-primary" /> Mode 2: StripeReplica (RS(K, K+M))
          </h3>
          <p className="text-muted-foreground mb-6">
            Each 8 MiB MDU is encoded with Reed-Solomon across <strong>N = K+M provider slots</strong>. Trusted devnet defaults to <strong>2+1</strong> for lighter bring-up; protocol defaults remain aligned to <strong>8+4</strong> for larger deployments. Each slot stores <strong>8 MiB / K</strong> bytes per MDU, aligned to <strong>128 KiB blobs</strong> for shared-nothing verification.
          </p>
          <div className="bg-card border border-border p-6 rounded-none shadow-sm">
            <p className="text-sm text-muted-foreground mb-4">
              <strong>The Math (trusted-devnet default):</strong> <strong>K=2</strong> data slots + <strong>M=1</strong> parity slot (<strong>N=3</strong>). The protocol is defined as RS(K, K+M) (with <strong>K | 64</strong>), so larger profiles (for example <strong>8+4</strong>) remain supported.
            </p>
            <div className="flex justify-around items-center text-center mt-6">
              <div className="flex flex-col items-center">
                <span className="text-4xl font-bold text-primary">2</span>
                <span className="text-sm text-muted-foreground">Data Slots (trusted-devnet default)</span>
              </div>
              <span className="text-3xl text-muted-foreground">+</span>
              <div className="flex flex-col items-center">
                <span className="text-4xl font-bold text-foreground">1</span>
                <span className="text-sm text-muted-foreground">Parity Slots (trusted-devnet default)</span>
              </div>
              <span className="text-3xl text-muted-foreground">=</span>
              <div className="flex flex-col items-center">
                <span className="text-4xl font-bold text-accent">3</span>
                <span className="text-sm text-muted-foreground">Total Slots (trusted-devnet default)</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground italic mt-6">
              In the trusted-devnet 2+1 profile, you can lose any 1 of 3 nodes (33%) and still recover the file.
            </p>
          </div>
        </section>

        {/* Section 3: Distribution & Repair */}
        <section className="mt-16">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <ArrowRightLeft className="w-5 h-5 text-accent" /> Self-Healing & Verification
          </h3>
          <p className="text-muted-foreground mb-6">
            To prevent "Sybil Attacks" and ensure data integrity without centralization:
          </p>
          <div className="bg-card border border-border p-6 rounded-none shadow-sm mb-6">
            <h4 className="font-bold text-foreground mb-2">Replicated Metadata ("The Map")</h4>
            <p className="text-sm text-muted-foreground">
              While user data is striped across slots, the <strong>Metadata</strong> (MDU #0 + Witness) is replicated to <strong>all N slots</strong> (default 12).
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              This allows any single node to cryptographically prove they hold the correct shard ("Shared-Nothing Verification") without needing to ask their neighbors.
            </p>
          </div>
          <ul className="list-disc list-inside text-muted-foreground space-y-2 mb-6">
            <li><strong>Atomic Repair:</strong> If a node fails, a new node can reconstruct the missing slot shard by asking any <strong>K</strong> neighbors (default 8), validating them against the Witness Map trustlessly.</li>
            <li><strong>Parallel Throughput:</strong> Users download from 12 nodes simultaneously, aggregating bandwidth.</li>
          </ul>
        </section>

        {/* Section 4: Mapping to the Field */}
        <section className="mt-16">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
              <Hash className="w-5 h-5 text-accent" /> Mapping to the Field ($Fr$)
            </h3>
            <div className="bg-card p-6 rounded-none border border-border mb-6">
              <p className="text-muted-foreground mb-4">
                Cryptographic proofs (KZG) work on numbers, not raw bytes. We map each 128 KiB blob to a field element modulo a massive prime number $r$. 64 blobs make up a single 8 MiB MDU.
              </p>
              <div className="font-mono-data bg-background/50 text-foreground p-4 rounded-none text-sm overflow-x-auto mb-4 border border-border shadow-inner">
                r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
              </div>
              <div className="bg-accent/10 border border-accent/50 p-4 rounded-none">
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
