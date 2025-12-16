import { useState, useCallback, useEffect } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { injectedConnector } from '../lib/web3Config';
import { FileJson, Cpu } from 'lucide-react';
import { workerClient } from '../lib/worker-client';

interface ShardItem {
  id: number;
  commitments: string[]; // Hex strings from witness
  status: 'pending' | 'processing' | 'expanded' | 'error';
}

type WasmStatus = 'idle' | 'initializing' | 'ready' | 'error';

export function FileSharder() {
  const { address, isConnected } = useAccount();
  const { connectAsync } = useConnect();
  
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('idle');
  const [wasmError, setWasmError] = useState<string | null>(null);

  const [shards, setShards] = useState<ShardItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => setLogs(prev => [...prev, msg]), []);

  useEffect(() => {
    // Initialize WASM in the worker
    async function initWasmInWorker() {
      if (wasmStatus !== 'idle') return;
      setWasmStatus('initializing');
      try {
        const response = await fetch('/trusted_setup.txt');
        if (!response.ok) {
          throw new Error(`Failed to fetch trusted setup: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        const trustedSetupBytes = new Uint8Array(buffer);
        
        await workerClient.initNilWasm(trustedSetupBytes);
        setWasmStatus('ready');
        addLog('WASM and KZG context initialized in worker.');
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        setWasmError(message);
        setWasmStatus('error');
        addLog(`Error initializing WASM in worker: ${message}`);
        console.error('WASM Worker Init Error:', e);
      }
    }
    initWasmInWorker();
  }, [addLog, wasmStatus]);

  const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  };

  const formatDuration = (ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragging(true);
    } else if (e.type === 'dragleave') {
      setIsDragging(false);
    }
  }, []);

  const processFile = useCallback(async (file: File) => {
    if (!isConnected) {
        alert("Connect wallet first");
        return;
    }
    if (wasmStatus !== 'ready') {
        alert("WASM worker not ready. " + (wasmError || "Initializing..."));
        return;
    }

    const startTs = performance.now();
    setProcessing(true);
    setShards([]);
    setLogs([]);
    addLog(`Processing file: ${file.name} (${formatBytes(file.size)})`);

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8 * 1024 * 1024; // 8 MiB
    const totalChunks = Math.ceil(bytes.length / chunkSize);
    
    // Create placeholders
    const newShards: ShardItem[] = Array.from({ length: totalChunks }, (_, i) => ({
        id: i,
        commitments: [],
        status: 'pending'
    }));
    setShards(newShards);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, bytes.length);
        
        let chunk = bytes.slice(start, end);
        // Pad to exactly 8MB
        if (chunk.length < chunkSize) {
            const padded = new Uint8Array(chunkSize);
            padded.set(chunk);
            chunk = padded;
        }

        setShards(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'processing' } : s));
        addLog(`> Expanding MDU #${i} (KZG)...`);

        try {
            // Call WASM worker's expand_file
            const result = (await workerClient.shardFile(chunk)) as unknown as { witness: number[][] };
            
            const commitments = result.witness.map((w) => 
                '0x' + Array.from(w).map(b => b.toString(16).padStart(2, '0')).join('')
            );

            setShards(prev => prev.map((s, idx) => idx === i ? { ...s, commitments, status: 'expanded' } : s));
            addLog(`> MDU #${i} expanded. ${commitments.length} commitments generated.`);
            if (commitments.length > 0) {
              addLog(`> Root: ${commitments[0].slice(0,10)}...`);
            }
            
        } catch (e: unknown) {
            console.error(e);
            addLog(`Error expanding MDU #${i}: ${e instanceof Error ? e.message : String(e)}`);
            setShards(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'error' } : s));
        }
    }
    
    setProcessing(false);
    const elapsedMs = performance.now() - startTs;
    const mib = file.size / (1024 * 1024);
    const seconds = elapsedMs / 1000;
    const mibPerSec = seconds > 0 ? mib / seconds : 0;
    addLog(
      `Done. Client-side expansion complete. Time: ${formatDuration(elapsedMs)}. Data: ${formatBytes(
        file.size,
      )}. Speed: ${mibPerSec.toFixed(2)} MiB/s.`,
    );
  }, [isConnected, wasmStatus, wasmError, addLog]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  }, [processFile]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  return (
    <div className="w-full space-y-6">
      {!isConnected ? (
          <button 
            onClick={() => connectAsync({ connector: injectedConnector })}
            className="w-full py-12 border-2 border-dashed border-border rounded-xl text-muted-foreground font-bold transition-all flex flex-col items-center gap-4 hover:border-primary/50 hover:bg-secondary/50"
          >
              <div className="text-4xl">🔌</div>
              Connect Wallet to Start
          </button>
      ) : (
      <>
      <div className="flex items-center justify-between px-4 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"/>
              Connected: <span className="font-mono font-bold">{address?.slice(0,10)}...</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
             <span className={`px-2 py-0.5 rounded-full border ${
                 wasmStatus === 'ready' ? 'bg-blue-500/10 text-blue-500 border-blue-500/20' : wasmStatus === 'initializing' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'
             }`}>
                 WASM: {wasmStatus}
             </span>
          </div>
      </div>

      {/* Dropzone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-xl p-12 text-center transition-all duration-200
          ${isDragging 
            ? 'border-primary bg-primary/10 scale-[1.02]' 
            : 'border-border hover:border-primary/50 bg-card'
          }
        `}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center text-3xl">
            <Cpu className="w-8 h-8 text-foreground" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-foreground">Client-Side Expansion</h3>
            <p className="text-muted-foreground mt-2">
              Drop a file to split it into <span className="text-primary font-bold">128 KiB Data Units</span> and generate <span className="text-primary font-bold">KZG Commitments</span> locally via WASM.
            </p>
            <label className="mt-6 inline-flex cursor-pointer items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90">
              Browse Files
              <input type="file" className="hidden" onChange={handleFileSelect} />
            </label>
          </div>
        </div>
      </div>

      {/* Visualization Grid */}
      {shards.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-6 shadow-sm">
            <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-bold flex items-center gap-2 text-foreground">
              <FileJson className="w-5 h-5 text-primary" />
              Manifest Visualization
            </h3>
              <div className="text-sm text-muted-foreground font-mono">
                {shards.filter(s => s.status === 'expanded').length} / {shards.length} MDUs Expanded
              </div>
            </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
            {shards.map((shard) => (
              <div 
                key={shard.id}
                  className={`
                    aspect-square rounded-lg p-2 flex flex-col justify-between text-[10px] font-mono transition-all duration-500 border
                    ${shard.status === 'expanded' 
                      ? 'bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300' 
                      : shard.status === 'processing'
                      ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-300 animate-pulse'
                      : 'bg-secondary border-border text-muted-foreground'
                    }
                  `}
                title={shard.commitments[0] || 'Pending...'}
              >
                  <div className="flex justify-between opacity-50">
                    <span>#{shard.id}</span>
                    <span>8MiB</span>
                  </div>
                  <div className="truncate text-[8px] opacity-75">
                    {shard.status === 'expanded' ? shard.commitments[0].slice(0, 8) : shard.status === 'processing' ? 'Expanding...' : 'Pending'}
                  </div>
                </div>
              ))}
            </div>
          
          <div className="mt-4 p-4 bg-secondary/50 rounded border border-border text-xs font-mono text-muted-foreground">
            <p className="mb-2 text-primary font-bold">System Activity:</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
                {logs.map((log, i) => (
                    <p key={i}>{log}</p>
                ))}
                {processing && <p className="animate-pulse">...</p>}
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
