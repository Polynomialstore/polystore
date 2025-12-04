import { useState, useEffect } from 'react';
import simulationData from '../data/adversarial_simulation.json';
import { ShieldAlert, CheckCircle, XCircle, Clock, Server, Wifi, Database, Lock } from 'lucide-react';
import { motion } from 'framer-motion';

export const AdversarialSimulation = () => {
  const { data, analysis, meta } = simulationData;
  const deadline = meta.parameters.deadline_ms;

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-5xl">
      
      {/* Header */}
      <div className="mb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className="text-5xl font-bold mb-6 text-foreground">Anatomy of an Attack</h1>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
            In decentralized storage, the most common threat isn't a hacker deleting data—it's a 
            <strong> Lazy Provider</strong> trying to trick the network. 
            <br/>
            Here is how NilStore's cryptography catches them in the act.
          </p>
        </motion.div>
      </div>

      {/* Chapter 1: The Motive */}
      <section className="mb-24">
        <div className="flex items-start gap-6">
          <div className="p-4 bg-blue-500/10 rounded-2xl border border-blue-500/20 shrink-0 hidden md:block">
            <Database className="w-8 h-8 text-blue-500" />
          </div>
          <div>
            <h2 className="text-3xl font-bold text-foreground mb-4">Chapter 1: The "Lazy Provider" Attack</h2>
            <p className="text-muted-foreground mb-6 leading-relaxed">
              Imagine a Storage Provider who wants to earn rewards without buying hard drives. 
              Instead of storing your 10TB of data locally, they delete it.
              When you ask for the data, they secretly fetch it from a cheap, slow service (like IPFS or Amazon S3 Glacier) 
              and forward it to you, pretending it was on their disk all along.
            </p>
            <div className="bg-card p-6 rounded-xl border border-border">
              <h4 className="font-bold text-foreground mb-2 text-sm uppercase tracking-wide">The Attacker's Goal</h4>
              <p className="text-sm text-muted-foreground">
                Earn <strong>$STOR</strong> rewards while paying $0 for high-speed local storage.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Chapter 2: The Defense */}
      <section className="mb-24">
        <div className="flex items-start gap-6">
          <div className="p-4 bg-purple-500/10 rounded-2xl border border-purple-500/20 shrink-0 hidden md:block">
            <Clock className="w-8 h-8 text-purple-500" />
          </div>
          <div>
            <h2 className="text-3xl font-bold text-foreground mb-4">Chapter 2: The "Time-Lock" Defense</h2>
            <p className="text-muted-foreground mb-6 leading-relaxed">
              NilStore defeats this with <strong>Proof-of-Delayed-Encode (PoDE)</strong>. 
              When the network challenges a provider, it doesn't just ask "Do you have the data?". 
              It asks: <em>"Can you transform this data using a slow function within 1.1 seconds?"</em>
            </p>
            
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-card p-6 rounded-xl border border-border">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="w-5 h-5 text-purple-500" />
                  <h4 className="font-bold text-foreground">The Function (Argon2id)</h4>
                </div>
                <p className="text-sm text-muted-foreground">
                  We force the CPU to perform a specific calculation that takes exactly <strong>1.0 seconds</strong>. It cannot be sped up (memory-hard).
                </p>
              </div>
              <div className="bg-card p-6 rounded-xl border border-border">
                <div className="flex items-center gap-2 mb-3">
                  <ShieldAlert className="w-5 h-5 text-red-500" />
                  <h4 className="font-bold text-foreground">The Deadline</h4>
                </div>
                <p className="text-sm text-muted-foreground">
                  The network only accepts answers within <strong>1.1 seconds</strong>. This leaves a tiny <strong>100ms buffer</strong>.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Chapter 3: The Simulation */}
      <section className="mb-24">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-3xl font-bold text-foreground">Chapter 3: The Race (Simulation)</h2>
          <span className="px-3 py-1 bg-secondary text-xs rounded-full font-mono border border-border">
            Live Data: 50 Epochs
          </span>
        </div>

        <div className="grid lg:grid-cols-2 gap-8 mb-8">
          {/* Honest Node Lane */}
          <div className="bg-card p-6 rounded-xl border border-border shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <Server className="text-green-500" />
              <div>
                <h3 className="text-lg font-bold text-foreground">Honest Node (Local Disk)</h3>
                <p className="text-xs text-muted-foreground">Read (10ms) + Compute (1000ms) = Success</p>
              </div>
            </div>
            <div className="space-y-3 h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {data.map((row) => (
                <TimeBar 
                  key={row.id} 
                  label={`Epoch ${row.id}`} 
                  read={row.honest.read_ms} 
                  compute={row.honest.compute_ms} 
                  total={row.honest.total_ms}
                  deadline={deadline}
                  isAttacker={false}
                />
              ))}
            </div>
          </div>

          {/* Attacker Node Lane */}
          <div className="bg-card p-6 rounded-xl border border-border shadow-sm">
            <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
              <Wifi className="text-red-500" />
              <div>
                <h3 className="text-lg font-bold text-foreground">Lazy Node (Remote Fetch)</h3>
                <p className="text-xs text-muted-foreground">Fetch (300ms) + Compute (1000ms) = Fail</p>
              </div>
            </div>
            <div className="space-y-3 h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {data.map((row) => (
                <TimeBar 
                  key={row.id} 
                  label={`Epoch ${row.id}`} 
                  read={row.attacker.fetch_ms} 
                  compute={row.attacker.compute_ms} 
                  total={row.attacker.total_ms}
                  deadline={deadline}
                  isAttacker={true}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Chapter 4: The Result */}
      <section>
        <div className="bg-gradient-to-br from-card to-secondary/30 p-8 rounded-2xl border border-border relative overflow-hidden">
          <h2 className="text-2xl font-bold text-foreground mb-4 relative z-10">Chapter 4: The Verdict</h2>
          <p className="text-muted-foreground font-mono leading-relaxed text-sm relative z-10">
            {analysis}
          </p>
          
          <div className="mt-6 flex gap-4 relative z-10">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-500" />
              <span className="text-sm font-bold text-foreground">Honest: 100% Pass</span>
            </div>
            <div className="flex items-center gap-2">
              <XCircle className="w-5 h-5 text-red-500" />
              <span className="text-sm font-bold text-foreground">Attacker: 0% Pass</span>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
};

