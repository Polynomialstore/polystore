import simulationData from '../data/adversarial_simulation.json';
import { ShieldAlert, Server, Wifi, Database, Clock } from 'lucide-react';
import { motion } from 'framer-motion';

export const AdversarialSimulation = () => {
  const { data, analysis } = simulationData;
  
  // Calculate max balance for chart scaling
  // Use a safe default if data is empty, though it shouldn't be.
  // Assuming simulation always returns positive balances for Honest, but Attacker might go negative?
  // Let's find the absolute max range.
  const maxBalance = Math.max(
    ...data.map(d => Math.max(d.honest.balance, d.attacker.balance)),
    100 // Ensure at least 100 base
  );

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      
      {/* Header */}
      <div className="mb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className="text-5xl font-bold mb-6 text-foreground">The "Lazy Provider" Attack</h1>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
            Can a storage node cheat by outsourcing storage to a cheap, slow, centralized cloud service (like S3) instead of using high-performance local hardware? 
            <br/>
            <strong>Spoiler: The math makes it unprofitable.</strong>
          </p>
        </motion.div>
      </div>

      {/* Stats Grid */}
      <div className="grid lg:grid-cols-3 gap-8 mb-12">
        {/* Honest Stats */}
        <div className="bg-card p-6 rounded-xl border border-border shadow-sm">
          <div className="flex items-center gap-2 mb-4 border-b border-border pb-4">
            <Server className="text-green-500 w-6 h-6" />
            <div>
                <h3 className="text-lg font-bold text-foreground">Honest Node (NVMe)</h3>
                <p className="text-xs text-muted-foreground">High Performance, High Reward</p>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Final Balance</p>
              <p className="text-3xl font-bold text-green-500">${data[data.length-1].honest.balance.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Reward Tier</p>
              <p className="text-sm font-bold text-cyan-400">Platinum (Block H+1)</p>
            </div>
          </div>
        </div>

        {/* Attacker Stats */}
        <div className="bg-card p-6 rounded-xl border border-border shadow-sm">
          <div className="flex items-center gap-2 mb-4 border-b border-border pb-4">
            <Wifi className="text-red-500 w-6 h-6" />
            <div>
                <h3 className="text-lg font-bold text-foreground">Lazy Provider (S3)</h3>
                <p className="text-xs text-muted-foreground">Low Cost, High Latency</p>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Final Balance</p>
              <p className="text-3xl font-bold text-red-500">${data[data.length-1].attacker.balance.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Reward Tier</p>
              <p className="text-sm font-bold text-yellow-500">Gold/Fail (Block H+10)</p>
            </div>
          </div>
        </div>

        {/* Analysis Card */}
        <div className="bg-secondary/20 p-6 rounded-xl border border-border flex flex-col justify-center">
            <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-yellow-500"/> Economic Defense
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                The simulation proves that while S3 storage is cheaper per GB, the <strong>Bandwidth Egress Costs</strong> required to answer challenges, combined with <strong>Tiered Reward Penalties</strong> (dropping from Platinum to Gold), make the attack net-negative.
            </p>
            <div className="text-xs font-mono bg-background/50 p-2 rounded border border-border">
                PROFIT = REWARDS - (STORAGE_COST + EGRESS_COST)
            </div>
        </div>
      </div>

      {/* P&L Chart */}
      <div className="bg-card p-8 rounded-2xl border border-border mb-12 shadow-sm overflow-hidden">
        <div className="flex justify-between items-center mb-8">
            <h3 className="text-xl font-bold text-foreground">Cumulative Profit & Loss (P&L)</h3>
            <div className="flex gap-4 text-sm">
                <div className="flex items-center gap-2">
                    <span className="w-3 h-3 bg-green-500 rounded-full"></span>
                    <span className="text-muted-foreground">Honest</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-3 h-3 bg-red-500 rounded-full"></span>
                    <span className="text-muted-foreground">Attacker</span>
                </div>
            </div>
        </div>
        
        <div className="h-96 relative flex items-end gap-1 border-b border-l border-border p-4">
            {/* Baseline (Break even) at roughly 50% height if we assume balanced start */}
            {/* We map values relative to maxBalance. Range 0 to maxBalance. */}
            
            {data.map((d, i) => {
                const hHeight = (d.honest.balance / maxBalance) * 90;
                const aHeight = (d.attacker.balance / maxBalance) * 90;
                
                return (
                    <div key={d.epoch} className="flex-1 flex flex-col justify-end gap-1 relative group h-full">
                        {/* Honest Bar */}
                        <motion.div 
                            initial={{ height: 0 }}
                            whileInView={{ height: `${Math.max(hHeight, 2)}%` }}
                            transition={{ duration: 0.5, delay: i * 0.005 }}
                            className="w-full bg-green-500/50 rounded-t-sm absolute bottom-0 z-10 group-hover:bg-green-400"
                        />
                        {/* Attacker Bar */}
                        <motion.div 
                            initial={{ height: 0 }}
                            whileInView={{ height: `${Math.max(aHeight, 2)}%` }}
                            transition={{ duration: 0.5, delay: i * 0.005 }}
                            className="w-full bg-red-500/50 rounded-t-sm absolute bottom-0 z-20 mix-blend-multiply group-hover:bg-red-400"
                        />
                        
                        {/* Tooltip */}
                        <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 bg-popover text-popover-foreground text-xs p-3 rounded-lg border border-border shadow-xl z-50 whitespace-nowrap mb-2">
                            <div className="font-bold text-foreground mb-1">Epoch {d.epoch}</div>
                            <div className="flex justify-between gap-4">
                                <span className="text-green-500 font-mono">Honest: ${d.honest.balance.toFixed(2)}</span>
                                <span className="text-xs opacity-70">{d.honest.tier}</span>
                            </div>
                            <div className="flex justify-between gap-4">
                                <span className="text-red-500 font-mono">Attacker: ${d.attacker.balance.toFixed(2)}</span>
                                <span className="text-xs opacity-70">{d.attacker.tier}</span>
                            </div>
                        </div>
                    </div>
                )
            })}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground mt-4 font-mono">
            <span>Epoch 1</span>
            <span>Epoch {data.length}</span>
        </div>
      </div>

      {/* Narrative Section */}
      <div className="grid md:grid-cols-3 gap-6 mb-12">
        <div className="p-6 rounded-xl border border-border bg-card">
            <div className="mb-4 p-3 bg-blue-500/10 w-fit rounded-lg"><Database className="w-6 h-6 text-blue-500" /></div>
            <h4 className="font-bold text-foreground mb-2">1. The Setup</h4>
            <p className="text-sm text-muted-foreground">
                We simulate 100 epochs. The Honest Node pays for NVMe ($0.02/GB). The Attacker uses S3 ($0.004/GB). The Attacker seems to have a cost advantage.
            </p>
        </div>
        <div className="p-6 rounded-xl border border-border bg-card">
            <div className="mb-4 p-3 bg-purple-500/10 w-fit rounded-lg"><Clock className="w-6 h-6 text-purple-500" /></div>
            <h4 className="font-bold text-foreground mb-2">2. The Execution</h4>
            <p className="text-sm text-muted-foreground">
                Every epoch, the network challenges the nodes. The Honest node replies instantly (&lt;1s). The Attacker must fetch data, incurring latency (&gt;1s) and Egress Fees ($0.05/GB).
            </p>
        </div>
        <div className="p-6 rounded-xl border border-border bg-card">
            <div className="mb-4 p-3 bg-green-500/10 w-fit rounded-lg"><ShieldAlert className="w-6 h-6 text-green-500" /></div>
            <h4 className="font-bold text-foreground mb-2">3. The Result</h4>
            <p className="text-sm text-muted-foreground">
                The Honest node earns Platinum rewards. The Attacker falls to Gold/Silver due to latency and bleeds money on egress fees. The chart shows the divergence.
            </p>
        </div>
      </div>

      <div className="bg-card p-6 rounded-xl border border-border">
        <h3 className="font-bold text-foreground mb-4">Automated Analysis Log</h3>
        <p className="font-mono text-sm text-muted-foreground leading-relaxed">
            {analysis}
        </p>
      </div>
    </div>
  );
};
