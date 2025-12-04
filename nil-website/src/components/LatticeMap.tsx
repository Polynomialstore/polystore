import { useProofs } from '../context/ProofContext';

export function LatticeMap() {
  const { proofs, loading } = useProofs();

  if (loading && proofs.length === 0) return <div>Loading Lattice...</div>;

  // Group by Creator to show "Nodes"
  const nodes: Record<string, number> = {};
  proofs.forEach(p => {
    nodes[p.creator] = (nodes[p.creator] || 0) + 1;
  });

  return (
    <div className="p-4 border rounded shadow-lg bg-slate-900 text-white">
      <h2 className="text-xl font-bold mb-4 text-slate-100">Nil-Lattice Visualization</h2>
      <div className="grid grid-cols-3 gap-4">
        {Object.entries(nodes).map(([creator, count]) => (
            <div key={creator} className="bg-slate-800 p-4 rounded flex flex-col items-center">
                <div className="text-4xl mb-2">📦</div>
                <div className="font-mono text-sm truncate w-full text-center text-slate-300" title={creator}>{creator}</div>
                <div className="text-green-400 font-bold">{count} Proofs</div>
            </div>
        ))}
      </div>
      <div className="mt-6">
        <h3 className="text-lg font-semibold text-slate-100">Recent Proofs</h3>
        <ul className="text-xs font-mono max-h-40 overflow-y-auto text-slate-300">
            {proofs.map(p => (
                <li key={p.id} className="border-b border-slate-700 py-1 flex justify-between">
                    <span>#{p.id.substring(0,4)} | H:{p.block_height} | {p.commitment.substring(0, 10)}...</span>
                    {p.source === 'simulated' && <span className="text-yellow-500 text-[10px] uppercase">[Simulated]</span>}
                </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