const TimeBar = ({ label, read, compute, total, deadline, isAttacker }: any) => {
    const success = total <= deadline;
    // Scale visualizations to fit well
    const maxScale = deadline * 1.4;
    const widthPercent = Math.min((total / maxScale) * 100, 100);
    
    return (
        <div className="flex items-center gap-3 text-xs group">
            <span className="w-12 text-muted-foreground font-mono shrink-0 opacity-50">{label}</span>
            
            <div className="flex-1 h-8 bg-secondary/50 rounded-md overflow-hidden relative">
                {/* Deadline Marker */}
                <div 
                    className="absolute top-0 bottom-0 w-[2px] bg-foreground/30 z-20 border-r border-dashed border-background" 
                    style={{ left: `${(deadline / maxScale) * 100}%` }} 
                />
                <div 
                    className="absolute top-0 bottom-0 text-[9px] font-mono text-foreground/50 z-20 pl-1 pt-0.5"
                    style={{ left: `${(deadline / maxScale) * 100}%` }} 
                >
                    LIMIT
                </div>
                
                {/* Bar */}
                <motion.div 
                    initial={{ width: 0 }}
                    whileInView={{ width: `${widthPercent}%` }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    className={`h-full flex items-center relative ${success ? 'bg-green-500/10' : 'bg-red-500/10'}`}
                >
                    {/* Read Segment */}
                    <div style={{ width: `${(read/total)*100}%` }} className={`h-full ${isAttacker ? 'bg-red-500' : 'bg-blue-500'} opacity-80 flex items-center justify-center text-[9px] text-white font-bold overflow-hidden`}>
                        {read > 40 && (isAttacker ? "FETCH" : "READ")}
                    </div>
                    {/* Compute Segment */}
                    <div style={{ width: `${(compute/total)*100}%` }} className="h-full bg-yellow-500 opacity-80 flex items-center justify-center text-[9px] text-black font-bold overflow-hidden">
                        WORK
                    </div>
                </motion.div>
            </div>

            <div className={`w-16 font-mono text-right font-bold ${success ? 'text-green-500' : 'text-red-500'}`}>
                {total.toFixed(0)}ms
            </div>
        </div>
    );
}