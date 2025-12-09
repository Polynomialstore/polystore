import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, Cell } from 'recharts';
import { ProofRow } from '../hooks/useProofs';

interface Props {
  proofs: ProofRow[];
}

const tierMap: Record<string, number> = {
  'Platinum': 3,
  'Gold': 2,
  'Silver': 1,
  'Fail': 0
};

export function DealLivenessHeatmap({ proofs }: Props) {
  // Sort proofs by block height (descending)
  const sortedProofs = [...proofs].sort((a, b) => b.blockHeight - a.blockHeight);
  
  // Transform for ScatterChart
  const data = sortedProofs.map(p => ({
    block: p.blockHeight,
    tierValue: tierMap[p.tier || 'Fail'] ?? 0,
    tierLabel: p.tier || 'Unknown',
    valid: p.valid,
    creator: p.creator,
    id: p.id
  }));

  if (data.length === 0) {
      return (
          <div className="h-32 bg-gray-950/20 border border-gray-800 border-dashed rounded flex items-center justify-center text-xs text-gray-600">
              No proofs recorded yet for this deal.
          </div>
      );
  }

  return (
    <div className="h-64 w-full bg-gray-950/40 border border-gray-800 rounded-xl p-4">
        <h4 className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">Liveness History</h4>
        <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <XAxis 
                    type="number" 
                    dataKey="block" 
                    name="Block Height" 
                    domain={['auto', 'auto']}
                    tick={{ fill: '#666', fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: '#333' }}
                />
                <YAxis 
                    type="number" 
                    dataKey="tierValue" 
                    name="Tier" 
                    domain={[0, 3]}
                    ticks={[0, 1, 2, 3]}
                    tickFormatter={(val) => {
                        const keys = Object.keys(tierMap);
                        return keys.find(k => tierMap[k] === val) || '';
                    }}
                    tick={{ fill: '#666', fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                />
                <ZAxis type="number" range={[50, 50]} />
                <Tooltip 
                    cursor={{ strokeDasharray: '3 3' }}
                    content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                            const d = payload[0].payload;
                            return (
                                <div className="bg-gray-900 border border-gray-700 p-2 rounded shadow-xl text-xs">
                                    <div className="font-bold text-white mb-1">Block {d.block}</div>
                                    <div className={`font-mono ${d.valid ? 'text-green-400' : 'text-red-400'}`}>
                                        {d.valid ? 'VALID' : 'INVALID'}
                                    </div>
                                    <div className="text-gray-400">Tier: {d.tierLabel}</div>
                                    <div className="text-gray-500 truncate max-w-[150px]">Prov: {d.creator}</div>
                                </div>
                            );
                        }
                        return null;
                    }}
                />
                <Scatter name="Proofs" data={data}>
                    {data.map((entry, index) => (
                        <Cell 
                            key={`cell-${index}`} 
                            fill={entry.valid ? (
                                entry.tierLabel === 'Platinum' ? '#22d3ee' : // Cyan
                                entry.tierLabel === 'Gold' ? '#fbbf24' : // Yellow
                                entry.tierLabel === 'Silver' ? '#94a3b8' : // Slate
                                '#f87171' // Red (Fail/Valid but slow?)
                            ) : '#ef4444'} // Red (Invalid)
                        />
                    ))}
                </Scatter>
            </ScatterChart>
        </ResponsiveContainer>
    </div>
  );
}
