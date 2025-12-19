import { useEffect, useState } from "react";
import { Trophy, Medal, Award, HardDrive, Activity, Server } from "lucide-react";
import { appConfig } from "../config";

interface Provider {
  address: string;
  total_storage: string;
  used_storage: string;
  capabilities: string;
  status: string;
}

export const Leaderboard = () => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/providers`)
      .then(res => res.json())
      .then(data => {
        setProviders(data.providers || []);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch providers:", err);
        setLoading(false);
      });
  }, []);

  // Sort by Total Storage (desc)
  const ranked = [...providers].sort((a, b) => parseInt(b.total_storage) - parseInt(a.total_storage));

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold mb-4 text-foreground">Storage Providers Network</h1>
        <p className="text-xl text-muted-foreground">
          Active providers registered on-chain. Ranked by reported capacity and status.
        </p>
      </div>

      {loading ? (
        <div className="text-center text-muted-foreground animate-pulse">Syncing with nilchain LCD...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {ranked.length === 0 ? (
             <div className="col-span-full text-center py-12 bg-card rounded-2xl border border-border text-muted-foreground">
               No providers detected. Ensure the devnet hub is running and providers are registered.
             </div>
          ) : (
            ranked.map((node, index) => (
              <div key={node.address} className="bg-card border border-border rounded-xl p-6 hover:shadow-lg transition-shadow relative overflow-hidden group">
                {/* Rank Badge */}
                <div className="absolute top-4 right-4">
                   {index === 0 && <Trophy className="w-6 h-6 text-yellow-400" />}
                   {index === 1 && <Medal className="w-6 h-6 text-gray-400" />}
                   {index === 2 && <Award className="w-6 h-6 text-amber-600" />}
                </div>

                <div className="flex items-center gap-3 mb-4">
                  <div className={`p-3 rounded-lg ${node.status === 'Active' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                    <Server className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Provider Address</div>
                    <div className="font-mono text-sm text-foreground truncate w-40" title={node.address}>
                      {node.address.substring(0, 12)}...
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between items-center p-3 bg-muted/30 rounded-lg">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <HardDrive className="w-4 h-4" />
                      Capacity
                    </div>
                    <div className="font-mono font-medium text-foreground">
                      {(parseInt(node.total_storage) / (1024 * 1024 * 1024)).toFixed(2)} GB
                    </div>
                  </div>

                  <div className="flex justify-between items-center p-3 bg-muted/30 rounded-lg">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Activity className="w-4 h-4" />
                      Status
                    </div>
                    <div className={`font-medium text-sm ${node.status === 'Active' ? 'text-green-400' : 'text-red-400'}`}>
                      {node.status}
                    </div>
                  </div>
                  
                  <div className="pt-2">
                     <div className="text-xs text-center px-2 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary font-medium">
                        {node.capabilities}
                     </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
