import { motion } from "framer-motion";
import { Zap, Database, CheckCircle, Hash } from "lucide-react";

export const KZGDeepDive = () => {
  return (
    <div className="w-full">      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-16"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-green-500/10 rounded-xl border border-green-500/20 shrink-0">
            <Hash className="w-8 h-8 text-green-500" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">Cryptographic Binding: Proof-of-Useful-Data (PoUD)</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-12">
          NilStore's core security mechanism: <strong>Proof-of-Useful-Data (PoUD)</strong> ensures storage providers truly possess your data. It leverages <strong>KZG (Kate-Zaverucha-Goldberg) Commitments</strong>, allowing verification of a massive dataset with a tiny proof.
        </p>

        {/* Section 1: Trusted Setup */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Database className="w-5 h-5 text-purple-500" /> 1. The Trusted Setup ($\tau$)
          </h3>
          <p className="text-muted-foreground mb-4">
            KZG requires a "Structured Reference String" (SRS). This is a public parameter generated once from a secret $\tau$. Our SRS is compatible with Ethereum's EIP-4844 blobs.
          </p>
          <div className="bg-secondary/30 p-6 rounded-xl border border-border mb-6">
            <p className="text-sm text-muted-foreground mb-4">
              The SRS comprises a sequence of elliptic curve points derived from powers of $\tau$:
            </p>
            <div className="font-mono bg-background/50 text-foreground p-4 rounded-lg text-sm overflow-x-auto text-center border border-border shadow-inner">
              SRS = [ g, g^tau, g^(tau^2), ... , g^(tau^n) ]
            </div>
          </div>
        </section>

        {/* Section 2: Commitment */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Zap className="w-5 h-5 text-yellow-500" /> 2. The Commitment (C_root)
          </h3>
          <p className="text-muted-foreground mb-6">
            After data is sharded and mapped to field elements, we compute a single, compact KZG commitment for each blob of 8 MiB. This commitment ($C_root$) acts as a tamper-proof cryptographic fingerprint of the data.
          </p>
          
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <motion.div 
              whileHover={{ scale: 1.02 }}
              className="bg-primary/5 p-6 rounded-2xl text-center border border-primary/20"
            >
              <h4 className="font-bold text-lg text-primary mb-2">Blob (Input Data Unit)</h4>
              <div className="text-4xl font-bold my-4 text-foreground">8 MB</div>
              <p className="text-sm text-muted-foreground">262,144 Field Elements</p>
            </motion.div>
            <motion.div 
              whileHover={{ scale: 1.02 }}
              className="bg-green-500/5 p-6 rounded-2xl text-center border border-green-500/20"
            >
              <h4 className="font-bold text-lg text-green-600 mb-2">Commitment (Output)</h4>
              <div className="text-4xl font-bold my-4 text-foreground">48 Bytes</div>
              <p className="text-sm text-muted-foreground">Single Elliptic Curve Point</p>
            </motion.div>
          </div>
        </section>

        {/* Section 3: Proof & Verification Protocol */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <CheckCircle className="w-5 h-5 text-green-500" /> 3. Unified Verification
          </h3>
          <p className="text-muted-foreground mb-6">
            In the <strong>Performance Market</strong>, we don't just audit data in the background. When a user retrieves a file, the Storage Provider attaches a KZG proof to the data stream.
          </p>
          <div className="bg-card p-6 rounded-xl border border-border mb-6">
            <p className="text-sm text-muted-foreground">
              <strong>The "Double-Pay" Innovation:</strong> The user signs a receipt for the valid data. This receipt serves two purposes:
            </p>
            <ul className="list-disc list-inside text-sm text-muted-foreground mt-2 ml-2">
                <li>It proves the user got their file (Bandwidth Fee).</li>
                <li>It proves the node has the data (Storage Reward).</li>
            </ul>
          </div>
          <div className="bg-secondary/30 p-8 rounded-2xl border border-border overflow-hidden relative">
            
            {/* Animated Protocol Visualization */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-8 relative z-10 h-64">
              
              {/* Verifier */}
              <div className="w-32 flex flex-col items-center z-20">
                <div className="w-16 h-16 bg-white border-2 border-gray-200 rounded-full flex items-center justify-center text-3xl shadow-lg mb-2 text-foreground">🕵️</div>
                <div className="font-bold text-foreground">Verifier</div>
              </div>

              {/* Interaction Layer */}
              <div className="flex-1 relative h-full w-full flex items-center justify-center">
                {/* Challenge Packet */}
                <motion.div
                  initial={{ x: -100, opacity: 0 }}
                  animate={{ x: 100, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 2, repeat: Infinity, repeatDelay: 1 }}
                  className="absolute top-1/3 bg-yellow-100 border border-yellow-400 px-3 py-1 rounded-full text-xs font-bold text-yellow-700 shadow-sm z-10"
                >
                  Challenge (z)
                </motion.div>

                {/* Response Packet */}
                <motion.div
                  initial={{ x: 100, opacity: 0 }}
                  animate={{ x: -100, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 2, delay: 1, repeat: Infinity, repeatDelay: 1 }}
                  className="absolute bottom-1/3 bg-green-100 border border-green-400 px-3 py-1 rounded-full text-xs font-bold text-green-700 shadow-sm z-10"
                >
                  Proof ($\pi$, y)
                </motion.div>

                {/* Connection Line */}
                <div className="w-full border-t-2 border-dashed border-border absolute top-1/2 -translate-y-1/2"></div>
              </div>

              {/* Prover */}
              <div className="w-32 flex flex-col items-center z-20">
                <div className="w-16 h-16 bg-white border-2 border-gray-200 rounded-full flex items-center justify-center text-3xl shadow-lg mb-2 text-foreground">📦</div>
                <div className="font-bold text-foreground">Prover</div>
              </div>
            </div>

            <div className="mt-4 text-center">
              <div className="inline-block bg-background/50 text-foreground font-mono p-3 rounded-lg border border-border shadow-lg">
                e(C - [y], G2) ?= e($\pi$, [$\tau$] - [z])
              </div>
            </div>
          </div>
        </section>
      </motion.div>
    </div>
  );
};
