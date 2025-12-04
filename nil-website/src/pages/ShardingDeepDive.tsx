import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, File, Hash, Code, Layers, ArrowRightLeft } from "lucide-react";
import { Link } from "react-router-dom";

export const ShardingDeepDive = () => {
  const [isReversed, setIsReversed] = useState(false);

  // Toggle reversal every few seconds for demo
  useEffect(() => {
    const interval = setInterval(() => {
      setIsReversed((prev) => !prev);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const indices = [0, 1, 2, 3, 4, 5, 6, 7];
  // Bit reversal for 3 bits (0-7):
  const reversedIndices = [0, 4, 2, 6, 1, 5, 3, 7];

  const currentOrder = isReversed ? reversedIndices : indices;

  return (
    <div className="max-w-4xl">      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-blue-500/10 rounded-xl border border-blue-500/20">
            <span className="text-2xl">🧩</span>
          </div>
          <h1 className="text-4xl font-bold">Data Sharding & Encoding</h1>
        </div>

        <p className="text-xl text-muted-foreground mb-12 leading-relaxed">
          Before any cryptography happens, user data must be prepared for the "Nil-Lattice". This involves splitting files into uniform symbols, mapping them to the scalar field of the BLS12-381 curve, and aggregating them into blobs.
        </p>

        <div className="space-y-16">
          {/* Section 1: The 1KB Symbol */}
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <File className="w-6 h-6 text-blue-500" /> 1. The 128KB Symbol
            </h2>
            <p className="text-muted-foreground mb-6">
              NilStore standardizes all data into <strong>131,072-byte (128KB)</strong> symbols. This size aligns with Ethereum's EIP-4844 blobs for maximum interoperability and efficiency.
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
                <div className="text-sm font-medium">Input File</div>
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
                      128KB
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 bg-secondary/30 p-4 rounded-lg border">
              <h4 className="font-bold text-sm mb-2 flex items-center gap-2">
                <Code className="w-4 h-4" /> Implementation Detail
              </h4>
              <pre className="text-xs overflow-x-auto font-mono bg-black/80 text-gray-300 p-4 rounded">
{`pub fn file_to_symbols(data: &[u8]) -> Vec<Vec<u8>> {
    // ...
    for chunk in data.chunks(SYMBOL_SIZE) {
        // ...
    }
}`}
              </pre>
            </div>
          </section>

          {/* Section 2: Mapping to the Field */}
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Hash className="w-6 h-6 text-green-500" /> 2. Mapping to the Field ($Fr$)
            </h2>
            <div className="bg-secondary/30 p-6 rounded-2xl border mb-6">
              <p className="mb-4">
                Cryptographic proofs (KZG) work on numbers, not raw bytes. We map each chunk to an integer modulo a massive prime number $r$.
              </p>
              <div className="font-mono bg-black/80 text-green-400 p-4 rounded-lg text-sm overflow-x-auto mb-4 shadow-inner">
                r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
              </div>
            </div>

            <div className="bg-yellow-500/10 border border-yellow-500/20 p-4 rounded-lg">
              <h4 className="font-bold text-sm text-yellow-600 mb-2">⚠️ Engineering Nuance: Big Endian vs Little Endian</h4>
              <p className="text-sm text-muted-foreground">
                While Rust typically uses Little Endian, the <code>c-kzg</code> library (based on Ethereum specs) expects field elements in <strong>Big Endian</strong> format. 
                Our CLI tool explicitly handles this conversion to ensure proofs generated locally are valid on the network.
              </p>
            </div>
          </section>

          {/* Section 3: Blob Aggregation */}
          <section>
            <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
              <Layers className="w-6 h-6 text-purple-500" /> 3. Blob Aggregation & Bit-Reversal
            </h2>
            <p className="text-muted-foreground mb-6">
              To allow $O(n \log n)$ commitment generation, we must reorder the data chunks within a blob using a <strong>Bit-Reversal Permutation</strong>.
            </p>
            
            <div className="bg-card border rounded-3xl p-8 shadow-sm overflow-hidden">
              <div className="flex justify-between items-center mb-8">
                <h3 className="font-bold flex items-center gap-2">
                  <ArrowRightLeft className="w-4 h-4" /> 
                  {isReversed ? "Bit-Reversed Order" : "Natural Order"}
                </h3>
                <div className="text-xs bg-secondary px-2 py-1 rounded font-mono">
                  {isReversed ? "FFT Ready" : "Input Stream"}
                </div>
              </div>

              <div className="flex justify-center gap-2 relative h-20">
                {currentOrder.map((val) => (
                  <motion.div
                    layout
                    key={val}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="w-10 h-10 md:w-12 md:h-12 bg-purple-100 border border-purple-300 text-purple-700 rounded-lg flex flex-col items-center justify-center shadow-sm z-10"
                  >
                    <span className="text-xs font-bold">{val}</span>
                    <span className="text-[8px] opacity-60 font-mono">
                      {val.toString(2).padStart(3, '0')}
                    </span>
                  </motion.div>
                ))}
              </div>
              
              <div className="mt-4 text-center text-xs text-muted-foreground">
                Visualizing permutation for 8 elements ($2^3$)
              </div>
            </div>

            <div className="mt-6">
              <div className="bg-secondary/30 p-4 rounded-lg border">
                <h4 className="font-bold text-sm mb-2 flex items-center gap-2">
                  <Code className="w-4 h-4" /> Rust Implementation
                </h4>
                <pre className="text-xs overflow-x-auto font-mono bg-black/80 text-gray-300 p-4 rounded">
{`// Apply bit-reversal permutation
let j = reverse_bits(i, 12); // 4096 = 2^12
let offset = j * 32;
blob[offset..offset+32].copy_from_slice(&bytes);`}
                </pre>
              </div>
            </div>
          </section>
        </div>
      </motion.div>
    </div>
  );
};
