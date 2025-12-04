import { useProofs } from "../context/ProofContext";
import { Trophy, Medal, Award } from "lucide-react";

export const Leaderboard = () => {
  const { proofs } = useProofs();

  // Aggregate proofs by creator
  const stats: Record<string, { count: number; lastHeight: number }> = {};
  
  proofs.forEach((p) => {
    if (!stats[p.creator]) {
      stats[p.creator] = { count: 0, lastHeight: 0 };
    }
    stats[p.creator].count += 1;
    const h = parseInt(p.block_height);
    if (!isNaN(h) && h > stats[p.creator].lastHeight) {
      stats[p.creator].lastHeight = h;
    }
  });

  const ranked = Object.entries(stats)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([address, stat], index) => ({
      rank: index + 1,
      address,
      proofs: stat.count,
      lastActive: stat.lastHeight,
      points: stat.count * 10 // 10 points per proof
    }));

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold mb-4 text-foreground">"Store Wars" Leaderboard</h1>
        <p className="text-xl text-muted-foreground">
          Top Storage Providers competing for the 1 Petabyte Goal.
        </p>
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-muted/50 text-foreground font-medium uppercase text-xs tracking-wider">
            <tr>
              <th className="px-6 py-4">Rank</th>
              <th className="px-6 py-4">Storage Provider</th>
              <th className="px-6 py-4 text-right">Proofs</th>
              <th className="px-6 py-4 text-right">Points</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ranked.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                  No data available yet. Start the chain and submit proofs!
                </td>
              </tr>
            ) : (
              ranked.map((node) => (
                <tr key={node.address} className="hover:bg-muted/50 transition-colors text-foreground">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {node.rank === 1 && <Trophy className="w-5 h-5 text-yellow-400" />}
                      {node.rank === 2 && <Medal className="w-5 h-5 text-muted-foreground" />}
                      {node.rank === 3 && <Award className="w-5 h-5 text-amber-600" />}
                      {node.rank > 3 && <span className="font-mono text-muted-foreground">#{node.rank}</span>}
                    </div>
                  </td>
                  <td className="px-6 py-4 font-mono text-sm">
                    {node.address}
                    {node.rank === 1 && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                        Top Earner
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right font-mono">{node.proofs}</td>
                  <td className="px-6 py-4 text-right font-bold text-primary">
                    {node.points.toLocaleString()} PTS
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
