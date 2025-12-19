import simulationData from '../data/adversarial_simulation.json';
import { ShieldAlert, Server, Wifi, Database, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export const AdversarialSimulation = () => {
  const { data, analysis } = simulationData;
  
  // Transform data for Recharts
  const chartData = data.map(d => ({
    epoch: d.epoch,
    Honest: d.honest.balance,
    Remote: d.attacker.balance,
    honestTier: d.honest.tier,
    attackerTier: d.attacker.tier
  }));

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      
      {/* Header */}
      <div className="mb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className="text-5xl font-bold mb-6 text-foreground">Archived Incentive Simulation</h1>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-muted/40 text-xs text-muted-foreground mb-4">
            Remote storage vs local NVMe (not an active threat model)
          </div>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
            This archived simulation compares a local NVMe provider against a remote-storage provider (e.g., S3-backed).
            The takeaway: latency tiers and bandwidth costs make remote-only strategies uncompetitive in the long run.
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
              <p className="text-sm font-bold text-cyan-400">Platinum (example: Block H+1)</p>
            </div>
          </div>
        </div>

        {/* Remote Storage Stats */}
        <div className="bg-card p-6 rounded-xl border border-border shadow-sm">
          <div className="flex items-center gap-2 mb-4 border-b border-border pb-4">
            <Wifi className="text-red-500 w-6 h-6" />
            <div>
                <h3 className="text-lg font-bold text-foreground">Remote Storage (S3)</h3>
                <p className="text-xs text-muted-foreground">Lower Cost, Higher Latency</p>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Final Balance</p>
              <p className="text-3xl font-bold text-red-500">${data[data.length-1].attacker.balance.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Reward Tier</p>
              <p className="text-sm font-bold text-yellow-500">Gold/Fail (example: Block H+10)</p>
            </div>
          </div>
        </div>

        {/* Analysis Card */}
        <div className="bg-secondary/20 p-6 rounded-xl border border-border flex flex-col justify-center">
            <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-yellow-500"/> Incentive Check
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                Even if remote storage is cheaper per GB, the <strong>egress costs</strong> and <strong>tier penalties</strong> from slower retrievals erode margins and make the strategy unattractive over time.
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
                    <span className="text-muted-foreground">Remote</span>
                </div>
            </div>
        </div>
        
        <div className="h-96 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                    data={chartData}
                    margin={{
                        top: 10,
                        right: 30,
                        left: 0,
                        bottom: 0,
                    }}
                >
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                    <XAxis 
                        dataKey="epoch" 
                        stroke="#666" 
                        tick={{fill: '#666', fontSize: 12}}
                        tickLine={false}
                        axisLine={false}
                    />
                    <YAxis 
                        stroke="#666"
                        tick={{fill: '#666', fontSize: 12}}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => `$${value}`}
                    />
                    <Tooltip 
                        contentStyle={{ backgroundColor: '#111', borderColor: '#333', borderRadius: '8px' }}
                        itemStyle={{ fontSize: '12px' }}
                        labelStyle={{ color: '#888', marginBottom: '4px' }}
                        formatter={(value: number) => [`$${value.toFixed(2)}`, ""]}
                    />
                    <Area 
                        type="monotone" 
                        dataKey="Honest" 
                        stackId="1" 
                        stroke="#22c55e" 
                        fill="#22c55e" 
                        fillOpacity={0.2} 
                    />
                    <Area 
                        type="monotone" 
                        dataKey="Remote" 
                        stackId="2" // Separate stacks to compare lines, actually we want comparison not stacking.
                        stroke="#ef4444" 
                        fill="#ef4444" 
                        fillOpacity={0.2} 
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
      </div>

      {/* Narrative Section */}
      <div className="grid md:grid-cols-3 gap-6 mb-12">
        <div className="p-6 rounded-xl border border-border bg-card">
            <div className="mb-4 p-3 bg-blue-500/10 w-fit rounded-lg"><Database className="w-6 h-6 text-blue-500" /></div>
            <h4 className="font-bold text-foreground mb-2">1. The Setup</h4>
            <p className="text-sm text-muted-foreground">
                We simulate 100 epochs. The Honest Node pays for NVMe ($0.02/GB). The Remote Node uses S3 ($0.004/GB), so it appears cheaper at rest.
            </p>
        </div>
        <div className="p-6 rounded-xl border border-border bg-card">
            <div className="mb-4 p-3 bg-purple-500/10 w-fit rounded-lg"><Clock className="w-6 h-6 text-purple-500" /></div>
            <h4 className="font-bold text-foreground mb-2">2. The Execution</h4>
            <p className="text-sm text-muted-foreground">
                Every epoch, the simulation generates retrieval sessions. The Honest node replies instantly (&lt;1s). The Remote node must fetch data on demand, incurring latency (&gt;1s) and egress fees ($0.05/GB).
            </p>
        </div>
        <div className="p-6 rounded-xl border border-border bg-card">
            <div className="mb-4 p-3 bg-green-500/10 w-fit rounded-lg"><ShieldAlert className="w-6 h-6 text-green-500" /></div>
            <h4 className="font-bold text-foreground mb-2">3. The Result</h4>
            <p className="text-sm text-muted-foreground">
                The Honest node earns Platinum rewards. The Remote node falls to Gold/Silver due to latency and bleeds money on egress fees. The chart shows the divergence.
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
