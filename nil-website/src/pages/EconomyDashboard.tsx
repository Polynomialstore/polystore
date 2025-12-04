import { useState, useEffect } from 'react';
import simulationData from '../data/simulation_data.json';
import { TrendingUp, AlertTriangle, HardDrive, Coins, Info, Activity } from 'lucide-react';
import { motion } from 'framer-motion';

export const EconomyDashboard = () => {
  const { data, analysis } = simulationData;
  const maxSupply = Math.max(...data.map(d => d.supply));
  const maxStorage = Math.max(...data.map(d => d.storage_gb));

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      
      {/* Header & Intro */}
      <div className="mb-16 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
                    <div className="flex items-center gap-3 mb-4">
                      <div className="p-3 bg-yellow-500/10 rounded-xl border border-yellow-500/20">
                        <Activity className="w-8 h-8 text-yellow-500" />
                      </div>
                      <h1 className="text-4xl font-bold text-foreground">Network Economy Simulation</h1>
                    </div>
                    
                    <p className="text-xl text-muted-foreground mb-6">
                      Understanding the flow of tokens and data is critical. This dashboard visualizes an 
                      <strong> Agent-Based Simulation (ABS)</strong> of the NilStore economy running over 
                      {data.length} epochs (virtual days).
                    </p>
          
                    <div className="bg-card border border-border p-6 rounded-xl text-sm space-y-4">
                      <h3 className="font-bold text-card-foreground flex items-center gap-2">
                        <Info className="w-4 h-4 text-blue-400"/> How this Simulation Works
                      </h3>
                      <ul className="space-y-2 text-muted-foreground list-disc list-inside">
                        <li><strong>Storage Growth:</strong> Agents (simulated users) upload files based on an adoption curve.</li>
                        <li><strong>Minting (Inflation):</strong> Storage Providers earn newly minted NIL tokens for valid proofs.</li>
                        <li><strong>Slashing (Deflation):</strong> Random "fault events" (epochs #15 & #35) trigger the quadratic slashing mechanism, burning tokens from negligent providers.</li>
                      </ul>
                    </div>
                  </motion.div>
                </div>
          
                {/* Key Metrics */}
                <div className="grid md:grid-cols-4 gap-6 mb-16">
                          <MetricCard 
                              title="Total Storage" 
                              value={`${data[data.length-1].storage_gb.toFixed(2)} GB`} 
                              sub="Accumulated Data (GB)"
                              icon={<HardDrive className="text-blue-500 dark:text-blue-400"/>} 
                              delay={0.1}
                          />
                  
                  <MetricCard 
                      title="Circulating Supply" 
                      value={`${(data[data.length-1].supply / 1000000).toFixed(2)}M NIL`} 
                      sub="Inflationary Reward"
                      icon={<Coins className="text-yellow-600 dark:text-yellow-400"/>} 
                      delay={0.2}
                  />
                  <MetricCard 
                      title="Total Burned" 
                      value={`${data[data.length-1].slashed.toLocaleString()} NIL`} 
                      sub="Deflationary Slash"
                      icon={<AlertTriangle className="text-red-500 dark:text-red-400"/>} 
                      delay={0.3}
                  />
                  <MetricCard 
                      title="Growth Rate" 
                      value="+12.5%" 
                      sub="MoM Capacity"
                      icon={<TrendingUp className="text-green-600 dark:text-green-400"/>} 
                      delay={0.4}
                  />
                </div>
          
                {/* Charts Section */}
                <div className="grid lg:grid-cols-2 gap-8 mb-16">
                  
                  {/* Supply Chart */}
                  <motion.div 
                      initial={{ opacity: 0, x: -20 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      className="bg-card p-8 rounded-2xl border border-border shadow-sm"
                  >
                    <h3 className="text-lg font-bold text-card-foreground mb-2">Token Supply Expansion</h3>
                    <p className="text-xs text-muted-foreground mb-8">Visualizing the inflationary curve vs epoch time.</p>
                    
                    <div className="h-64 flex items-end gap-1 relative px-2 pb-2 border-b border-l border-border">
                      {data.map((d, i) => {
                        const height = (d.supply / maxSupply) * 100;
                        return (
                          <motion.div 
                            key={i} 
                            className="flex-1 flex flex-col justify-end group relative"
                            initial={{ height: 0 }}
                            whileInView={{ height: `${height}%` }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.8, delay: i * 0.01 }}
                          >
                            <div className="w-full h-full bg-gradient-to-t from-yellow-500 to-yellow-300 opacity-80 hover:opacity-100 rounded-t-sm cursor-pointer"></div>
                            
                            {/* Tooltip */}
                            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-popover text-popover-foreground text-xs p-2 rounded border border-border shadow-lg z-20 pointer-events-none whitespace-nowrap">
                              <div className="font-bold text-yellow-500">Epoch {d.epoch}</div>
                              <div>{d.supply.toLocaleString()} NIL</div>
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </motion.div>
          
                  {/* Storage Chart */}
                  <motion.div 
                      initial={{ opacity: 0, x: 20 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      className="bg-card p-8 rounded-2xl border border-border shadow-sm"
                  >
                    <h3 className="text-lg font-bold text-card-foreground mb-2">Storage Capacity vs. Slashing</h3>
                    <p className="text-xs text-muted-foreground mb-8">Blue: Healthy Storage. Red: Slashing Events.</p>
                    
                    <div className="h-64 flex items-end gap-1 relative px-2 pb-2 border-b border-l border-border">
                      {data.map((d, i) => {
                        const height = (d.storage_gb / maxStorage) * 100;
                        const isSlash = d.slashed_epoch > 10; // Threshold for visibility
                        return (
                          <motion.div 
                            key={i} 
                            className="flex-1 flex flex-col justify-end group relative"
                            initial={{ height: 0 }}
                            whileInView={{ height: `${Math.max(height, 5)}%` }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.8, delay: i * 0.01 }}
                          >
                            <div 
                              className={`w-full h-full rounded-t-sm cursor-pointer ${
                                  isSlash 
                                  ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)] animate-pulse' 
                                  : 'bg-blue-500/80 hover:bg-blue-400'
                              }`}
                            ></div>
          
                             {/* Tooltip */}
                             <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-popover text-popover-foreground text-xs p-2 rounded border border-border shadow-lg z-20 pointer-events-none min-w-[120px]">
                              <div className="font-bold text-foreground">Epoch {d.epoch}</div>
                              <div>{d.storage_gb.toFixed(2)} GB</div>
                              {isSlash && <div className="text-red-500 font-bold mt-1">-{d.slashed_epoch} NIL Burned</div>}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </motion.div>
                </div>
          
                {/* Analysis Text */}
                <motion.section 
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  className="bg-gradient-to-br from-card to-secondary/50 p-8 rounded-2xl border border-border mb-16 relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                      <Activity className="w-32 h-32" />
                  </div>
                  <h3 className="text-2xl font-bold text-foreground mb-4 relative z-10">🤖 Simulation Analysis</h3>
                  <p className="text-muted-foreground leading-relaxed font-mono text-sm relative z-10">
                    {analysis}
                  </p>
                </motion.section>
          
                {/* Data Table */}
                <section>
                  <h3 className="text-xl font-bold text-foreground mb-6">Epoch Detail Log</h3>
                  <div className="bg-card rounded-xl border border-border overflow-hidden">
                    <div className="overflow-x-auto max-h-96">
                      <table className="w-full text-sm text-left text-muted-foreground">
                        <thead className="text-xs text-foreground uppercase bg-muted/50 sticky top-0 z-10">
                          <tr>
                            <th className="px-6 py-3">Epoch</th>
                            <th className="px-6 py-3">Storage (GB)</th>
                            <th className="px-6 py-3">Supply (NIL)</th>
                            <th className="px-6 py-3">Rewards</th>
                            <th className="px-6 py-3">Burned</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {data.map((row) => (
                            <tr key={row.epoch} className={`hover:bg-muted/50 transition-colors ${row.slashed_epoch > 10 ? 'bg-red-500/10 dark:bg-red-900/20' : ''}`}>
                              <td className="px-6 py-4 font-medium text-foreground">#{row.epoch}</td>
                              <td className="px-6 py-4">{row.storage_gb.toFixed(3)}</td>
                              <td className="px-6 py-4 font-mono text-yellow-600 dark:text-yellow-500">{row.supply.toLocaleString()}</td>
                              <td className="px-6 py-4 text-green-600 dark:text-green-400">+{row.rewards_epoch.toFixed(1)}</td>
                              <td className="px-6 py-4 font-bold">
                                  {row.slashed_epoch > 0 
                                      ? <span className="text-red-500 dark:text-red-400">-{row.slashed_epoch.toFixed(1)}</span> 
                                      : <span className="opacity-20">-</span>
                                  }
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              </div>
            );
          };
          
          const MetricCard = ({ title, value, icon, sub, delay }: any) => (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              transition={{ delay, duration: 0.4 }}
              className="bg-card p-6 rounded-xl border border-border flex items-center justify-between hover:border-primary/50 transition-colors group shadow-sm"
            >
              <div>
                <p className="text-sm text-muted-foreground font-medium mb-1">{title}</p>
                <p className="text-2xl font-bold text-foreground group-hover:text-primary transition-colors">{value}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">{sub}</p>
              </div>
              <div className="p-3 bg-secondary/50 rounded-lg group-hover:bg-primary/10 transition-colors">
                {icon}
              </div>
            </motion.div>
          );
          