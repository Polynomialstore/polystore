import simulationData from '../data/adversarial_simulation.json'
import { ShieldAlert, Server, Wifi, Database, Clock } from 'lucide-react'
import { motion } from 'framer-motion'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export const AdversarialSimulation = () => {
  const { data, analysis } = simulationData
  const chartTickColor = 'hsl(var(--muted-foreground))'
  const chartAxisColor = 'hsl(var(--border))'
  const chartGridColor = 'hsl(var(--border) / 0.35)'
  const honestColor = 'hsl(var(--accent))'
  const remoteColor = 'hsl(var(--destructive))'
  
  // Transform data for Recharts
  const chartData = data.map(d => ({
    epoch: d.epoch,
    Honest: d.honest.balance,
    Remote: d.attacker.balance,
    honestTier: d.honest.tier,
    attackerTier: d.attacker.tier
  }))

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      
      {/* Header */}
      <div className="mb-12 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="mx-auto mb-4 inline-flex items-center border border-border/50 bg-background/40 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
            /sim/incentives_archive
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold mb-4 text-foreground tracking-tight">
            Archived Incentive Simulation
          </h1>
          <div className="mx-auto mb-4 inline-flex items-center gap-2 border border-border/50 bg-muted/20 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
            Remote storage vs local NVMe (not an active threat model)
          </div>
          <p className="text-base sm:text-lg text-muted-foreground max-w-3xl mx-auto leading-relaxed">
            This archived simulation compares a local NVMe provider against a remote-storage provider (e.g., S3-backed).
            The takeaway: latency tiers and bandwidth costs make remote-only strategies uncompetitive in the long run.
          </p>
        </motion.div>
      </div>

      {/* Stats Grid */}
      <div className="grid lg:grid-cols-3 gap-8 mb-12">
        {/* Honest Stats */}
        <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--accent)_/_0.06)]">
          <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
          <div className="relative flex items-center gap-3 mb-4 border-b border-border/50 pb-4">
            <div className="glass-panel industrial-border p-2">
              <Server className="text-accent w-6 h-6" />
            </div>
            <div>
                <h3 className="text-lg font-bold text-foreground">Honest Node (NVMe)</h3>
                <p className="text-[11px] font-mono-data text-muted-foreground uppercase tracking-[0.2em]">High performance • high reward</p>
            </div>
          </div>
          <div className="relative space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Final Balance</p>
              <p className="text-3xl font-extrabold text-accent font-mono-data">${data[data.length-1].honest.balance.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Reward Tier</p>
              <p className="text-[11px] font-bold text-accent font-mono-data uppercase tracking-[0.2em]">Platinum (example: Block H+1)</p>
            </div>
          </div>
        </div>

        {/* Remote Storage Stats */}
        <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--destructive)_/_0.06)]">
          <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
          <div className="relative flex items-center gap-3 mb-4 border-b border-border/50 pb-4">
            <div className="glass-panel industrial-border p-2">
              <Wifi className="text-destructive w-6 h-6" />
            </div>
            <div>
                <h3 className="text-lg font-bold text-foreground">Remote Storage (S3)</h3>
                <p className="text-[11px] font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Lower cost • higher latency</p>
            </div>
          </div>
          <div className="relative space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Final Balance</p>
              <p className="text-3xl font-extrabold text-destructive font-mono-data">${data[data.length-1].attacker.balance.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Reward Tier</p>
              <p className="text-[11px] font-bold text-primary font-mono-data uppercase tracking-[0.2em]">Gold/Fail (example: Block H+10)</p>
            </div>
          </div>
        </div>

        {/* Analysis Card */}
        <div className="relative overflow-hidden glass-panel industrial-border p-6 flex flex-col justify-center shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
            <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
            <h3 className="relative font-bold text-foreground mb-4 flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-primary"/> Incentive Check
            </h3>
            <p className="relative text-sm text-muted-foreground leading-relaxed mb-4">
                Even if remote storage is cheaper per GB, the <strong>egress costs</strong> and <strong>tier penalties</strong> from slower retrievals erode margins and make the strategy unattractive over time.
            </p>
            <div className="relative glass-panel industrial-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground">
                PROFIT = REWARDS - (STORAGE_COST + EGRESS_COST)
            </div>
        </div>
      </div>

      {/* P&L Chart */}
      <div className="relative overflow-hidden glass-panel industrial-border p-8 mb-12 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
        <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
        <div className="relative flex justify-between items-center mb-8 gap-4">
            <h3 className="text-xl font-bold text-foreground">Cumulative Profit & Loss (P&L)</h3>
            <div className="flex gap-4 text-[11px] font-mono-data uppercase tracking-[0.2em]">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-accent rounded-none pulse-status"></span>
                    <span className="text-muted-foreground">Honest</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-destructive rounded-none"></span>
                    <span className="text-muted-foreground">Remote</span>
                </div>
            </div>
        </div>
        
        <div className="relative h-96 w-full">
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
                    <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} vertical={false} />
                    <XAxis 
                        dataKey="epoch" 
                        stroke={chartAxisColor} 
                        tick={{ fill: chartTickColor, fontSize: 12 }}
                        tickLine={false}
                        axisLine={false}
                    />
                    <YAxis 
                        stroke={chartAxisColor}
                        tick={{ fill: chartTickColor, fontSize: 12 }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => `$${value}`}
                    />
                    <Tooltip 
                        contentStyle={{ backgroundColor: 'hsl(var(--card) / var(--glass-opacity))', borderColor: chartAxisColor, borderRadius: '0px', backdropFilter: 'blur(12px)' }}
                        itemStyle={{ fontSize: '12px', color: 'hsl(var(--foreground))', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}
                        labelStyle={{ color: chartTickColor, marginBottom: '4px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}
                        formatter={(value: number) => [`$${value.toFixed(2)}`, ""]}
                    />
                    <Area 
                        type="monotone" 
                        dataKey="Honest" 
                        stackId="1" 
                        stroke={honestColor} 
                        fill={honestColor} 
                        fillOpacity={0.2} 
                    />
                    <Area 
                        type="monotone" 
                        dataKey="Remote" 
                        stackId="2" // Separate stacks to compare lines, actually we want comparison not stacking.
                        stroke={remoteColor} 
                        fill={remoteColor} 
                        fillOpacity={0.2} 
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
      </div>

      {/* Narrative Section */}
      <div className="grid md:grid-cols-3 gap-6 mb-12">
        <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)]">
            <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
            <div className="relative mb-4 w-fit glass-panel industrial-border p-3">
              <Database className="w-6 h-6 text-primary" />
            </div>
            <h4 className="font-bold text-foreground mb-2">1. The Setup</h4>
            <p className="text-sm text-muted-foreground">
                We simulate 100 epochs. The Honest Node pays for NVMe ($0.02/GB). The Remote Node uses S3 ($0.004/GB), so it appears cheaper at rest.
            </p>
        </div>
        <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)]">
            <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
            <div className="relative mb-4 w-fit glass-panel industrial-border p-3">
              <Clock className="w-6 h-6 text-primary" />
            </div>
            <h4 className="font-bold text-foreground mb-2">2. The Execution</h4>
            <p className="text-sm text-muted-foreground">
                Every epoch, the simulation generates retrieval sessions. The Honest node replies instantly (&lt;1s). The Remote node must fetch data on demand, incurring latency (&gt;1s) and egress fees ($0.05/GB).
            </p>
        </div>
        <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)]">
            <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
            <div className="relative mb-4 w-fit glass-panel industrial-border p-3">
              <ShieldAlert className="w-6 h-6 text-accent" />
            </div>
            <h4 className="font-bold text-foreground mb-2">3. The Result</h4>
            <p className="text-sm text-muted-foreground">
                The Honest node earns Platinum rewards. The Remote node falls to Gold/Silver due to latency and bleeds money on egress fees. The chart shows the divergence.
            </p>
        </div>
      </div>

      <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)]">
        <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
        <h3 className="font-bold text-foreground mb-4">Automated Analysis Log</h3>
        <p className="relative font-mono-data text-sm text-muted-foreground leading-relaxed">
            {analysis}
        </p>
      </div>
    </div>
  )
}
