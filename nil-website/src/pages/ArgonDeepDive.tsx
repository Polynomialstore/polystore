import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Clock, ShieldAlert, Cpu } from "lucide-react";
import { Link } from "react-router-dom";

export const ArgonDeepDive = () => {
  const [fileSizeMB, setFileSizeMB] = useState(5);
  const sealTimePerMB = 200; // ~200ms per MB
  const sealTimeSeconds = fileSizeMB * (sealTimePerMB / 1000);

  return (
    <div className="max-w-4xl">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >

        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-red-500/10 rounded-xl border border-red-500/20">
            <span className="text-2xl">🛡️</span>
          </div>
          <h1 className="text-4xl font-bold">Argon2id Proof-of-Seal</h1>
        </div>

        <p className="text-xl text-muted-foreground mb-12 leading-relaxed">
          Proof-of-Seal forces nodes to perform a slow, memory-hard encoding process ("Sealing") on the data, making on-demand generation impossible.
        </p>

        <div className="space-y-16">
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Cpu className="w-6 h-6 text-red-500" /> 1. Visualizing Memory Hardness
            </h2>
            <p className="text-muted-foreground mb-6">
              Argon2id fills a large memory matrix. You cannot skip this step.
            </p>
            
            <div className="bg-card border p-8 rounded-2xl shadow-sm flex flex-col items-center">
              <div className="grid grid-cols-8 gap-1 w-full max-w-md aspect-video bg-gray-100 p-2 rounded border">
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
                    className="bg-red-500 rounded-sm w-full h-full"
                  />
                ))}
              </div>
              <p className="mt-4 text-xs font-mono text-muted-foreground">15MB Memory Buffer Filling...</p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Clock className="w-6 h-6 text-blue-500" /> 2. The Timing Gap
            </h2>
            <div className="bg-card border p-8 rounded-2xl shadow-sm">
              <div className="mb-8">
                <label className="block text-sm font-medium mb-2">File Size to Seal (MB)</label>
                <input 
                  type="range" 
                  min="1" 
                  max="100" 
                  value={fileSizeMB} 
                  onChange={(e) => setFileSizeMB(Number(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="text-right font-mono mt-2">{fileSizeMB} MB</div>
              </div>

              <div className="space-y-6">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Time to Seal (Attacker)</span>
                    <span className="font-bold text-blue-600">{sealTimeSeconds.toFixed(2)}s</span>
                  </div>
                  <div className="w-full bg-secondary h-4 rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: "100%" }}
                      transition={{ duration: 1 }}
                      className="h-full bg-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Allowed Verification Time</span>
                    <span className="font-bold text-red-500">0.01s (10ms)</span>
                  </div>
                  <div className="w-full bg-secondary h-4 rounded-full overflow-hidden relative">
                    <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-red-500 z-10"></div>
                    <div className="h-full bg-red-200 w-[1%]" title="10ms window"></div>
                  </div>
                </div>
              </div>
              
              <div className="mt-8 p-4 bg-red-500/5 border border-red-500/20 rounded-lg text-sm text-red-800 flex gap-3 items-start">
                <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <p>
                  <strong>Security Guarantee:</strong> An attacker needs <strong>{sealTimeSeconds.toFixed(2)} seconds</strong> to regenerate the data, but the network only waits <strong>0.01 seconds</strong>. 
                  <br/>
                  Therefore, the attacker <em>must</em> store the sealed data to respond in time.
                </p>
              </div>
            </div>
          </section>
        </div>

        <div className="mt-16 flex justify-start">
          <Link to="/technology/kzg" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> Previous: KZG Commitments
          </Link>
        </div>
      </motion.div>
    </div>
  );
};
