import { ShardingDeepDive } from "./ShardingDeepDive";
import { KZGDeepDive } from "./KZGDeepDive";
import { PerformanceDeepDive } from "./PerformanceDeepDive";
import { DeputySystem } from "./DeputySystem";

export const Technology = () => {
  return (
    <div className="pt-24 pb-12 px-4 max-w-4xl mx-auto">
      <div className="mb-16">
        <h1 className="text-5xl font-bold mb-6 text-foreground">How NilStore Works</h1>
        <p className="text-xl text-muted-foreground leading-relaxed">
          NilStore is not just "Dropbox on Blockchain". It fundamentally reimagines the storage lifecycle to eliminate the "Sealing Latency" that plagues other decentralized networks.
        </p>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          Clients can run fully in-browser using WASM and MetaMask for signing. The local gateway is optional routing and caching infrastructure, but it never signs transactions on a user’s behalf.
        </p>
      </div>

      <div className="space-y-24">
        {/* Step 1 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-500 font-bold shrink-0">1</div>
            <div className="w-0.5 flex-grow bg-border my-2"></div>
          </div>
          <div className="w-full pb-12">
            <ShardingDeepDive />
          </div>
        </div>

        {/* Step 2 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center text-green-500 font-bold shrink-0">2</div>
            <div className="w-0.5 flex-grow bg-border my-2"></div>
          </div>
          <div className="w-full pb-12">
            <KZGDeepDive />
          </div>
        </div>

        {/* Step 3 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-500 font-bold shrink-0">3</div>
            <div className="w-0.5 flex-grow bg-border my-2"></div>
          </div>
          <div className="w-full pb-12">
            <PerformanceDeepDive />
          </div>
        </div>

        {/* Step 4 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-500 font-bold shrink-0">4</div>
          </div>
          <div className="w-full pb-12">
            <DeputySystem />
          </div>
        </div>
      </div>
    </div>
  );
};
