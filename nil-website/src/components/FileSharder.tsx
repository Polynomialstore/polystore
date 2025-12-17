import { useState, useCallback, useEffect } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { injectedConnector } from '../lib/web3Config';
import { FileJson, Cpu } from 'lucide-react';
import { workerClient } from '../lib/worker-client';
import { useDirectUpload } from '../hooks/useDirectUpload'; // New import
import { useDirectCommit } from '../hooks/useDirectCommit'; // New import
import { appConfig } from '../config';

interface ShardItem {
  id: number;
  commitments: string[]; // Hex strings from witness
  status: 'pending' | 'processing' | 'expanded' | 'error';
}

type WasmStatus = 'idle' | 'initializing' | 'ready' | 'error';

export interface FileSharderProps {
  dealId: string;
}

export function FileSharder({ dealId }: FileSharderProps) {
  const { address, isConnected } = useAccount();
  const { connectAsync } = useConnect();
  
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('idle');
  const [wasmError, setWasmError] = useState<string | null>(null);

  const [shards, setShards] = useState<ShardItem[]>([]);
  const [collectedMdus, setCollectedMdus] = useState<{ index: number; data: Uint8Array }[]>([]);
  const [currentManifestRoot, setCurrentManifestRoot] = useState<string | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // Use the direct upload hook
  const { uploadProgress, isUploading, uploadMdus, reset: resetUpload } = useDirectUpload({
    dealId, 
    manifestRoot: currentManifestRoot || "",
    providerBaseUrl: appConfig.spBase,
  });

  // Use the direct commit hook
  const { commitContent, isPending: isCommitPending, isConfirming: isCommitConfirming, isSuccess: isCommitSuccess, hash: commitHash, error: commitError } = useDirectCommit();

  const addLog = useCallback((msg: string) => setLogs(prev => [...prev, msg]), []);

  const isUploadComplete = uploadProgress.length > 0 && uploadProgress.every(p => p.status === 'complete');

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
    setCollectedMdus([]);
    setCurrentManifestRoot(null);
    setLogs([]);
    resetUpload();
    addLog(`Processing file: ${file.name} (${formatBytes(file.size)})`);

    const buffer = await file.arrayBuffer();
    console.log(`[Debug] Buffer byteLength: ${buffer.byteLength}`);
    const bytes = new Uint8Array(buffer);
    const RawMduCapacity = 8126464; // From gateway const (64 * 4096 * 31)
    const totalUserChunks = Math.ceil(bytes.length / RawMduCapacity);
    addLog(`DEBUG: File bytes: ${bytes.length}, RawMduCapacity: ${RawMduCapacity}, TotalUserMdus: ${totalUserChunks}`);

    const toU8 = (v: Uint8Array | number[]): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v));

    try {
        await workerClient.initMdu0Builder(totalUserChunks);
        
        const userRoots: Uint8Array[] = [];
        const userMdus: { index: number, data: Uint8Array }[] = [];
        const witnessDataBlobs: Uint8Array[] = []; 

        for (let i = 0; i < totalUserChunks; i++) {
            const start = i * RawMduCapacity;
            const end = Math.min(start + RawMduCapacity, bytes.length);
            const rawChunk = bytes.slice(start, end);

            const encodedMdu = encodeToMdu(rawChunk);
            userMdus.push({ index: i, data: encodedMdu });

            const chunkCopy = new Uint8Array(encodedMdu);
            addLog(`> Sharding User MDU #${i}...`);
            const result = await workerClient.shardFile(chunkCopy);

            const rootBytes = toU8(result.mdu_root);
            userRoots.push(rootBytes);
            console.log(`[Debug] User MDU Root #${i}: 0x${Array.from(rootBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`);

            const witnessFlat = toU8(result.witness_flat);
            witnessDataBlobs.push(witnessFlat);
        }

        const fullWitnessData = new Uint8Array(witnessDataBlobs.reduce((acc, b) => acc + b.length, 0));
        let offset = 0;
        for (const b of witnessDataBlobs) {
            fullWitnessData.set(b, offset);
            offset += b.length;
        }

        const witnessRoots: Uint8Array[] = [];
        const witnessMdus: { index: number, data: Uint8Array }[] = [];
        
        const witnessMduCount = Math.ceil(fullWitnessData.length / RawMduCapacity);
        
        for (let i = 0; i < witnessMduCount; i++) {
            const start = i * RawMduCapacity;
            const end = Math.min(start + RawMduCapacity, fullWitnessData.length);
            const rawChunk = fullWitnessData.slice(start, end);
            const witnessMduBytes = encodeToMdu(rawChunk);

            addLog(`> Sharding Witness MDU #${i}...`);
            console.log(`[Debug] Sharding Witness MDU #${i} size=${witnessMduBytes.length}`);
            const chunkCopy = new Uint8Array(witnessMduBytes);
            const result = await workerClient.shardFile(chunkCopy);

            const rootBytes = toU8(result.mdu_root);
            witnessRoots.push(rootBytes);
            witnessMdus.push({ index: 1 + i, data: witnessMduBytes }); 
            
            await workerClient.setMdu0Root(i, rootBytes);
        }

        for (let i = 0; i < userRoots.length; i++) {
            await workerClient.setMdu0Root(witnessMduCount + i, userRoots[i]);
        }

        await workerClient.appendFileToMdu0(file.name, file.size, 0);

        addLog(`> Finalizing MDU #0...`);
        const mdu0Bytes = await workerClient.getMdu0Bytes();
        
        const mdu0Copy = new Uint8Array(mdu0Bytes);
        const mdu0Result = await workerClient.shardFile(mdu0Copy);
        const mdu0Root = toU8(mdu0Result.mdu_root);

        const allRoots = new Uint8Array(32 * (1 + witnessRoots.length + userRoots.length));
        allRoots.set(mdu0Root, 0);
        let aggOffset = 32;
        for (const r of witnessRoots) {
            allRoots.set(r, aggOffset);
            aggOffset += 32;
        }
        for (const r of userRoots) {
            allRoots.set(r, aggOffset);
            aggOffset += 32;
        }

        addLog(`> Computing Manifest Root (Aggregation)...`);
        const manifest = await workerClient.computeManifest(allRoots);
        
        const finalMdus = [
            { index: 0, data: mdu0Bytes },
            ...witnessMdus,
            ...userMdus.map((m) => ({ index: 1 + witnessMduCount + m.index, data: m.data }))
        ];

        const finalRootHex = '0x' + Array.from(manifest.root).map(b => b.toString(16).padStart(2, '0')).join('');

        setCollectedMdus(finalMdus);
        setCurrentManifestRoot(finalRootHex);
        
        const visShards: ShardItem[] = finalMdus.map(m => ({
            id: m.index,
            commitments: [m.index === 0 ? "MDU #0" : m.index <= witnessMduCount ? "Witness" : "User Data"],
            status: 'expanded'
        }));
        setShards(visShards);

        addLog(`> Manifest Root: ${finalRootHex.slice(0, 16)}...`);
        console.log(`[Debug] Full Manifest Root: ${finalRootHex}`);
        addLog(`> Total MDUs: ${finalMdus.length} (1 Meta + ${witnessMduCount} Witness + ${userMdus.length} User)`);

        const elapsedMs = performance.now() - startTs;
        const mib = file.size / (1024 * 1024);
        const seconds = elapsedMs / 1000;
        const mibPerSec = seconds > 0 ? mib / seconds : 0;
        addLog(
          `Done. Client-side expansion complete. Time: ${formatDuration(elapsedMs)}. Data: ${formatBytes(
            file.size,
          )}. Speed: ${mibPerSec.toFixed(2)} MiB/s.`,
        );

    } catch (e: unknown) {
        console.error(e);
        addLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
        setShards([]);
    } finally {
        setProcessing(false);
    }
  }, [isConnected, wasmStatus, wasmError, addLog, resetUpload]);

  // Helper for encoding (matches nil_core/coding.rs encode_to_mdu)
  function encodeToMdu(rawData: Uint8Array): Uint8Array {
      const MDU_SIZE = 8 * 1024 * 1024;
      const SCALAR_BYTES = 32;
      const SCALAR_PAYLOAD_BYTES = 31;
      const mdu = new Uint8Array(MDU_SIZE);
      
      let readOffset = 0;
      let writeOffset = 0;
      
      while (readOffset < rawData.length && writeOffset < MDU_SIZE) {
          const chunkLen = Math.min(SCALAR_PAYLOAD_BYTES, rawData.length - readOffset);
          const chunk = rawData.subarray(readOffset, readOffset + chunkLen);
          const pad = SCALAR_BYTES - chunkLen;
          mdu.set(chunk, writeOffset + pad);
          readOffset += chunkLen;
          writeOffset += SCALAR_BYTES;
      }
      return mdu;
  }

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

      {/* Processing Status */}
      {(processing || isUploading) && (
        <div className="bg-card rounded-xl border border-border p-4 shadow-sm text-sm">
          <p className="font-bold text-foreground mb-2">Current Activity:</p>
          <div className="space-y-1">
            {processing && <p className="flex items-center gap-2"><Cpu className="w-4 h-4 animate-spin text-blue-500" /> Sharding file locally via WASM...</p>}
            {isUploading && <p className="flex items-center gap-2"><FileJson className="w-4 h-4 animate-pulse text-green-500" /> Uploading MDUs directly to Storage Provider...</p>}
            {isCommitPending || isCommitConfirming ? (
              <p className="flex items-center gap-2"><FileJson className="w-4 h-4 animate-pulse text-purple-500" /> Committing manifest root to chain...</p>
            ) : null}
          </div>
        </div>
      )}

      {/* Upload to SP Button */}
      {collectedMdus.length > 0 && currentManifestRoot && (
        <div className="flex flex-col gap-2">
            <button
              onClick={() => uploadMdus(collectedMdus)}
              disabled={isUploading || processing || isUploadComplete}
              className={`mt-4 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-semibold shadow-sm transition-colors disabled:opacity-50 ${isUploadComplete ? 'bg-green-600/50 text-white cursor-not-allowed' : 'bg-green-600 hover:bg-green-500 text-primary-foreground'}`}
            >
              {isUploading ? 'Uploading...' : isUploadComplete ? 'Upload Complete' : `Upload ${collectedMdus.length} MDUs to SP`}
            </button>

            {(isUploading || isUploadComplete) && uploadProgress.length > 0 && (
              <div className="mt-2 p-3 bg-secondary/50 rounded border border-border text-xs font-mono text-muted-foreground">
                <p className="mb-1 text-primary font-bold">Upload Progress:</p>
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {uploadProgress.map((p, i) => (
                    <div key={i} className="flex justify-between items-center">
                      <span>MDU #{p.mduIndex}:</span>
                      <span className={`font-bold ${p.status === 'complete' ? 'text-green-500' : p.status === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>
                        {p.status.toUpperCase()} {p.error ? `(${p.error})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      )}

      {/* Commit to Chain Button */}
      {currentManifestRoot && isUploadComplete && (
        <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                const totalSize = collectedMdus.reduce((acc, m) => acc + m.data.length, 0);
                commitContent({
                    dealId,
                    manifestRoot: currentManifestRoot,
                    fileSize: totalSize
                });
              }}
              disabled={isCommitPending || isCommitConfirming || isCommitSuccess}
              className="mt-2 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {isCommitPending ? 'Check Wallet...' : isCommitConfirming ? 'Confirming...' : isCommitSuccess ? 'Committed!' : 'Commit to Chain'}
            </button>
            
            {commitHash && (
                <div className="text-xs text-muted-foreground truncate">
                    Tx: {commitHash}
                </div>
            )}
            {commitError && (
                <div className="text-xs text-red-500">
                    Error: {commitError.message}
                </div>
            )}
        </div>
      )}

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
