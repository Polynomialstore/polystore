import { motion } from "framer-motion";
import { ArrowLeft, Zap, Database, CheckCircle } from "lucide-react";
import { Link } from "react-router-dom";

export const KZGDeepDive = () => {
  return (
    <div className="max-w-4xl">      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-purple-500/10 rounded-xl border border-purple-500/20">
            <span className="text-2xl">🔐</span>
          </div>
          <h1 className="text-4xl font-bold">KZG Polynomial Commitments</h1>
        </div>

        <p className="text-xl text-muted-foreground mb-12 leading-relaxed">
          The core of NilStore's verification layer. KZG (Kate-Zaverucha-Goldberg) commitments allow us to commit to a large dataset with a constant-sized commitment, and verify any point with a constant-sized proof.
        </p>

        <div className="space-y-16">
          {/* Section 1: Trusted Setup */}
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Database className="w-6 h-6 text-purple-500" /> 1. The Trusted Setup ($\tau$)
            </h2>
            <div className="bg-secondary/30 p-6 rounded-2xl border mb-6">
              <p className="mb-4">
                KZG requires a "Structured Reference String" (SRS). This involves generating a sequence of group elements based on a secret value $\tau$:
              </p>
              <div className="font-mono bg-black/80 text-purple-400 p-4 rounded-lg text-sm overflow-x-auto text-center shadow-inner">
                SRS = [ g, g^tau, g^(tau^2), ... , g^(tau^n) ]
              </div>
            </div>
          </section>

          {/* Section 2: Commitment */}
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Zap className="w-6 h-6 text-yellow-500" /> 2. Generating the Commitment
            </h2>
            <p className="text-muted-foreground mb-6">
              We compute the commitment $C$ as a linear combination of the SRS values.
            </p>
            
            <div className="grid md:grid-cols-2 gap-6 mb-6">
              <motion.div 
                whileHover={{ scale: 1.02 }}
                className="bg-blue-500/5 border border-blue-500/20 p-6 rounded-2xl text-center"
              >
                <h3 className="font-bold text-blue-600 mb-2">Blob (Input)</h3>
                <div className="text-4xl font-bold my-4">4MB</div>
                <p className="text-sm text-muted-foreground">Polynomial Coefficients</p>
              </motion.div>
              <motion.div 
                whileHover={{ scale: 1.02 }}
                className="bg-green-500/5 border border-green-500/20 p-6 rounded-2xl text-center"
              >
                <h3 className="font-bold text-green-600 mb-2">Commitment (Output)</h3>
                <div className="text-4xl font-bold my-4">48 Bytes</div>
                <p className="text-sm text-muted-foreground">Single Elliptic Curve Point</p>
              </motion.div>
            </div>
          </section>

          {/* Section 3: Verification */}
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <CheckCircle className="w-6 h-6 text-green-500" /> 3. Proof & Verification Protocol
            </h2>
            <div className="bg-secondary/30 p-8 rounded-2xl border overflow-hidden relative">
              
              {/* Animated Protocol Visualization */}
              <div className="flex flex-col md:flex-row items-center justify-between gap-8 relative z-10 h-64">
                
                {/* Verifier */}
                <div className="w-32 flex flex-col items-center z-20">
                  <div className="w-16 h-16 bg-white border-2 border-gray-200 rounded-full flex items-center justify-center text-3xl shadow-lg mb-2">🕵️</div>
                  <div className="font-bold">Verifier</div>
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
                    Proof ($\\pi$, y)
                  </motion.div>

                  {/* Connection Line */}
                  <div className="w-full border-t-2 border-dashed border-gray-300 absolute top-1/2 -translate-y-1/2"></div>
                </div>

                {/* Prover */}
                <div className="w-32 flex flex-col items-center z-20">
                  <div className="w-16 h-16 bg-white border-2 border-gray-200 rounded-full flex items-center justify-center text-3xl shadow-lg mb-2">📦</div>
                  <div className="font-bold">Prover</div>
                </div>
              </div>

              <div className="mt-4 text-center">
                <div className="inline-block bg-black text-green-400 font-mono p-3 rounded-lg border border-green-900 shadow-lg">
                  e(C - [y], H) ?= e($\\pi$, [$\tau$] - [z])
                </div>
              </div>
            </div>
          </section>
        </div>
      </motion.div>
    </div>
  );
};
