import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { File, Lock, CheckCircle, Server, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../lib/utils";
import { ShardingDeepDive } from "../pages/ShardingDeepDive";
import { KZGDeepDive } from "../pages/KZGDeepDive";
import { PerformanceDeepDive } from "../pages/PerformanceDeepDive";

const steps = [
  {
    id: 1,
    title: "Packing & Striping",
    description: "The file is packed into 8 MiB MDUs and split into 128 KiB blobs (the verification atom). In Mode 2, blobs are striped across providers with RS(K, K+M).",
    icon: <File className="w-6 h-6" />,
    DeepDiveComponent: ShardingDeepDive,
    visual: (
      <div className="grid grid-cols-4 gap-2">
        {[...Array(16)].map((_, i) => (
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.05 }}
            key={i}
            className="w-12 h-12 bg-blue-500/20 border border-blue-500 rounded flex items-center justify-center text-xs"
          >
            128KiB
          </motion.div>
        ))}
      </div>
    )
  },
  {
    id: 2,
    title: "KZG Commitment",
    description: "Chunks are packed into a polynomial. A KZG commitment (48 bytes) is generated, representing the entire dataset compactly.",
    icon: <Lock className="w-6 h-6" />,
    DeepDiveComponent: KZGDeepDive,
    visual: (
      <div className="relative w-48 h-48 bg-purple-500/10 rounded-full flex items-center justify-center border-2 border-dashed border-purple-500 animate-spin-slow">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-purple-500 font-bold">C(x)</span>
        </div>
      </div>
    )
  },
  {
    id: 3,
    title: "Performance Market",
    description: "No sealing. Providers are rewarded by response time and availability. Retrieval receipts and synthetic checks make performance observable and enforceable.",
    icon: <Server className="w-6 h-6" />,
    DeepDiveComponent: PerformanceDeepDive,
    visual: (
      <div className="flex gap-4 items-center">
        <div className="w-24 h-24 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold">Data</div>
        <motion.div 
          animate={{ x: [0, 10, 0] }} 
          transition={{ repeat: Infinity, duration: 1.5 }}
          className="text-2xl text-muted-foreground"
        >→</motion.div>
        <div className="w-24 h-24 bg-green-500 rounded-lg flex items-center justify-center text-white font-bold shadow-lg shadow-green-500/20">Served</div>
      </div>
    )
  },
  {
    id: 4,
    title: "Triple Proof Verification",
    description: "A provider proves a challenged byte is part of the Deal commitment via a chained proof (Deal → MDU → Blob → Byte). Verifiers check this in < 1ms.",
    icon: <CheckCircle className="w-6 h-6" />,
    visual: (
      <div className="flex flex-col gap-4 items-center">
        <div className="text-green-500 text-6xl">✓</div>
        <div className="font-mono bg-black text-green-400 p-4 rounded-lg text-sm">
          {`verify(C, z, y, proof) == true`}
          <br/>
          <span className="text-gray-500">Time: 0.94ms</span>
        </div>
      </div>
    )
  },
];

export const AlgorithmWalkthrough = () => {
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  const toggleStep = (id: number) => {
    setExpandedStep(expandedStep === id ? null : id);
  };

  return (
    <section className="py-12">
      <div className="container mx-auto">
        <div className="space-y-8 relative">
          {/* Vertical Connector Line */}
          <div className="absolute left-8 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-border to-transparent hidden lg:block" />

          {steps.map((step) => (
            <motion.div
              key={step.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.5 }}
              className="relative pl-0 lg:pl-24"
            >
              {/* Step Marker */}
              <div className="absolute left-8 top-8 w-3 h-3 rounded-full bg-primary -translate-x-1.5 hidden lg:block ring-4 ring-background" />

              <div className={cn(
                "bg-card rounded-3xl border shadow-sm overflow-hidden transition-all duration-500",
                expandedStep === step.id ? "ring-2 ring-primary/20 border-primary/50 shadow-md" : "hover:border-primary/30"
              )}>
                {/* Header / Summary Section */}
                <div className="p-8 flex flex-col lg:flex-row gap-8 items-center cursor-pointer" onClick={() => step.DeepDiveComponent && toggleStep(step.id)}>
                  <div className="flex-1">
                    <div className="flex items-center gap-4 mb-4">
                      <div className="p-3 bg-secondary rounded-2xl text-foreground">
                        {step.icon}
                      </div>
                      <h3 className="text-2xl font-bold">{step.title}</h3>
                    </div>
                    <p className="text-lg text-muted-foreground leading-relaxed">
                      {step.description}
                    </p>
                  </div>

                  <div className="lg:w-1/3 w-full flex justify-center">
                    {step.visual}
                  </div>

                  {step.DeepDiveComponent && (
                    <div className="flex-shrink-0">
                      <button 
                        className={cn(
                          "flex items-center gap-2 px-6 py-3 rounded-full font-medium transition-all",
                          expandedStep === step.id 
                            ? "bg-secondary text-foreground hover:bg-secondary/80" 
                            : "bg-primary text-primary-foreground hover:opacity-90 hover:scale-105 shadow-lg shadow-primary/20"
                        )}
                      >
                        {expandedStep === step.id ? (
                          <>Close Deep Dive <ChevronUp className="w-4 h-4" /></>
                        ) : (
                          <>Explore Deep Dive <ChevronDown className="w-4 h-4" /></>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* Expandable Content */}
                <AnimatePresence>
                  {expandedStep === step.id && step.DeepDiveComponent && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.4, ease: "easeInOut" }}
                      className="overflow-hidden bg-secondary/10 border-t"
                    >
                      <div className="p-8 lg:p-12">
                        <step.DeepDiveComponent />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};
