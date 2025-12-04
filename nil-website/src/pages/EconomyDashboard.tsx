import { useState, useEffect } from 'react';
import simulationData from '../data/simulation_data.json';
import { TrendingUp, AlertTriangle, HardDrive, Coins } from 'lucide-react';

export const EconomyDashboard = () => {
  const { data, analysis } = simulationData;
  const maxSupply = Math.max(...data.map(d => d.supply));
  const maxStorage = Math.max(...data.map(d => d.storage_gb));

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-slate-100">Network Economy Simulation</h1>
        <p className="text-xl text-muted-foreground">
          Analysis of the "Store Wars" Testnet economic incentives, supply expansion, and slashing mechanics over {data.length} epochs.
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid md:grid-cols-4 gap-6 mb-12">
        <Card title="Total Storage" value={`${data[data.length-1].storage_gb.toFixed(2)} GB`} icon={<HardDrive className="text-blue-400"/>} />
        <Card title="Circulating Supply" value={`${data[data.length-1].supply.toLocaleString()} NIL`} icon={<Coins className="text-yellow-400"/>} />
        <Card title="Total Burned" value={`${data[data.length-1].slashed.toLocaleString()} NIL`} icon={<AlertTriangle className="text-red-400"/>} />
        <Card title="Growth Rate" value="+12.5%" icon={<TrendingUp className="text-green-400"/>} />
      </div>

      {/* Charts Row */}
      <div className="grid lg:grid-cols-2 gap-8 mb-12">
        {/* Supply Chart */}
        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
          <h3 className="text-lg font-bold text-slate-100 mb-6">Token Supply Expansion</h3>
          <div className="h-64 flex items-end gap-1 relative">
            {data.map((d, i) => {
              const height = (d.supply / maxSupply) * 100;
              return (
                <div key={i} className="flex-1 flex flex-col justify-end group relative">
                  <div 
                    className="bg-yellow-500/80 hover:bg-yellow-400 transition-all rounded-t-sm"
                    style={{ height: `${height}%` }}
                  ></div>
                  {/* Tooltip */}
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-black text-xs p-2 rounded whitespace-nowrap z-10 border border-slate-700">
                    Epoch {d.epoch}: {d.supply.toLocaleString()} NIL
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-slate-500 mt-2 font-mono">
            <span>Epoch 1</span>
            <span>Epoch {data.length}</span>
          </div>
        </div>

        {/* Storage & Slashing Chart */}
        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
          <h3 className="text-lg font-bold text-slate-100 mb-6">Storage Growth vs. Slashing Events</h3>
          <div className="h-64 flex items-end gap-1 relative">
            {data.map((d, i) => {
              const height = (d.storage_gb / maxStorage) * 100;
              const isSlash = d.slashed_epoch > 0;
              return (
                <div key={i} className="flex-1 flex flex-col justify-end group relative">
                  <div 
                    className={`${isSlash ? 'bg-red-500' : 'bg-blue-500/80'} hover:opacity-80 transition-all rounded-t-sm`}
                    style={{ height: `${Math.max(height, 5)}%` }} // Ensure visibility
                  ></div>
                   {/* Tooltip */}
                   <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-black text-xs p-2 rounded whitespace-nowrap z-10 border border-slate-700">
                    {d.storage_gb.toFixed(2)} GB
                    {isSlash && <span className="text-red-400 block">-{d.slashed_epoch} NIL Slashed</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-slate-500 mt-2 font-mono">
            <span>Epoch 1</span>
            <span>Epoch {data.length}</span>
          </div>
        </div>
      </div>

      {/* Analysis Text */}
      <section className="bg-slate-950 p-8 rounded-2xl border border-slate-800">
        <h3 className="text-2xl font-bold text-slate-100 mb-4">Automated Analysis</h3>
        <p className="text-slate-300 leading-relaxed font-mono text-sm">
          {analysis}
        </p>
      </section>

      {/* Data Table */}
      <section className="mt-12">
        <h3 className="text-xl font-bold text-slate-100 mb-6">Epoch Detail Log</h3>
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-slate-400">
              <thead className="text-xs text-slate-200 uppercase bg-slate-950">
                <tr>
                  <th className="px-6 py-3">Epoch</th>
                  <th className="px-6 py-3">Storage (GB)</th>
                  <th className="px-6 py-3">Supply (NIL)</th>
                  <th className="px-6 py-3">Rewards</th>
                  <th className="px-6 py-3">Burned</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.epoch} className="border-b border-slate-800 hover:bg-slate-800/50">
                    <td className="px-6 py-4 font-medium text-slate-200">#{row.epoch}</td>
                    <td className="px-6 py-4">{row.storage_gb.toFixed(3)}</td>
                    <td className="px-6 py-4 font-mono text-yellow-500">{row.supply.toLocaleString()}</td>
                    <td className="px-6 py-4 text-green-400">+{row.rewards_epoch.toFixed(1)}</td>
                    <td className="px-6 py-4 text-red-400">
                        {row.slashed_epoch > 0 ? `-${row.slashed_epoch.toFixed(1)}` : '-'}
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

const Card = ({ title, value, icon }: any) => (
  <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 flex items-center justify-between">
    <div>
      <p className="text-sm text-slate-400 font-medium mb-1">{title}</p>
      <p className="text-2xl font-bold text-slate-100">{value}</p>
    </div>
    <div className="p-3 bg-slate-800 rounded-lg">
      {icon}
    </div>
  </div>
);
