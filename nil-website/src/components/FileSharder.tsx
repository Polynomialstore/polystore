import { useState, useCallback } from 'react';
import { useProofs } from '../context/ProofContext';

interface Shard {
  id: number;
  data: Uint8Array;
  hash: string;
  status: 'pending' | 'processing' | 'sealed';
}

export function FileSharder() {
  const [shards, setShards] = useState<Shard[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const { addSimulatedProof } = useProofs();

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragging(true);
    } else if (e.type === 'dragleave') {
      setIsDragging(false);
    }
  }, []);

  const processFile = async (file: File) => {
    setProcessing(true);
    setShards([]);
    
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 131072; // 128 KiB
    const totalChunks = Math.ceil(bytes.length / chunkSize);
    const newShards: Shard[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, bytes.length);
      const chunk = bytes.slice(start, end);
      
      // Calculate SHA-256 hash (Binding)
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', chunk);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      newShards.push({
        id: i,
        data: chunk,
        hash: hashHex,
        status: 'pending'
      });
    }

    setShards(newShards);
    setProcessing(false);
    
    // Simulate "Sealing" animation
    simulateSealing(newShards);
  };

  const simulateSealing = async (items: Shard[]) => {
    for (let i = 0; i < items.length; i++) {
        await new Promise(r => setTimeout(r, 50)); // Fast ripple effect
        setShards(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'sealed' } : s
        ));
    }
    
    // Add to shared map state (Visual Feedback)
    if (items.length > 0) {
        addSimulatedProof({
            id: `sim-${Date.now()}`,
            creator: "You (Browser)",
            commitment: items[0].hash, // Using SHA256 hash as proxy for commitment
            block_height: "Pending",
            source: "simulated"
        });
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  return (
    <div className="w-full space-y-6">
      {/* Dropzone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-xl p-12 text-center transition-all duration-200
          ${isDragging 
            ? 'border-green-400 bg-green-400/10 scale-[1.02]' 
            : 'border-slate-700 hover:border-slate-500 bg-slate-900/50'
          }
        `}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center text-3xl">
            📂
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-200">Drop a file to Shard</h3>
            <p className="text-slate-400 mt-2">
              Or <label className="text-green-400 hover:underline cursor-pointer">
                browse
                <input type="file" className="hidden" onChange={handleFileSelect} />
              </label> to split it into 128 KiB Data Units (DUs).
            </p>
          </div>
        </div>
      </div>

      {/* Visualization Grid */}
      {shards.length > 0 && (
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2 text-slate-100">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/>
              Lattice Visualization
            </h3>
            <div className="text-sm text-slate-400 font-mono">
              {shards.filter(s => s.status === 'sealed').length} / {shards.length} DUs Sealed
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
            {shards.map((shard) => (
              <div 
                key={shard.id}
                className={`
                  aspect-square rounded-lg p-2 flex flex-col justify-between text-[10px] font-mono transition-all duration-500
                  ${shard.status === 'sealed' 
                    ? 'bg-green-500/20 border border-green-500/50 text-green-200 shadow-[0_0_10px_rgba(74,222,128,0.2)]' 
                    : 'bg-slate-800 border border-slate-700 text-slate-500'
                  }
                `}
                title={`Hash: ${shard.hash}`}
              >
                <div className="flex justify-between opacity-50">
                  <span>#{shard.id}</span>
                  <span>128KB</span>
                </div>
                <div className="truncate text-[8px] opacity-75">
                  {shard.status === 'sealed' ? shard.hash.substring(0, 8) : '...'}
                </div>
              </div>
            ))}
          </div>
          
          <div className="mt-4 p-4 bg-slate-950 rounded border border-slate-800 text-xs font-mono text-slate-400">
            <p className="mb-2 text-green-400 font-bold">System Activity:</p>
            {processing ? (
                <p>Processing file...</p>
            ) : shards.length > 0 ? (
                <div className="space-y-1">
                    <p>{'>'} File split into {shards.length} Data Units.</p>
                    <p>{'>'} Binding values (SHA-256) computed.</p>
                    <p>{'>'} Distributing to Storage Nodes...</p>
                    {shards.filter(s => s.status === 'sealed').length === shards.length && (
                        <p className="text-green-400">{'>'} All shards verified and sealed.</p>
                    )}
                </div>
            ) : (
                <p>Waiting for input...</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
