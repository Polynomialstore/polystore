import { Link } from "react-router-dom";
import { File, Hash, Lock, Clock } from "lucide-react";

export const Technology = () => {
  return (
    <div className="pt-24 pb-12 px-4 max-w-4xl mx-auto">
      <div className="mb-16">
        <h1 className="text-5xl font-bold mb-6 text-foreground">How NilStore Works</h1>
        <p className="text-xl text-muted-foreground leading-relaxed">
          NilStore is not just "Dropbox on Blockchain". It fundamentally reimagines the storage lifecycle to eliminate the "Sealing Latency" that plagues other decentralized networks.
        </p>
      </div>

      <div className="space-y-12">
        {/* Step 1 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-500 font-bold">1</div>
            <div className="w-0.5 flex-grow bg-border my-2 group-last:hidden"></div>
          </div>
          <div className="pb-12">
            <h3 className="text-2xl font-bold text-foreground mb-2">Sharding & Encoding</h3>
            <p className="text-muted-foreground mb-4">
              When you upload a file, it isn't stored as a monolith. It is split into 128 KiB <strong>Data Units (DUs)</strong>. Each DU is mapped to the finite field of the BLS12-381 curve.
            </p>
            <Link to="/technology/sharding" className="inline-flex items-center text-primary font-medium hover:underline">
              Deep Dive: The 128KB Symbol <File className="w-4 h-4 ml-1" />
            </Link>
          </div>
        </div>

        {/* Step 2 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center text-green-500 font-bold">2</div>
            <div className="w-0.5 flex-grow bg-border my-2 group-last:hidden"></div>
          </div>
          <div className="pb-12">
            <h3 className="text-2xl font-bold text-foreground mb-2">Cryptographic Binding (KZG)</h3>
            <p className="text-muted-foreground mb-4">
              Before leaving your device, each DU is "committed" to a polynomial. This generates a tiny 48-byte signature that mathematically guarantees the data's integrity forever.
            </p>
            <Link to="/technology/kzg" className="inline-flex items-center text-primary font-medium hover:underline">
              Deep Dive: KZG Commitments <Hash className="w-4 h-4 ml-1" />
            </Link>
          </div>
        </div>

        {/* Step 3 */}
        <div className="flex gap-6 group">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-500 font-bold">3</div>
            <div className="w-0.5 flex-grow bg-border my-2 group-last:hidden"></div>
          </div>
          <div className="pb-12">
            <h3 className="text-2xl font-bold text-foreground mb-2">Proof-of-Seal (PoDE)</h3>
            <p className="text-muted-foreground mb-4">
              Storage nodes must prove they have the data <em>physically stored</em>. We use a memory-hard function (Argon2id) to enforce a "time-lock" that prevents lazy fetching from S3 or IPFS.
            </p>
            <Link to="/technology/sealing" className="inline-flex items-center text-primary font-medium hover:underline">
              Deep Dive: The Timing Defense <Clock className="w-4 h-4 ml-1" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
