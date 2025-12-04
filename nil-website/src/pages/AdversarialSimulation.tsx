import { useState, useEffect } from 'react';
import simulationData from '../data/adversarial_simulation.json';
import { ShieldAlert, CheckCircle, XCircle, Clock, Server, Wifi } from 'lucide-react';
import { motion } from 'framer-motion';

export const AdversarialSimulation = () => {
  const { data, analysis, meta } = simulationData;
  const deadline = meta.parameters.deadline_ms;

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-foreground">Adversarial Resilience Simulation</h1>
        <p className="text-xl text-muted-foreground">
          Simulating the "Lazy Provider" attack vector: Can a node outsource storage to S3/IPFS and still pass the Proof-of-Delayed-Encode (PoDE) check?
        </p>
      </div>

      {/* Interactive Viz */}
      <div className="grid lg:grid-cols-2 gap-8 mb-12">
        {/* Honest Node Lane */}
        <div className="bg-card p-6 rounded-xl border border-border">
          <div className="flex items-center gap-2 mb-6">
            <Server className="text-green-500" />
            <h3 className="text-xl font-bold text-foreground">Honest Node (Local)</h3>
          </div>
          <div className="space-y-2 h-96 overflow-y-auto pr-2 custom-scrollbar">
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
        <div className="bg-card p-6 rounded-xl border border-border">
          <div className="flex items-center gap-2 mb-6">
            <Wifi className="text-red-500" />
            <h3 className="text-xl font-bold text-foreground">Adversarial Node (Remote)</h3>
          </div>
          <div className="space-y-2 h-96 overflow-y-auto pr-2 custom-scrollbar">
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

      {/* Analysis */}
      <div className="bg-secondary/20 p-8 rounded-2xl border border-border mb-12">
        <h3 className="text-2xl font-bold text-foreground mb-4 flex items-center gap-2">
          <ShieldAlert className="text-yellow-500"/> Cryptographic Defense Analysis
        </h3>
        <p className="text-muted-foreground font-mono leading-relaxed">
          {analysis}
        </p>
      </div>

      {/* Technical Explainer */}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="p-6 rounded-xl border border-border bg-card">
            <h4 className="font-bold text-foreground mb-2">1. The Challenge</h4>
            <p className="text-sm text-muted-foreground">
                The network sends a unique salt. The node must compute `Argon2id(Data + Salt)`. This function is memory-hard and tuned to take exactly {meta.parameters.pode_work_ms}ms.
            </p>
        </div>
        <div className="p-6 rounded-xl border border-border bg-card">
            <h4 className="font-bold text-foreground mb-2">2. The Trap</h4>
            <p className="text-sm text-muted-foreground">
                The submission deadline is strict ({deadline}ms). There is no room for network latency.
            </p>
        </div>
        <div className="p-6 rounded-xl border border-border bg-card">
            <h4 className="font-bold text-foreground mb-2">3. The Fail</h4>
            <p className="text-sm text-muted-foreground">
                An attacker fetching data remotely adds ~{meta.parameters.network_latency_ms}ms of latency. `Fetch + Compute > Deadline`. The proof is rejected.
            </p>
        </div>
      </div>
    </div>
  );
};

const TimeBar = ({ label, read, compute, total, deadline, isAttacker }: any) => {
    const success = total <= deadline;
    const widthPercent = Math.min((total / (deadline * 1.5)) * 100, 100);
    
    return (
        <div className="flex items-center gap-2 text-xs">
            <span className="w-16 text-muted-foreground font-mono">{label}</span>
            <div className="flex-1 h-6 bg-secondary rounded-md overflow-hidden relative">
                {/* Deadline Marker */}
                <div 
                    className="absolute top-0 bottom-0 w-[2px] bg-foreground z-10" 
                    style={{ left: `${(deadline / (deadline * 1.5)) * 100}%` }} 
                    title="Deadline"
                />
                
                {/* Bar */}
                <motion.div 
                    initial={{ width: 0 }}
                    whileInView={{ width: `${widthPercent}%` }}
                    className={`h-full flex items-center ${success ? 'bg-green-500/50' : 'bg-red-500/50'}`}
                >
                    <div style={{ width: `${(read/total)*100}%` }} className={`h-full ${isAttacker ? 'bg-red-500' : 'bg-blue-500'} opacity-50`} title={isAttacker ? "Network Fetch" : "Disk Read"} />
                    <div style={{ width: `${(compute/total)*100}%` }} className="h-full bg-yellow-500 opacity-50" title="Argon2id Compute" />
                </motion.div>
            </div>
            <span className={`w-16 font-mono text-right ${success ? 'text-green-500' : 'text-red-500'}`}>
                {total.toFixed(0)}ms
            </span>
            {success ? <CheckCircle className="w-4 h-4 text-green-500"/> : <XCircle className="w-4 h-4 text-red-500"/>}
        </div>
    );
}
