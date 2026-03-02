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
          <div className="p-3 bg-accent/10 rounded-xl border border-accent/20 shrink-0">
            <Hash className="w-8 h-8 text-accent" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">Cryptographic Binding: Proof-of-Useful-Data (PoUD)</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-12">
          NilStore's core security mechanism: <strong>Proof-of-Useful-Data (PoUD)</strong> ensures storage providers truly possess your data. It leverages <strong>KZG (Kate-Zaverucha-Goldberg) Commitments</strong>, allowing verification of a massive dataset with a tiny proof.
        </p>

        {/* Section 1: Trusted Setup */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Database className="w-5 h-5 text-primary" /> 1. The Trusted Setup ($\tau$)
          </h3>
          <p className="text-muted-foreground mb-4">
            KZG requires a "Structured Reference String" (SRS). This is a public parameter generated once from a secret $\tau$. Our SRS is compatible with Ethereum's EIP-4844 blobs.
          </p>
          <div className="bg-secondary/30 p-6 rounded-xl border border-border mb-6">
            <p className="text-sm text-muted-foreground mb-4">
              The SRS comprises a sequence of elliptic curve points derived from powers of $\tau$:
            </p>
            <div className="font-mono-data bg-background/50 text-foreground p-4 rounded-lg text-sm overflow-x-auto text-center border border-border shadow-inner">
              SRS = [ g, g^tau, g^(tau^2), ... , g^(tau^n) ]
            </div>
          </div>
        </section>

        {/* Section 2: Commitment */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Zap className="w-5 h-5 text-primary" /> 2. The Commitment (Atomic Blob)
          </h3>
          <p className="text-muted-foreground mb-6">
            We divide data into <strong>128 KiB Atomic Blobs</strong>. Each blob is treated as a polynomial $P(x)$. We
            evaluate this polynomial at the secret $\tau$ to get a single 48-byte Commitment.
          </p>
          
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <motion.div 
              whileHover={{ scale: 1.02 }}
              className="bg-primary/5 p-6 rounded-2xl text-center border border-primary/20"
            >
              <h4 className="font-bold text-lg text-primary mb-2">Atomic Blob</h4>
              <div className="text-4xl font-bold my-4 text-foreground">128 KiB</div>
              <p className="text-sm text-muted-foreground">4,096 Field Elements</p>
            </motion.div>
            <motion.div 
              whileHover={{ scale: 1.02 }}
              className="bg-accent/5 p-6 rounded-2xl text-center border border-accent/20"
            >
              <h4 className="font-bold text-lg text-accent mb-2">Commitment</h4>
              <div className="text-4xl font-bold my-4 text-foreground">48 Bytes</div>
              <p className="text-sm text-muted-foreground">Unique Polynomial ID</p>
            </motion.div>
          </div>
        </section>

        {/* Section 3: The Triple Proof */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <CheckCircle className="w-5 h-5 text-accent" /> 3. The Triple Proof (Scale)
          </h3>
          <p className="text-muted-foreground mb-6">
            How do you verify a 1 Petabyte dataset with a single hash? NilStore uses a <strong>3-Hop Verification Chain</strong> to bind every byte to the Deal Root.
          </p>
          <div className="bg-card p-6 rounded-xl border border-border mb-6 space-y-4">
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-primary/10 text-primary border border-primary/20 flex items-center justify-center font-bold">1</div>
                <div>
                    <h4 className="font-bold text-foreground">Hop 1: The Manifest</h4>
                    <p className="text-sm text-muted-foreground">Verify the <strong>MDU Root</strong> is part of the Deal's Manifest. (KZG)</p>
                </div>
            </div>
            <div className="w-0.5 h-6 bg-border ml-4"></div>
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-background/60 text-foreground border border-border/60 flex items-center justify-center font-bold">2</div>
                <div>
                    <h4 className="font-bold text-foreground">Hop 2: The Structure</h4>
                    <p className="text-sm text-muted-foreground">Verify the <strong>Blob Commitment</strong> is part of the MDU. (Merkle)</p>
                </div>
            </div>
            <div className="w-0.5 h-6 bg-border ml-4"></div>
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-accent/10 text-accent border border-accent/20 flex items-center justify-center font-bold">3</div>
                <div>
                    <h4 className="font-bold text-foreground">Hop 3: The Data</h4>
                    <p className="text-sm text-muted-foreground">Verify the <strong>Data Byte</strong> belongs to the Blob Polynomial. (KZG Evaluation)</p>
                </div>
            </div>
          </div>
          <div className="bg-secondary/30 p-8 rounded-2xl border border-border overflow-hidden relative">
            
            {/* Animated Protocol Visualization */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-8 relative z-10 h-64">
              
              {/* Verifier */}
              <div className="w-32 flex flex-col items-center z-20">
                <div className="w-16 h-16 bg-background/60 border-2 border-border/60 flex items-center justify-center text-3xl shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] mb-2 text-foreground">🕵️</div>
                <div className="font-bold text-foreground">Verifier</div>
              </div>

              {/* Interaction Layer */}
              <div className="flex-1 relative h-full w-full flex items-center justify-center">
                {/* Challenge Packet */}
                <motion.div
                  initial={{ x: -100, opacity: 0 }}
                  animate={{ x: 100, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 2, repeat: Infinity, repeatDelay: 1 }}
                  className="absolute top-1/3 bg-primary/10 border border-primary/30 px-3 py-1 rounded-none text-xs font-bold text-primary shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] z-10"
                >
                  Challenge (MDU 5, Byte 100)
                </motion.div>

                {/* Response Packet */}
                <motion.div
                  initial={{ x: 100, opacity: 0 }}
                  animate={{ x: -100, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 2, delay: 1, repeat: Infinity, repeatDelay: 1 }}
                  className="absolute bottom-1/3 bg-accent/10 border border-accent/30 px-3 py-1 rounded-none text-xs font-bold text-accent shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] z-10"
                >
                  Triple Proof ($\pi_1, \pi_2, \pi_3$)
                </motion.div>

                {/* Connection Line */}
                <div className="w-full border-t-2 border-dashed border-border absolute top-1/2 -translate-y-1/2"></div>
              </div>

              {/* Prover */}
              <div className="w-32 flex flex-col items-center z-20">
                <div className="w-16 h-16 bg-background/60 border-2 border-border/60 flex items-center justify-center text-3xl shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] mb-2 text-foreground">📦</div>
                <div className="font-bold text-foreground">Prover</div>
              </div>
            </div>

            <div className="mt-4 text-center">
              <div className="inline-block bg-background/50 text-foreground font-mono-data p-3 rounded-lg border border-border shadow-lg">
                Chain Check: Valid(Root, $\pi$) == TRUE
              </div>
            </div>
          </div>
        </section>
      </motion.div>
    </div>
  );
};
