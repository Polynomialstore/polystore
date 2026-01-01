import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { injectedConnector } from '../lib/web3Config';
import { FileJson, Cpu, Wallet } from 'lucide-react';
import { workerClient } from '../lib/worker-client';
import { useDirectUpload } from '../hooks/useDirectUpload'; // New import
import { useDirectCommit } from '../hooks/useDirectCommit'; // New import
import { appConfig } from '../config';
import { NILFS_RECORD_PATH_MAX_BYTES, sanitizeNilfsRecordPath } from '../lib/nilfsPath';
import { readMdu, writeManifestBlob, writeManifestRoot, writeMdu, writeShard } from '../lib/storage/OpfsAdapter';
import { parseNilfsFilesFromMdu0 } from '../lib/nilfsLocal';
import { inferWitnessCountFromOpfs, RAW_MDU_CAPACITY } from '../lib/nilfsOpfsFetch';
import { lcdFetchDeal } from '../api/lcdClient';
import { parseServiceHint } from '../lib/serviceHint';
import { resolveProviderEndpoints } from '../lib/providerDiscovery';
import { useLocalGateway } from '../hooks/useLocalGateway';

interface ShardItem {
  id: number;
  commitments: string[]; // Hex strings from witness
  status: 'pending' | 'processing' | 'expanded' | 'error';
}

type WasmStatus = 'idle' | 'initializing' | 'ready' | 'error';

export interface FileSharderProps {
  dealId: string;
  onCommitSuccess?: (dealId: string, manifestRoot: string, fileMeta?: { filePath: string; fileSizeBytes: number }) => void;
}

type ShardPhase =
  | 'idle'
  | 'reading'
  | 'planning'
  | 'gateway_receiving'
  | 'gateway_encoding'
  | 'gateway_uploading'
  | 'shard_user'
  | 'shard_witness'
  | 'finalize_mdu0'
  | 'compute_manifest'
  | 'done'
  | 'error';

interface ShardProgressState {
  phase: ShardPhase;
  label: string;
  blobsDone: number;
  blobsTotal: number;
  blobsInCurrentMdu: number;
  blobsPerMdu: number;
  workDone: number;
  workTotal: number;
  avgWorkMs: number | null;
  fileBytesTotal: number;
  currentOpStartedAtMs: number | null;
  startTsMs: number | null;
  totalUserMdus: number;
  totalWitnessMdus: number;
  currentMduIndex: number | null;
  currentMduKind: 'user' | 'witness' | 'meta' | null;
  lastOpMs: number | null;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function FileSharder({ dealId, onCommitSuccess }: FileSharderProps) {
  const { isConnected } = useAccount();
  const { connectAsync } = useConnect();
  const localGateway = useLocalGateway();
  
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('idle');
  const [, setWasmError] = useState<string | null>(null);

  const [shards, setShards] = useState<ShardItem[]>([]);
  const [collectedMdus, setCollectedMdus] = useState<{ index: number; data: Uint8Array }[]>([]);
  const [currentManifestRoot, setCurrentManifestRoot] = useState<string | null>(null);
  const [currentManifestBlob, setCurrentManifestBlob] = useState<Uint8Array | null>(null);
  const [mirrorStatus, setMirrorStatus] = useState<'idle' | 'running' | 'success' | 'error' | 'skipped'>('idle')
  const [mirrorError, setMirrorError] = useState<string | null>(null)
  const [stripeParams, setStripeParams] = useState<{ k: number; m: number } | null>(null)
  const [stripeParamsLoaded, setStripeParamsLoaded] = useState(false)
  const [slotBases, setSlotBases] = useState<string[]>([])
  const [mode2Shards, setMode2Shards] = useState<{ index: number; shards: Uint8Array[] }[]>([])
  const [mode2Uploading, setMode2Uploading] = useState(false)
  const [mode2UploadComplete, setMode2UploadComplete] = useState(false)
  const [mode2UploadError, setMode2UploadError] = useState<string | null>(null)

  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [shardProgress, setShardProgress] = useState<ShardProgressState>({
    phase: 'idle',
    label: '',
    blobsDone: 0,
    blobsTotal: 0,
    blobsInCurrentMdu: 0,
    blobsPerMdu: 64,
    workDone: 0,
    workTotal: 0,
    avgWorkMs: null,
    fileBytesTotal: 0,
    currentOpStartedAtMs: null,
    startTsMs: null,
    totalUserMdus: 0,
    totalWitnessMdus: 0,
    currentMduIndex: null,
    currentMduKind: null,
    lastOpMs: null,
  });
  const [uiTick, setUiTick] = useState(0);
  const recentSpeedMibPerSecRef = useRef<number>(0);
  const speedSamplesRef = useRef<Array<{ tMs: number; bytesDone: number }>>([]);

  const etaDisplayMsRef = useRef<number | null>(null);
  const etaLastTickMsRef = useRef<number | null>(null);
  const etaLastRawMsRef = useRef<number | null>(null);
  const lastCommitRef = useRef<string | null>(null);
  const lastCommitTxRef = useRef<string | null>(null);
  const lastFileMetaRef = useRef<{ filePath: string; fileSizeBytes: number } | null>(null);
  const wasmInitPromiseRef = useRef<Promise<void> | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Use the direct upload hook
  const { uploadProgress, isUploading, uploadMdus, reset: resetUpload } = useDirectUpload({
    dealId, 
    manifestRoot: currentManifestRoot || "",
    manifestBlob: currentManifestBlob,
    providerBaseUrl: slotBases[0] || appConfig.spBase,
  });

  // Use the direct commit hook
  const { commitContent, isPending: isCommitPending, isConfirming: isCommitConfirming, isSuccess: isCommitSuccess, hash: commitHash, error: commitError } = useDirectCommit();

  const addLog = useCallback((msg: string) => setLogs(prev => [...prev, msg]), []);

  const isMode2 = Boolean(stripeParams && stripeParams.k > 0 && stripeParams.m > 0)
  const gatewayMode2Enabled = isMode2 && !appConfig.gatewayDisabled
  const gatewayReachable = localGateway.status === 'connected' && gatewayMode2Enabled
  const activeUploading = isMode2 ? mode2Uploading : isUploading
  const isUploadComplete = isMode2
    ? mode2UploadComplete
    : uploadProgress.length > 0 && uploadProgress.every(p => p.status === 'complete');

  useEffect(() => {
    let cancelled = false
    async function loadDeal() {
      setStripeParamsLoaded(false)
      if (!dealId) {
        setStripeParams(null)
        setSlotBases([])
        setStripeParamsLoaded(true)
        return
      }
      try {
        const deal = await lcdFetchDeal(appConfig.lcdBase, dealId)
        const parsed = parseServiceHint(deal?.service_hint)
        if (!cancelled) {
          if (parsed.mode === 'mode2' && parsed.rsK && parsed.rsM) {
            setStripeParams({ k: parsed.rsK, m: parsed.rsM })
          } else {
            setStripeParams(null)
          }
          setStripeParamsLoaded(true)
        }
        const endpoints = await resolveProviderEndpoints(appConfig.lcdBase, dealId)
        if (!cancelled) {
          setSlotBases(endpoints.map((e) => e.baseUrl))
        }
      } catch {
        if (!cancelled) {
          setStripeParams(null)
          setSlotBases([])
          setStripeParamsLoaded(true)
        }
      }
    }
    loadDeal()
    return () => {
      cancelled = true
    }
  }, [dealId]);

  useEffect(() => {
    if (!isCommitSuccess) return;
    if (!currentManifestRoot || !dealId || !commitHash) return;
    if (lastCommitTxRef.current === commitHash) return;
    lastCommitTxRef.current = commitHash;
    lastCommitRef.current = currentManifestRoot;
    onCommitSuccess?.(dealId, currentManifestRoot, lastFileMetaRef.current || undefined);
  }, [commitHash, currentManifestRoot, dealId, isCommitSuccess, onCommitSuccess]);

  const uploadMode2 = useCallback(async () => {
    if (!currentManifestRoot || !currentManifestBlob) {
      setMode2UploadError('Manifest data missing; shard first.')
      return false
    }
    if (!stripeParams) {
      setMode2UploadError('Mode 2 params not available.')
      return false
    }
    const slotCount = stripeParams.k + stripeParams.m
    const bases = slotBases.slice(0, slotCount)
    if (bases.length < slotCount || bases.some((b) => !b)) {
      setMode2UploadError('Missing provider endpoints for all slots.')
      return false
    }

    const manifestRoot = currentManifestRoot
    const witnessCount = shardProgress.totalWitnessMdus
    const metadataMdus = collectedMdus.filter((mdu) => mdu.index <= witnessCount)

    setMode2Uploading(true)
    setMode2UploadError(null)
    setMode2UploadComplete(false)

    try {
      for (const base of bases) {
        for (const mdu of metadataMdus) {
          const res = await fetch(`${base}/sp/upload_mdu`, {
            method: 'POST',
            headers: {
              'X-Nil-Deal-ID': dealId,
              'X-Nil-Mdu-Index': String(mdu.index),
              'X-Nil-Manifest-Root': manifestRoot,
              'Content-Type': 'application/octet-stream',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            body: new Blob([mdu.data as any]),
          })
          if (!res.ok) {
            const msg = await res.text().catch(() => '')
            throw new Error(`metadata upload failed: ${res.status} ${msg}`)
          }
        }

        const manRes = await fetch(`${base}/sp/upload_manifest`, {
          method: 'POST',
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: new Blob([currentManifestBlob as any]),
        })
        if (!manRes.ok) {
          const msg = await manRes.text().catch(() => '')
          throw new Error(`manifest upload failed: ${manRes.status} ${msg}`)
        }
      }

      for (const mdu of mode2Shards) {
        const slabIndex = 1 + witnessCount + mdu.index
        for (let slot = 0; slot < bases.length; slot++) {
          const base = bases[slot]
          const shard = mdu.shards[slot]
          if (!shard) {
            throw new Error(`missing shard for slot ${slot}`)
          }
          const res = await fetch(`${base}/sp/upload_shard`, {
            method: 'POST',
            headers: {
              'X-Nil-Deal-ID': dealId,
              'X-Nil-Mdu-Index': String(slabIndex),
              'X-Nil-Slot': String(slot),
              'X-Nil-Manifest-Root': manifestRoot,
              'Content-Type': 'application/octet-stream',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            body: new Blob([shard as any]),
          })
          if (!res.ok) {
            const msg = await res.text().catch(() => '')
            throw new Error(`shard upload failed: ${res.status} ${msg}`)
          }
        }
      }

      setMode2UploadComplete(true)
      return true
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setMode2UploadError(msg)
      return false
    } finally {
      setMode2Uploading(false)
    }
  }, [collectedMdus, currentManifestBlob, currentManifestRoot, dealId, mode2Shards, shardProgress.totalWitnessMdus, slotBases, stripeParams])

  useEffect(() => {
    if (!processing) return;
    const handle = window.setInterval(() => setUiTick((v) => (v + 1) % 1_000_000), 250);
    return () => window.clearInterval(handle);
  }, [processing]);

  useEffect(() => {
    if (!processing) {
      recentSpeedMibPerSecRef.current = 0;
      speedSamplesRef.current = [];
      etaDisplayMsRef.current = null;
      etaLastTickMsRef.current = null;
      etaLastRawMsRef.current = null;
      return;
    }

    if (shardProgress.startTsMs == null) return;

    // Reset per-run state when a new run starts.
    if (shardProgress.blobsDone === 0) {
      recentSpeedMibPerSecRef.current = 0;
      speedSamplesRef.current = [];
      etaDisplayMsRef.current = null;
      etaLastTickMsRef.current = null;
      etaLastRawMsRef.current = null;
    }
  }, [processing, shardProgress.startTsMs, shardProgress.blobsDone]);

  useEffect(() => {
    if (!processing) return;
    void uiTick;

    const now = performance.now();

    // --- Rolling speed (effective bytes over a fixed window) ---
    // Using a fixed window avoids inflated "burst" speeds when progress events arrive in batches.
    const SPEED_WINDOW_MS = 3000;
    const totalWork = shardProgress.workTotal;
    const workFrac = totalWork > 0 ? Math.max(0, Math.min(1, shardProgress.workDone / totalWork)) : 0;
    const bytesDone = shardProgress.fileBytesTotal * workFrac;
    const samples = speedSamplesRef.current;
    samples.push({ tMs: now, bytesDone });
    while (samples.length > 2 && now - samples[0].tMs > SPEED_WINDOW_MS) samples.shift();
    if (samples.length >= 2) {
      const oldest = samples[0];
      const dtMs = now - oldest.tMs;
      const db = bytesDone - oldest.bytesDone;
      if (dtMs > 0 && db > 0) {
        recentSpeedMibPerSecRef.current = (db / (1024 * 1024)) / (dtMs / 1000);
      }
    }

    // --- ETA display (countdown) ---
    const lastEtaTick = etaLastTickMsRef.current;
    const dtEta = lastEtaTick == null ? 0 : Math.max(0, now - lastEtaTick);
    etaLastTickMsRef.current = now;

    if (etaDisplayMsRef.current != null && dtEta > 0) {
      etaDisplayMsRef.current = Math.max(0, etaDisplayMsRef.current - dtEta);
    }

    const elapsedMs = shardProgress.startTsMs ? Math.max(0, now - shardProgress.startTsMs) : 0;
    const avgWorkMs =
      shardProgress.avgWorkMs ??
      (shardProgress.workDone > 0 && shardProgress.startTsMs ? elapsedMs / shardProgress.workDone : null);
    const remainingWork = Math.max(0, shardProgress.workTotal - shardProgress.workDone);
    const etaRaw = avgWorkMs ? avgWorkMs * remainingWork : null;

    if (etaRaw == null) {
      etaDisplayMsRef.current = null;
      etaLastRawMsRef.current = null;
      return;
    }

    const lastRaw = etaLastRawMsRef.current;
    if (etaDisplayMsRef.current == null || lastRaw == null) {
      etaDisplayMsRef.current = etaRaw;
      etaLastRawMsRef.current = etaRaw;
      return;
    }

    if (Math.abs(etaRaw - lastRaw) >= 250) {
      etaDisplayMsRef.current = etaRaw;
      etaLastRawMsRef.current = etaRaw;
      return;
    }
  }, [processing, uiTick, shardProgress]);

  const shardingUi = useMemo(() => {
    void uiTick;
    const now = performance.now();
    const elapsedMs = shardProgress.startTsMs ? Math.max(0, now - shardProgress.startTsMs) : 0;
    const currentOpMs = shardProgress.currentOpStartedAtMs ? Math.max(0, now - shardProgress.currentOpStartedAtMs) : 0;
    const overallPct = shardProgress.workTotal > 0 ? Math.min(1, shardProgress.workDone / shardProgress.workTotal) : 0;
    const avgWorkMs =
      shardProgress.avgWorkMs ??
      (shardProgress.workDone > 0 && shardProgress.startTsMs ? elapsedMs / shardProgress.workDone : null);
    const remainingWork = Math.max(0, shardProgress.workTotal - shardProgress.workDone);
    const etaRawMs = avgWorkMs ? avgWorkMs * remainingWork : null;
    const etaMs = etaDisplayMsRef.current ?? etaRawMs;
    const mib = shardProgress.fileBytesTotal > 0 ? shardProgress.fileBytesTotal / (1024 * 1024) : 0;
    const seconds = elapsedMs / 1000;
    const avgMibPerSec = seconds > 0 ? mib / seconds : 0;
    const mibPerSec = recentSpeedMibPerSecRef.current > 0 ? recentSpeedMibPerSecRef.current : avgMibPerSec;

    const phaseDetails = (() => {
      if (shardProgress.phase === 'shard_user') {
        return `User MDU ${String((shardProgress.currentMduIndex ?? 0) + 1)} / ${String(shardProgress.totalUserMdus)} • Blob ${String(
          shardProgress.blobsInCurrentMdu,
        )}/${String(shardProgress.blobsPerMdu)}`;
      }
      if (shardProgress.phase === 'shard_witness') {
        return `Witness MDU ${String((shardProgress.currentMduIndex ?? 0) + 1)} / ${String(
          shardProgress.totalWitnessMdus,
        )} • Blob ${String(shardProgress.blobsInCurrentMdu)}/${String(shardProgress.blobsPerMdu)}`;
      }
      if (shardProgress.phase === 'finalize_mdu0') {
        return `Finalizing MDU #0 • Blob ${String(shardProgress.blobsInCurrentMdu)}/${String(shardProgress.blobsPerMdu)}`;
      }
      if (shardProgress.phase === 'compute_manifest') return 'Computing manifest commitment';
      if (shardProgress.phase === 'reading') return 'Reading file into memory';
      if (shardProgress.phase === 'gateway_receiving') return 'Receiving file in gateway';
      if (shardProgress.phase === 'gateway_encoding') return 'Gateway RS encoding';
      if (shardProgress.phase === 'gateway_uploading') return 'Uploading to providers';
      if (shardProgress.phase === 'planning') return 'Planning slab layout';
      if (shardProgress.phase === 'done') return 'Done';
      if (shardProgress.phase === 'error') return 'Error';
      return '';
    })();

    return {
      elapsedMs,
      currentOpMs,
      overallPct,
      avgWorkMs,
      etaMs,
      mibPerSec,
      phaseDetails,
    };
  }, [shardProgress, uiTick]);

  const mirrorSlabToGateway = useCallback(async () => {
    const manifestRoot = String(currentManifestRoot || '').trim()
    if (!manifestRoot) return
    if (!currentManifestBlob || currentManifestBlob.byteLength === 0) return
    if (!collectedMdus || collectedMdus.length === 0) return

    const gatewayBase = appConfig.gatewayBase.replace(/\/$/, '')
    const spBase = appConfig.spBase.replace(/\/$/, '')
    if (!gatewayBase || gatewayBase === spBase) return
    if (appConfig.gatewayDisabled) {
      setMirrorStatus('skipped')
      setMirrorError('Gateway disabled')
      addLog('> Gateway mirror skipped (disabled).')
      return
    }

    setMirrorStatus('running')
    setMirrorError(null)
    addLog(`> Mirroring slab to local gateway (${gatewayBase})...`)

    try {
      let mirrorMduPath = '/sp/upload_mdu'
      let mirrorShardPath = '/sp/upload_shard'
      let mirrorManifestPath = '/sp/upload_manifest'

      const statusRes = await fetch(`${gatewayBase}/status`, { method: 'GET', signal: AbortSignal.timeout(2500) })
      if (statusRes.ok) {
        const payload = await statusRes.json().catch(() => null)
        if (payload && typeof payload === 'object' && payload.mode === 'router') {
          mirrorMduPath = '/gateway/mirror_mdu'
          mirrorShardPath = '/gateway/mirror_shard'
          mirrorManifestPath = '/gateway/mirror_manifest'
          addLog('> Gateway router detected; using mirror endpoints.')
        }
      } else if (statusRes.status !== 404) {
        setMirrorStatus('skipped')
        setMirrorError(`Gateway unavailable (${statusRes.status})`)
        addLog('> Gateway not reachable; mirror skipped.')
        return
      } else {
        const health = await fetch(`${gatewayBase}/health`, { method: 'GET', signal: AbortSignal.timeout(2500) })
        if (!health.ok) {
          setMirrorStatus('skipped')
          setMirrorError(`Gateway unavailable (${health.status})`)
          addLog('> Gateway not reachable; mirror skipped.')
          return
        }
      }

      const witnessCount = shardProgress.totalWitnessMdus
      const metadataMdus = isMode2
        ? collectedMdus.filter((mdu) => mdu.index <= witnessCount)
        : collectedMdus

      for (const mdu of metadataMdus) {
        const res = await fetch(`${gatewayBase}${mirrorMduPath}`, {
          method: 'POST',
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(mdu.index),
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: new Blob([mdu.data as any]),
        })
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(txt || `gateway upload_mdu failed (${res.status})`)
        }
      }

      const manifestRes = await fetch(`${gatewayBase}${mirrorManifestPath}`, {
        method: 'POST',
        headers: {
          'X-Nil-Deal-ID': dealId,
          'X-Nil-Manifest-Root': manifestRoot,
          'Content-Type': 'application/octet-stream',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: new Blob([currentManifestBlob as any]),
      })
      if (!manifestRes.ok) {
        const txt = await manifestRes.text().catch(() => '')
        throw new Error(txt || `gateway upload_manifest failed (${manifestRes.status})`)
      }

      if (isMode2 && mode2Shards.length > 0) {
        for (const mdu of mode2Shards) {
          const slabIndex = 1 + witnessCount + mdu.index
          for (let slot = 0; slot < mdu.shards.length; slot++) {
            const shard = mdu.shards[slot]
            if (!shard) {
              throw new Error(`missing shard for slot ${slot}`)
            }
            const res = await fetch(`${gatewayBase}${mirrorShardPath}`, {
              method: 'POST',
              headers: {
                'X-Nil-Deal-ID': dealId,
                'X-Nil-Mdu-Index': String(slabIndex),
                'X-Nil-Slot': String(slot),
                'X-Nil-Manifest-Root': manifestRoot,
                'Content-Type': 'application/octet-stream',
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              body: new Blob([shard as any]),
            })
            if (!res.ok) {
              const txt = await res.text().catch(() => '')
              throw new Error(txt || `gateway upload_shard failed (${res.status})`)
            }
          }
        }
      }

      setMirrorStatus('success')
      setMirrorError(null)
      addLog('> Mirrored slab to local gateway.')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      const isNetwork = /Failed to fetch|NetworkError|fetch failed/i.test(msg)
      if (isNetwork) {
        setMirrorStatus('skipped')
        setMirrorError('Gateway not reachable')
        addLog('> Gateway not reachable; mirror skipped.')
      } else {
        setMirrorStatus('error')
        setMirrorError(msg)
        addLog(`> Gateway mirror failed: ${msg}`)
      }
    }
  }, [
    addLog,
    collectedMdus,
    currentManifestBlob,
    currentManifestRoot,
    dealId,
    isMode2,
    mode2Shards,
    shardProgress.totalWitnessMdus,
  ]);

  useEffect(() => {
    let cancelled = false;
    const persist = async () => {
      if (!isCommitSuccess) return;
      if (!currentManifestRoot) return;
      if (collectedMdus.length === 0 && !isMode2) return;

      try {
        addLog('> Saving committed slab to OPFS...');
        await writeManifestRoot(dealId, currentManifestRoot);
        if (currentManifestBlob) {
          await writeManifestBlob(dealId, currentManifestBlob);
        }
        for (const mdu of collectedMdus) {
          if (cancelled) return;
          await writeMdu(dealId, mdu.index, mdu.data);
        }
        if (isMode2 && mode2Shards.length > 0) {
          const witnessCount = shardProgress.totalWitnessMdus;
          for (const mdu of mode2Shards) {
            const slabIndex = 1 + witnessCount + mdu.index;
            for (let slot = 0; slot < mdu.shards.length; slot++) {
              const shard = mdu.shards[slot];
              if (!shard) continue;
              await writeShard(dealId, slabIndex, slot, shard);
            }
          }
        }
        addLog('> Saved MDUs locally (OPFS). Deal Explorer should show files now.');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        addLog(`> Failed to save MDUs locally: ${msg}`);
      }
    };
    void persist();
    return () => {
      cancelled = true;
    };
  }, [
    addLog,
    collectedMdus,
    currentManifestBlob,
    currentManifestRoot,
    dealId,
    isCommitSuccess,
    isMode2,
    mode2Shards,
    shardProgress.totalWitnessMdus,
  ]);

  const ensureWasmReady = useCallback(async () => {
    if (wasmStatus === 'ready') return
    if (wasmInitPromiseRef.current) {
      await wasmInitPromiseRef.current
      return
    }

    const promise = (async () => {
      setWasmStatus('initializing')
      setWasmError(null)
      try {
        const response = await fetch('/trusted_setup.txt')
        if (!response.ok) {
          throw new Error(`Failed to fetch trusted setup: ${response.statusText}`)
        }
        const buffer = await response.arrayBuffer()
        const trustedSetupBytes = new Uint8Array(buffer)

        await workerClient.initNilWasm(trustedSetupBytes)
        setWasmStatus('ready')
        addLog('WASM and KZG context initialized in worker.')
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        setWasmError(message)
        setWasmStatus('error')
        addLog(`Error initializing WASM in worker: ${message}`)
        console.error('WASM Worker Init Error:', e)
        throw e
      }
    })()

    wasmInitPromiseRef.current = promise
    try {
      await promise
    } finally {
      wasmInitPromiseRef.current = null
    }
  }, [addLog, wasmStatus])

  useEffect(() => {
    if (!stripeParamsLoaded) return
    const shouldPreloadWasm = !gatewayMode2Enabled || Boolean(localGateway.error)
    if (!shouldPreloadWasm) return
    void ensureWasmReady()
  }, [ensureWasmReady, gatewayMode2Enabled, localGateway.error, stripeParamsLoaded])

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragging(true);
    } else if (e.type === 'dragleave') {
      setIsDragging(false);
    }
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      if (!isConnected) {
        alert('Connect wallet first');
        return;
      }

      lastFileMetaRef.current = { filePath: file.name, fileSizeBytes: file.size };
      const startTs = performance.now();
      setProcessing(true);
      setShards([]);
      setCollectedMdus([]);
      setCurrentManifestRoot(null);
      setCurrentManifestBlob(null);
      setLogs([]);
      resetUpload();
      setMode2Shards([]);
      setMode2Uploading(false);
      setMode2UploadComplete(false);
      setMode2UploadError(null);
      addLog(`Processing file: ${file.name} (${formatBytes(file.size)})`);
      setShardProgress({
        phase: 'reading',
        label: 'Reading file...',
        blobsDone: 0,
        blobsTotal: 0,
        blobsInCurrentMdu: 0,
        blobsPerMdu: 64,
        workDone: 0,
        workTotal: 0,
        avgWorkMs: null,
        fileBytesTotal: file.size,
        currentOpStartedAtMs: performance.now(),
        startTsMs: startTs,
        totalUserMdus: 0,
        totalWitnessMdus: 0,
        currentMduIndex: null,
        currentMduKind: null,
        lastOpMs: null,
      });

      const useMode2 = Boolean(stripeParams && stripeParams.k > 0 && stripeParams.m > 0)
      const shouldTryGatewayMode2 = useMode2 && gatewayMode2Enabled

      const RawMduCapacity = RAW_MDU_CAPACITY
      const rsK = useMode2 ? stripeParams!.k : 0
      const rsM = useMode2 ? stripeParams!.m : 0
      const leafCount = useMode2 ? (rsK + rsM) * (64 / rsK) : 64

      if (shouldTryGatewayMode2) {
        type GatewayUploadJobStatus = {
          status?: string
          phase?: string
          message?: string
          error?: string
          bytes_done?: number
          bytes_total?: number
          steps_done?: number
          steps_total?: number
          result?: {
            manifest_root?: string
          }
        }

        const asNumber = (value: unknown): number | undefined => {
          if (typeof value === 'number') return value
          if (typeof value === 'string') {
            const n = Number(value)
            return Number.isFinite(n) ? n : undefined
          }
          return undefined
        }

        const parseGatewayUploadJobStatus = (value: unknown): GatewayUploadJobStatus | null => {
          if (!value || typeof value !== 'object') return null
          const obj = value as Record<string, unknown>
          const resultObj = obj.result && typeof obj.result === 'object' ? (obj.result as Record<string, unknown>) : null
          const manifestRoot = resultObj && typeof resultObj.manifest_root === 'string' ? resultObj.manifest_root : undefined

          return {
            status: typeof obj.status === 'string' ? obj.status : undefined,
            phase: typeof obj.phase === 'string' ? obj.phase : undefined,
            message: typeof obj.message === 'string' ? obj.message : undefined,
            error: typeof obj.error === 'string' ? obj.error : undefined,
            bytes_done: asNumber(obj.bytes_done),
            bytes_total: asNumber(obj.bytes_total),
            steps_done: asNumber(obj.steps_done),
            steps_total: asNumber(obj.steps_total),
            result: manifestRoot ? { manifest_root: manifestRoot } : undefined,
          }
        }

        let stopPolling = false
        let lastJob: GatewayUploadJobStatus | null = null as GatewayUploadJobStatus | null

        const gatewayBase = (appConfig.gatewayBase || 'http://localhost:8080').replace(/\/$/, '')
        const uploadId =
          globalThis.crypto && 'randomUUID' in globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`
        const statusUrl = `${gatewayBase}/gateway/upload-status?deal_id=${encodeURIComponent(dealId)}&upload_id=${encodeURIComponent(uploadId)}`
        const url = `${gatewayBase}/gateway/upload?deal_id=${encodeURIComponent(dealId)}&upload_id=${encodeURIComponent(uploadId)}`

        const form = new FormData()
        form.append('deal_id', dealId)
        form.append('file_path', file.name)
        form.append('upload_id', uploadId)
        form.append('file_size_bytes', String(file.size))
        form.append('file', file)

        const pollStatus = async () => {
          while (!stopPolling) {
            try {
              const res = await fetch(statusUrl, { method: 'GET', signal: AbortSignal.timeout(2500) })
              if (res.ok) {
                const job = parseGatewayUploadJobStatus(await res.json().catch(() => null))
                if (job) {
                  lastJob = job
                  const phase = String(job.phase || '').trim()
                  const status = String(job.status || '').trim()
                  const message = String(job.message || '').trim()
                  const bytesDone = Number(job.bytes_done || 0) || 0
                  const bytesTotal = Number(job.bytes_total || 0) || 0
                  const stepsDone = Number(job.steps_done || 0) || 0
                  const stepsTotal = Number(job.steps_total || 0) || 0

                  const phaseLabel = message || phase || status || 'working'
                  const label = `Gateway Mode 2: ${phaseLabel}`

                  const phaseState: ShardPhase =
                    phase === 'receiving'
                      ? 'gateway_receiving'
                      : phase === 'encoding'
                        ? 'gateway_encoding'
                        : phase === 'uploading'
                          ? 'gateway_uploading'
                          : phase === 'done'
                            ? 'done'
                            : 'planning'

                  const useBytes = phaseState === 'gateway_receiving' && bytesTotal > 0
                  const workDone = useBytes ? bytesDone : stepsDone
                  const workTotal = useBytes ? bytesTotal : stepsTotal

                  setShardProgress((p) => ({
                    ...p,
                    phase: phaseState,
                    label,
                    workDone,
                    workTotal,
                    blobsDone: workDone,
                    blobsTotal: workTotal,
                    fileBytesTotal: bytesTotal > 0 ? bytesTotal : p.fileBytesTotal,
                  }))
                }
              }
            } catch {
              // Ignore polling errors; the primary upload request is the source of truth.
            }

            await new Promise((r) => setTimeout(r, 1000))
          }
        }

        const pollPromise = pollStatus()

        try {
          setMode2Uploading(true)
          setShardProgress((p) => ({
            ...p,
            phase: 'gateway_receiving',
            label: 'Gateway Mode 2: starting upload...',
            workDone: 0,
            workTotal: file.size,
            blobsDone: 0,
            blobsTotal: file.size,
            fileBytesTotal: file.size,
            currentOpStartedAtMs: performance.now(),
          }))

          const resp = await fetch(url, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(1_800_000),
          })

          stopPolling = true
          await pollPromise.catch(() => {})

          if (!resp.ok) {
            const txt = await resp.text().catch(() => '')
            const statusErr = String(lastJob?.error || '')
            throw new Error(txt || statusErr || `gateway upload failed (${resp.status})`)
          }

          const payload = (await resp.json().catch(() => null)) as {
            manifest_root?: string
            cid?: string
            size_bytes?: number
            file_size_bytes?: number
            allocated_length?: number
          } | null

          const statusRoot = String(lastJob?.result?.manifest_root || '')
          const root = String(payload?.manifest_root || payload?.cid || statusRoot || '').trim()
          if (!root) throw new Error('gateway upload returned no manifest_root')
          const gatewaySizeBytes = Number(payload?.size_bytes ?? payload?.file_size_bytes ?? file.size) || file.size

          setCurrentManifestRoot(root)
          setCurrentManifestBlob(null)
          setCollectedMdus([])
          setMode2Shards([])
          setMode2UploadError(null)
          setMode2UploadComplete(true)
          addLog(`> Gateway Mode 2 ingest complete. manifest_root=${root}`)
          setShardProgress((p) => ({
            ...p,
            phase: 'done',
            label: 'Gateway Mode 2 ingest complete. Ready to commit.',
            fileBytesTotal: gatewaySizeBytes,
            currentOpStartedAtMs: null,
            lastOpMs: performance.now() - startTs,
          }))
          setProcessing(false)
          return
        } catch (e: unknown) {
          stopPolling = true
          await pollPromise.catch(() => {})

          const msg = e instanceof Error ? e.message : String(e)
          addLog(`> Gateway Mode 2 ingest failed: ${msg}`)

          const unreachable = msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_CONNECTION_REFUSED')
          if (unreachable) {
            addLog('> Gateway unavailable; falling back to in-browser Mode 2 sharding + stripe upload.')

            setMode2UploadError(null)
            setShardProgress((p) => ({
              ...p,
              phase: 'planning',
              label: 'Gateway unavailable; falling back to in-browser sharding...',
              currentOpStartedAtMs: null,
              lastOpMs: performance.now() - startTs,
            }))
          } else {
            setMode2UploadError(msg)
            setShardProgress((p) => ({
              ...p,
              phase: 'error',
              label: `Gateway Mode 2 ingest failed: ${msg}`,
              currentOpStartedAtMs: null,
              lastOpMs: performance.now() - startTs,
            }))
            setProcessing(false)
            return
          }
        } finally {
          setMode2Uploading(false)
        }
      }


      try {
        await ensureWasmReady()
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        addLog(`Error initializing WASM in worker: ${msg}`)
        setShardProgress((p) => ({
          ...p,
          phase: 'error',
          label: `WASM init failed: ${msg}`,
          currentOpStartedAtMs: null,
          lastOpMs: performance.now() - startTs,
        }))
        setProcessing(false)
        return
      }

      const buffer = await file.arrayBuffer()
      console.log(`[Debug] Buffer byteLength: ${buffer.byteLength}`)
      const bytes = new Uint8Array(buffer)
      let baseMdu0Bytes: Uint8Array | null = null;
      let existingUserMdus: { index: number; data: Uint8Array }[] = [];
      let existingUserCount = 0;
    let existingMaxEnd = 0
    let appendStartOffset = 0

    if (useMode2) {
      try {
        const mdu0 = await readMdu(dealId, 0)
        if (mdu0) {
          const files = parseNilfsFilesFromMdu0(mdu0)
          if (files.length > 0) {
            const existing = await inferWitnessCountFromOpfs(dealId, files)
            if (existing.userCount > 0) {
              baseMdu0Bytes = mdu0
              existingUserCount = existing.userCount
              existingMaxEnd = existing.maxEnd
              appendStartOffset = existing.userCount * RawMduCapacity
              for (let i = 0; i < existing.userCount; i++) {
                const mdu = await readMdu(dealId, existing.slabStartIdx + i)
                if (!mdu) {
                  throw new Error(`missing local MDU: mdu_${existing.slabStartIdx + i}.bin`)
                }
                existingUserMdus.push({ index: i, data: mdu })
              }
              addLog(`> Mode 2 append: found ${existing.userCount} existing user MDUs; starting new file at ${formatBytes(appendStartOffset)}.`)
            }
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        addLog(`> Mode 2 append: failed to load existing slab (${msg}).`)
        baseMdu0Bytes = null
        existingUserMdus = []
        existingUserCount = 0
        existingMaxEnd = 0
        appendStartOffset = 0
      }
    }

    const newUserChunks = Math.ceil(bytes.length / RawMduCapacity)
    const totalUserChunks = existingUserCount + newUserChunks
    const totalFileBytes = appendStartOffset + bytes.length
    const witnessBytesPerMdu = leafCount * 48; // commitments per MDU * 48 bytes
    const witnessMduCount = Math.max(1, Math.ceil((witnessBytesPerMdu * totalUserChunks) / RawMduCapacity));
    addLog(`DEBUG: File bytes: ${bytes.length}, RawMduCapacity: ${RawMduCapacity}, TotalUserMdus: ${totalUserChunks}`);
    console.log('[perf] sharding start', {
      file: file.name,
      rawBytes: bytes.length,
      rawMduCapacity: RawMduCapacity,
      totalUserMdus: totalUserChunks,
      witnessMduCount,
    });

    const BLOBS_PER_MDU = 64;
    const BLOB_BYTES = 128 * 1024;
    const SCALAR_PAYLOAD_BYTES = 31;
    const SCALAR_BYTES = 32;
    const TRIVIAL_BLOB_WEIGHT = 0.1;

    const nonTrivialBlobsForPayload = (payloadBytes: number): number => {
      if (!Number.isFinite(payloadBytes) || payloadBytes <= 0) return 0;
      // Encode raw bytes into 32-byte scalars carrying 31 bytes each, then pack into 128KiB blobs.
      const scalarsUsed = Math.ceil(payloadBytes / SCALAR_PAYLOAD_BYTES);
      const encodedBytes = scalarsUsed * SCALAR_BYTES;
      const blobsUsed = Math.ceil(encodedBytes / BLOB_BYTES);
      return Math.max(0, Math.min(BLOBS_PER_MDU, blobsUsed));
    };

    const weightedWorkForMdu = (nonTrivialBlobs: number): number => {
      const nt = Math.max(0, Math.min(BLOBS_PER_MDU, nonTrivialBlobs));
      const trivial = BLOBS_PER_MDU - nt;
      return nt + trivial * TRIVIAL_BLOB_WEIGHT;
    };

    // Plan "work" units so ETA doesn't treat trailing zero blobs as expensive.
    // - User MDUs: payload bytes are the raw chunk length.
    // - Witness MDUs: payload bytes are witness bytes (64 commitments * 48 bytes per user MDU).
    // - MDU #0: not scalar-encoded; approximate as 1 non-trivial blob (roots + header) and 63 trivial blobs.
    const totalWitnessPayloadBytes = totalUserChunks * witnessBytesPerMdu;
    const witnessPayloads: number[] = [];
    for (let remaining = totalWitnessPayloadBytes, i = 0; i < witnessMduCount; i++) {
      const take = Math.max(0, Math.min(RawMduCapacity, remaining));
      witnessPayloads.push(take);
      remaining -= take;
    }

    const userPayloads: number[] = [];
    for (let i = 0; i < existingUserCount; i++) {
      const start = i * RawMduCapacity;
      const end = Math.min(start + RawMduCapacity, existingMaxEnd);
      userPayloads.push(Math.max(0, end - start));
    }
    for (let i = 0; i < newUserChunks; i++) {
      const start = i * RawMduCapacity;
      const end = Math.min(start + RawMduCapacity, bytes.length);
      userPayloads.push(Math.max(0, end - start));
    }

    const workTotal =
      weightedWorkForMdu(1) +
      witnessPayloads.reduce((acc, n) => acc + weightedWorkForMdu(nonTrivialBlobsForPayload(n)), 0) +
      userPayloads.reduce((acc, n) => acc + weightedWorkForMdu(nonTrivialBlobsForPayload(n)), 0);

    setShardProgress((p) => ({
      ...p,
      phase: 'planning',
      label: 'Planning slab layout...',
      blobsPerMdu: useMode2 ? leafCount : 64,
      blobsTotal: (1 + witnessMduCount + totalUserChunks) * (useMode2 ? leafCount : 64),
      blobsDone: 0,
      blobsInCurrentMdu: 0,
      workDone: 0,
      workTotal,
      fileBytesTotal: totalFileBytes,
      totalUserMdus: totalUserChunks,
      totalWitnessMdus: witnessMduCount,
      currentOpStartedAtMs: null,
      currentMduIndex: null,
      currentMduKind: null,
    }));

    setShards(() => {
      const items: ShardItem[] = [];
      items.push({ id: 0, commitments: ['MDU #0'], status: 'pending' });
      for (let i = 0; i < witnessMduCount; i++) {
        items.push({ id: 1 + i, commitments: ['Witness'], status: 'pending' });
      }
      for (let i = 0; i < totalUserChunks; i++) {
        items.push({ id: 1 + witnessMduCount + i, commitments: ['User Data'], status: 'pending' });
      }
      return items;
    });

    const toU8 = (v: Uint8Array | number[]): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v));

    try {
        const commitmentsPerMdu = useMode2
          ? (rsK + rsM) * (64 / rsK)
          : undefined
        const appendMode2 = useMode2 && baseMdu0Bytes && existingUserCount > 0
        if (appendMode2 && baseMdu0Bytes) {
          const mdu0Copy = new Uint8Array(baseMdu0Bytes)
          await workerClient.loadMdu0Builder(mdu0Copy, totalUserChunks, commitmentsPerMdu);
        } else {
          await workerClient.initMdu0Builder(totalUserChunks, commitmentsPerMdu);
        }

        let mdusCommitted = 0;
        let workCommitted = 0;
        let prevCommitMsPerMdu: number | null = null;

        const pickBatchBlobs = (prevMduMs: number | null): number => {
          const TARGET_UPDATE_MS = 2500;
          const MIN_BATCH = 4;
          const MAX_BATCH = 16;
          if (!prevMduMs || !Number.isFinite(prevMduMs) || prevMduMs <= 0) return MIN_BATCH;
          const msPerBlob = prevMduMs / BLOBS_PER_MDU;
          const est = Math.round(TARGET_UPDATE_MS / Math.max(1, msPerBlob));
          return Math.max(MIN_BATCH, Math.min(MAX_BATCH, est));
        };

        const userRoots: Uint8Array[] = [];
        const userMdus: { index: number, data: Uint8Array }[] = [];
        const witnessDataBlobs: Uint8Array[] = [];
        const mode2UserShards: { index: number; shards: Uint8Array[] }[] = [];

        for (let i = 0; i < totalUserChunks; i++) {
            const opStart = performance.now();
            const isExisting = appendMode2 && i < existingUserCount;
            const nonTrivialBlobs = nonTrivialBlobsForPayload(userPayloads[i] ?? 0);
            const workTotalThisMdu = weightedWorkForMdu(nonTrivialBlobs);
            setShardProgress((p) => ({
              ...p,
              phase: 'shard_user',
              label: `Sharding user MDU #${i}...`,
              currentOpStartedAtMs: opStart,
              currentMduKind: 'user',
              currentMduIndex: i,
              blobsInCurrentMdu: 0,
              blobsDone: mdusCommitted * BLOBS_PER_MDU,
              workDone: workCommitted,
            }));
            setShards((prev) =>
              prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'processing' } : s)),
            );

            let rawChunk = new Uint8Array();
            let encodedMdu: Uint8Array;
            let encodeMs = 0;

            if (isExisting) {
              encodedMdu = existingUserMdus[i].data;
            } else {
              const newIndex = i - existingUserCount;
              const start = newIndex * RawMduCapacity;
              const end = Math.min(start + RawMduCapacity, bytes.length);
              rawChunk = bytes.subarray(start, end);
              const encodeStart = performance.now();
              encodedMdu = encodeToMdu(rawChunk);
              encodeMs = performance.now() - encodeStart;
            }

            userMdus.push({ index: i, data: encodedMdu });
            const copyStart = performance.now();
            const chunkCopy = new Uint8Array(encodedMdu);
            const copyMs = performance.now() - copyStart;

            if (useMode2) {
              addLog(`> Sharding User MDU #${i}${isExisting ? ' (existing)' : ''} (RS ${rsK}+${rsM})...`);
              const wasmStart = performance.now();
              const result = await workerClient.expandMduRs(chunkCopy, rsK, rsM);
              const wasmMs = performance.now() - wasmStart;

              const rootBytes = toU8(result.mdu_root);
              userRoots.push(rootBytes);
              const witnessFlat = toU8(result.witness_flat);
              witnessDataBlobs.push(witnessFlat);
              const shardsList = result.shards.map((s) => toU8(s));
              if (!isExisting) {
                mode2UserShards.push({ index: i, shards: shardsList });
              }

              const opMs = performance.now() - opStart;
              console.log('[perf] user mdu (mode2)', {
                i,
                rawBytes: isExisting ? userPayloads[i] ?? 0 : rawChunk.byteLength,
                encodeMs,
                copyMs,
                wasmMs,
                totalMs: opMs,
              });
              prevCommitMsPerMdu = opMs;
              mdusCommitted += 1;
              workCommitted += workTotalThisMdu;
              setShardProgress((p) => {
                const blobsDone = mdusCommitted * BLOBS_PER_MDU;
                const avg =
                  p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
                return {
                  ...p,
                  blobsDone,
                  blobsInCurrentMdu: BLOBS_PER_MDU,
                  currentOpStartedAtMs: null,
                  lastOpMs: opMs,
                  workDone: workCommitted,
                  avgWorkMs: avg,
                };
              });
              setShards((prev) =>
                prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'expanded' } : s)),
              );
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              continue;
            }

            addLog(`> Sharding User MDU #${i}...`);
            const batchBlobs = pickBatchBlobs(prevCommitMsPerMdu);
            const wasmStart = performance.now();
            const result = await workerClient.shardFileProgressive(chunkCopy, {
              batchBlobs,
              onProgress: (progress) => {
                const payload = progress as { kind?: string; done?: number; total?: number };
                if (payload.kind !== 'blob') return;
                const done = Number(payload.done ?? 0);
                setShardProgress((prev) => {
                  const blobsDone = mdusCommitted * BLOBS_PER_MDU + done;
                  const doneNonTrivial = Math.min(done, nonTrivialBlobs);
                  const doneTrivial = Math.max(0, done - nonTrivialBlobs);
                  const workInMdu = doneNonTrivial + doneTrivial * TRIVIAL_BLOB_WEIGHT;
                  const workDone = workCommitted + Math.min(workTotalThisMdu, workInMdu);
                  return {
                    ...prev,
                    blobsInCurrentMdu: done,
                    blobsDone,
                    workDone,
                    avgWorkMs:
                      prev.startTsMs && workDone > 0 ? (performance.now() - prev.startTsMs) / workDone : prev.avgWorkMs,
                  };
                });
              },
            });
            const wasmMs = performance.now() - wasmStart;

            const rootBytes = toU8(result.mdu_root);
            userRoots.push(rootBytes);
            console.log(
              `[Debug] User MDU Root #${i}: 0x${Array.from(rootBytes)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')}`,
            );

            const witnessFlat = toU8(result.witness_flat);
            witnessDataBlobs.push(witnessFlat);

            const opMs = performance.now() - opStart;
            console.log('[perf] user mdu', {
              i,
              rawBytes: rawChunk.byteLength,
              batchBlobs,
              encodeMs,
              copyMs,
              wasmMs,
              totalMs: opMs,
            });
            prevCommitMsPerMdu = opMs;
            mdusCommitted += 1;
            workCommitted += workTotalThisMdu;
            setShardProgress((p) => {
              const blobsDone = mdusCommitted * BLOBS_PER_MDU;
              const avg =
                p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
              return {
                ...p,
                blobsDone,
                blobsInCurrentMdu: 0,
                currentOpStartedAtMs: null,
                lastOpMs: opMs,
                workDone: workCommitted,
                avgWorkMs: avg,
              };
            });
            setShards((prev) =>
              prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'expanded' } : s)),
            );
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }

        if (useMode2) {
          setMode2Shards(mode2UserShards);
        }

        const fullWitnessData = new Uint8Array(witnessDataBlobs.reduce((acc, b) => acc + b.length, 0));
        let offset = 0;
        for (const b of witnessDataBlobs) {
            fullWitnessData.set(b, offset);
            offset += b.length;
        }

        const witnessRoots: Uint8Array[] = [];
        const witnessMdus: { index: number, data: Uint8Array }[] = [];
        
        const actualWitnessMduCount = Math.ceil(fullWitnessData.length / RawMduCapacity);
        if (actualWitnessMduCount !== witnessMduCount) {
          throw new Error(`witness_mdu_count mismatch (expected ${witnessMduCount}, got ${actualWitnessMduCount})`);
        }
        
        for (let i = 0; i < witnessMduCount; i++) {
            const opStart = performance.now();
            const nonTrivialBlobs = nonTrivialBlobsForPayload(witnessPayloads[i] ?? 0);
            const workTotalThisMdu = weightedWorkForMdu(nonTrivialBlobs);
            setShardProgress((p) => ({
              ...p,
              phase: 'shard_witness',
              label: `Sharding witness MDU #${i}...`,
              currentOpStartedAtMs: opStart,
              currentMduKind: 'witness',
              currentMduIndex: i,
              blobsInCurrentMdu: 0,
              blobsDone: mdusCommitted * BLOBS_PER_MDU,
              workDone: workCommitted,
            }));
            setShards((prev) => prev.map((s) => (s.id === 1 + i ? { ...s, status: 'processing' } : s)));

            const encodeStart = performance.now();
            const start = i * RawMduCapacity;
            const end = Math.min(start + RawMduCapacity, fullWitnessData.length);
            const rawChunk = fullWitnessData.subarray(start, end);
            const witnessMduBytes = encodeToMdu(rawChunk);
            const encodeMs = performance.now() - encodeStart;

            addLog(`> Sharding Witness MDU #${i}...`);
            console.log(`[Debug] Sharding Witness MDU #${i} size=${witnessMduBytes.length}`);
            const copyStart = performance.now();
            const chunkCopy = new Uint8Array(witnessMduBytes);
            const copyMs = performance.now() - copyStart;
            const batchBlobs = pickBatchBlobs(prevCommitMsPerMdu);
            const wasmStart = performance.now();
            const result = await workerClient.shardFileProgressive(chunkCopy, {
              batchBlobs,
              onProgress: (progress) => {
                const payload = progress as { kind?: string; done?: number; total?: number };
                if (payload.kind !== 'blob') return;
                const done = Number(payload.done ?? 0);
                setShardProgress((prev) => {
                  const blobsDone = mdusCommitted * BLOBS_PER_MDU + done;
                  const doneNonTrivial = Math.min(done, nonTrivialBlobs);
                  const doneTrivial = Math.max(0, done - nonTrivialBlobs);
                  const workInMdu = doneNonTrivial + doneTrivial * TRIVIAL_BLOB_WEIGHT;
                  const workDone = workCommitted + Math.min(workTotalThisMdu, workInMdu);
                  return {
                    ...prev,
                    blobsInCurrentMdu: done,
                    blobsDone,
                    workDone,
                    avgWorkMs:
                      prev.startTsMs && workDone > 0 ? (performance.now() - prev.startTsMs) / workDone : prev.avgWorkMs,
                  };
                });
              },
            });
            const wasmMs = performance.now() - wasmStart;

            const rootBytes = toU8(result.mdu_root);
            witnessRoots.push(rootBytes);
            witnessMdus.push({ index: 1 + i, data: witnessMduBytes }); 
            
            await workerClient.setMdu0Root(i, rootBytes);

            const opMs = performance.now() - opStart;
            console.log('[perf] witness mdu', {
              i,
              rawBytes: rawChunk.byteLength,
              batchBlobs,
              encodeMs,
              copyMs,
              wasmMs,
              totalMs: opMs,
            });
            prevCommitMsPerMdu = opMs;
            mdusCommitted += 1;
            workCommitted += workTotalThisMdu;
            setShardProgress((p) => {
              const blobsDone = mdusCommitted * BLOBS_PER_MDU;
              const avg =
                p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
              return {
                ...p,
                blobsDone,
                blobsInCurrentMdu: 0,
                currentOpStartedAtMs: null,
                lastOpMs: opMs,
                workDone: workCommitted,
                avgWorkMs: avg,
              };
            });
            setShards((prev) => prev.map((s) => (s.id === 1 + i ? { ...s, status: 'expanded' } : s)));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }

        for (let i = 0; i < userRoots.length; i++) {
            await workerClient.setMdu0Root(witnessMduCount + i, userRoots[i]);
        }

        const fileStartOffset = appendMode2 ? appendStartOffset : 0;
        const recordPath = sanitizeNilfsRecordPath(file.name);
        if (recordPath !== file.name) {
          addLog(`> NilFS path truncated for V1 record table (max ${NILFS_RECORD_PATH_MAX_BYTES} bytes): ${recordPath}`);
        }
        await workerClient.appendFileToMdu0(recordPath, file.size, fileStartOffset);

        addLog(`> Finalizing MDU #0...`);
        const opStartMdu0 = performance.now();
        const workTotalThisMdu0 = weightedWorkForMdu(1);
        setShardProgress((p) => ({
          ...p,
          phase: 'finalize_mdu0',
          label: 'Finalizing MDU #0...',
          currentOpStartedAtMs: opStartMdu0,
          currentMduKind: 'meta',
          currentMduIndex: 0,
          blobsInCurrentMdu: 0,
          blobsDone: mdusCommitted * BLOBS_PER_MDU,
          workDone: workCommitted,
        }));
        setShards((prev) => prev.map((s) => (s.id === 0 ? { ...s, status: 'processing' } : s)));
        const mdu0FetchStart = performance.now();
        const mdu0Bytes = await workerClient.getMdu0Bytes();
        const mdu0FetchMs = performance.now() - mdu0FetchStart;

        const mdu0CopyStart = performance.now();
        const mdu0Copy = new Uint8Array(mdu0Bytes);
        const mdu0CopyMs = performance.now() - mdu0CopyStart;
        const mdu0BatchBlobs = pickBatchBlobs(prevCommitMsPerMdu);
        const wasmStart = performance.now();
        const mdu0Result = await workerClient.shardFileProgressive(mdu0Copy, {
          batchBlobs: mdu0BatchBlobs,
          onProgress: (progress) => {
            const payload = progress as { kind?: string; done?: number; total?: number };
            if (payload.kind !== 'blob') return;
            const done = Number(payload.done ?? 0);
            setShardProgress((prev) => {
              const blobsDone = mdusCommitted * BLOBS_PER_MDU + done;
              const doneNonTrivial = Math.min(done, 1);
              const doneTrivial = Math.max(0, done - 1);
              const workInMdu = doneNonTrivial + doneTrivial * TRIVIAL_BLOB_WEIGHT;
              const workDone = workCommitted + Math.min(workTotalThisMdu0, workInMdu);
              return {
                ...prev,
                blobsInCurrentMdu: done,
                blobsDone,
                workDone,
                avgWorkMs:
                  prev.startTsMs && workDone > 0 ? (performance.now() - prev.startTsMs) / workDone : prev.avgWorkMs,
              };
            });
          },
        });
        const wasmMs = performance.now() - wasmStart;
        const mdu0Root = toU8(mdu0Result.mdu_root);
        setShards((prev) => prev.map((s) => (s.id === 0 ? { ...s, status: 'expanded' } : s)));
        const opMs = performance.now() - opStartMdu0;
        console.log('[perf] meta mdu0', {
          fetchMs: mdu0FetchMs,
          copyMs: mdu0CopyMs,
          batchBlobs: mdu0BatchBlobs,
          wasmMs,
          totalMs: opMs,
        });
        prevCommitMsPerMdu = opMs;
        mdusCommitted += 1;
        workCommitted += workTotalThisMdu0;
        setShardProgress((p) => {
          const blobsDone = mdusCommitted * BLOBS_PER_MDU;
          const avg =
            p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
          return {
            ...p,
            blobsDone,
            blobsInCurrentMdu: 0,
            currentOpStartedAtMs: null,
            lastOpMs: opMs,
            workDone: workCommitted,
            avgWorkMs: avg,
          };
        });

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
        setShardProgress((p) => ({
          ...p,
          phase: 'compute_manifest',
          label: 'Computing manifest commitment...',
          currentOpStartedAtMs: null,
          currentMduKind: null,
          currentMduIndex: null,
        }));
        const manifestStart = performance.now();
        const manifest = await workerClient.computeManifest(allRoots);
        const manifestMs = performance.now() - manifestStart;
        console.log('[perf] manifest aggregation', { ms: manifestMs, roots: allRoots.length / 32 });
        
        const finalMdus = [
          { index: 0, data: mdu0Bytes },
          ...witnessMdus,
          ...userMdus.map((m) => ({ index: 1 + witnessMduCount + m.index, data: m.data })),
        ];

        const finalRootHex = '0x' + Array.from(manifest.root).map(b => b.toString(16).padStart(2, '0')).join('');
        const finalManifestBlob = toU8((manifest as unknown as { blob: Uint8Array | number[] }).blob);

        setCollectedMdus(finalMdus);
        setCurrentManifestRoot(finalRootHex);
        setCurrentManifestBlob(finalManifestBlob);
        
        setShardProgress((p) => ({
          ...p,
          phase: 'done',
          label: 'Client-side expansion complete.',
          currentOpStartedAtMs: null,
          currentMduIndex: null,
          currentMduKind: null,
          blobsDone: p.blobsTotal,
          blobsInCurrentMdu: 0,
        }));

        addLog(`> Manifest Root: ${finalRootHex.slice(0, 16)}...`);
        console.log(`[Debug] Full Manifest Root: ${finalRootHex}`);
        addLog(
          useMode2
            ? `> Total MDUs: ${finalMdus.length} (1 Meta + ${witnessMduCount} Witness + ${userMdus.length} User); ${mode2UserShards.length} new striped user MDUs`
            : `> Total MDUs: ${finalMdus.length} (1 Meta + ${witnessMduCount} Witness + ${userMdus.length} User)`,
        );

        console.log('[perf] sharding totals', {
          totalMs: performance.now() - startTs,
          fileBytes: bytes.length,
          totalMdus: finalMdus.length,
          totalUserMdus: totalUserChunks,
          totalWitnessMdus: witnessMduCount,
          manifestMs,
        });

        const elapsedMs = performance.now() - startTs;
        const mib = file.size / (1024 * 1024);
        const seconds = elapsedMs / 1000;
        const avgMibPerSec = seconds > 0 ? mib / seconds : 0;
        const speedStr = `${avgMibPerSec.toFixed(2)} MiB/s (file avg)`;
        addLog(
          `Done. Client-side expansion complete. Time: ${formatDuration(elapsedMs)}. Data: ${formatBytes(
            file.size,
          )}. Speed: ${speedStr}.`,
        );

    } catch (e: unknown) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        addLog(`Error: ${msg}`);
        setShardProgress((p) => ({
          ...p,
          phase: 'error',
          label: msg,
          currentOpStartedAtMs: null,
          currentMduIndex: null,
          currentMduKind: null,
        }));
        setShards([]);
    } finally {
        setProcessing(false);
    }
  }, [addLog, dealId, ensureWasmReady, gatewayMode2Enabled, isConnected, resetUpload, stripeParams]);

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

  const isAlreadyCommitted = isCommitSuccess && lastCommitRef.current === currentManifestRoot;
  const hasManifestRoot = Boolean(currentManifestRoot && currentManifestRoot.trim());
  const readyToUpload =
    hasManifestRoot &&
    !isUploadComplete &&
    (collectedMdus.length > 0 || (isMode2 && mode2Shards.length > 0));
  const readyToCommit = hasManifestRoot && isUploadComplete && !isAlreadyCommitted;
  const hasError = shardProgress.phase === 'error' || Boolean(mode2UploadError) || Boolean(commitError);
  const showStatusPanel =
    processing ||
    activeUploading ||
    readyToUpload ||
    readyToCommit ||
    isCommitPending ||
    isCommitConfirming ||
    isAlreadyCommitted ||
    hasError;

  useEffect(() => {
    const node = logContainerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [logs.length, processing, activeUploading, readyToCommit, isCommitPending, isCommitConfirming, isAlreadyCommitted, hasError]);

  return (
    <div className="w-full space-y-4">
      {!isConnected ? (
        <button
          onClick={() => connectAsync({ connector: injectedConnector })}
          className="w-full rounded-xl border border-dashed border-border bg-background/60 px-6 py-10 text-center transition-all hover:border-primary/50 hover:bg-secondary/40"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary/60">
            <Wallet className="h-6 w-6 text-foreground" />
          </div>
          <div className="text-sm font-semibold text-foreground">Connect wallet to upload</div>
          <div className="mt-1 text-xs text-muted-foreground">Deals and files are owned by your Nil address.</div>
        </button>
      ) : (
        <>
          {/* Dropzone */}
          {!stripeParamsLoaded ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center">
              <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-border border-t-primary" />
              <div className="text-sm font-semibold text-foreground">Loading deal settings…</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Checking redundancy mode and gateway availability.
              </div>
            </div>
          ) : wasmStatus === 'ready' || (isMode2 && gatewayMode2Enabled) ? (
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={`
                border-2 border-dashed rounded-xl p-6 transition-all duration-200
                ${isDragging
                  ? 'border-primary bg-primary/10 scale-[1.01]'
                  : 'border-border hover:border-primary/50 bg-card'
                }
              `}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
                    <Cpu className="h-5 w-5 text-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">Upload a file</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {isMode2 && gatewayMode2Enabled
                        ? gatewayReachable
                          ? 'Local gateway connected (fast path).'
                          : 'No local gateway detected (in-browser sharding).'
                        : 'In-browser sharding.'}
                    </div>
                  </div>
                </div>
                <label className="inline-flex w-full cursor-pointer items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 sm:w-auto">
                  Choose file
                  <input type="file" className="hidden" onChange={handleFileSelect} data-testid="mdu-file-input" />
                </label>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-8 text-center">
              <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-border border-t-primary" />
              <div className="text-sm font-semibold text-foreground">Preparing WASM…</div>
              <div className="mt-1 text-xs text-muted-foreground">
                This only runs in your browser. Once ready, the file picker will appear.
              </div>
            </div>
          )}

      {showStatusPanel && (
        <div className="bg-card rounded-xl border border-border p-4 shadow-sm text-sm">
          <p className="font-bold text-foreground mb-2">Current Activity:</p>
          <div className="space-y-2">
            {hasError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                {commitError ? `Commit failed: ${commitError.message}` : null}
                {commitError && mode2UploadError ? <span className="mx-2 text-border">|</span> : null}
                {mode2UploadError ? `Upload failed: ${mode2UploadError}` : null}
                {!commitError && !mode2UploadError && shardProgress.label ? shardProgress.label : null}
              </div>
            ) : null}

            {processing && (
              <div className="space-y-2" data-testid="wasm-sharding-progress">
                <div className="flex items-start justify-between gap-3">
                  <p className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 animate-spin text-blue-500" />
                    <span className="font-semibold">
                      {isMode2 && gatewayMode2Enabled && shardProgress.label.startsWith('Gateway Mode 2')
                        ? 'Gateway ingest'
                        : 'WASM Sharding'}
                    </span>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-muted-foreground">
                      {isMode2 && gatewayMode2Enabled && shardProgress.label.startsWith('Gateway Mode 2')
                        ? shardProgress.label
                        : shardingUi.phaseDetails || 'Working...'}
                    </span>
                  </p>
                  <div className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                    {isMode2 && gatewayMode2Enabled && shardProgress.label.startsWith('Gateway Mode 2') ? (
                      shardProgress.phase === 'gateway_receiving' && shardProgress.workTotal > 0 ? (
                        `${formatBytes(shardProgress.workDone)} / ${formatBytes(shardProgress.workTotal)}`
                      ) : shardProgress.workTotal > 0 ? (
                        `${shardProgress.workDone}/${shardProgress.workTotal} steps`
                      ) : (
                        '—'
                      )
                    ) : (
                      `${shardProgress.blobsDone}/${shardProgress.blobsTotal} blobs`
                    )}
                  </div>
                </div>

                <div className="h-2 w-full overflow-hidden rounded-full bg-secondary/70 border border-border">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-purple-500 to-fuchsia-500 transition-[width] duration-300 ease-out"
                    style={{ width: `${(shardingUi.overallPct * 100).toFixed(1)}%` }}
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono text-muted-foreground">
                  <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                    <div className="opacity-70">Elapsed</div>
                    <div className="text-foreground">{formatDuration(shardingUi.elapsedMs)}</div>
                  </div>
                  <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                    <div className="opacity-70">ETA</div>
                    <div className="text-foreground">
                      {shardingUi.etaMs == null ? '—' : formatDuration(shardingUi.etaMs)}
                    </div>
                  </div>
                  <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                    <div className="opacity-70">Speed (recent)</div>
                    <div className="text-foreground">{shardingUi.mibPerSec.toFixed(2)} MiB/s</div>
                  </div>
                  <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                    <div className="opacity-70">Op Time</div>
                    <div className="text-foreground">
                      {shardProgress.currentOpStartedAtMs
                        ? formatDuration(shardingUi.currentOpMs)
                        : shardProgress.lastOpMs != null
                          ? formatDuration(shardProgress.lastOpMs)
                          : '—'}
                    </div>
                  </div>
                </div>

                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer select-none hover:text-foreground">
                    Under the hood
                  </summary>
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono">
                    <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                      <div className="opacity-70">File</div>
                      <div className="text-foreground">{formatBytes(shardProgress.fileBytesTotal)}</div>
                    </div>
                    <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                      <div className="opacity-70">MDUs</div>
                      <div className="text-foreground">
                        {shardProgress.totalUserMdus} user • {shardProgress.totalWitnessMdus} witness • 1 meta
                      </div>
                    </div>
                    <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                      <div className="opacity-70">Blobs</div>
                      <div className="text-foreground">
                        {shardProgress.blobsDone}/{shardProgress.blobsTotal}
                      </div>
                    </div>
                    <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                      <div className="opacity-70">Phase</div>
                      <div className="text-foreground">{shardProgress.phase}</div>
                    </div>
                    <div className="bg-secondary/40 border border-border rounded px-2 py-1">
                      <div className="opacity-70">Current</div>
                      <div className="text-foreground">
                        {shardProgress.currentMduKind
                          ? `${shardProgress.currentMduKind} #${String(shardProgress.currentMduIndex ?? 0)}`
                          : '—'}
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            )}

            {activeUploading && (
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <FileJson className="w-4 h-4 animate-pulse text-green-500" />
                {isMode2 ? 'Uploading Mode 2 shards to Storage Providers...' : 'Uploading MDUs directly to Storage Provider...'}
              </p>
            )}

            {readyToUpload && !processing && !activeUploading ? (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
                Expansion complete. Ready to upload to Storage Providers.
              </div>
            ) : null}

            {readyToCommit && !processing && !activeUploading ? (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
                Upload complete. Commit the manifest root to update your deal on-chain and make the file visible in the Deal Explorer.
              </div>
            ) : null}

            {(isCommitPending || isCommitConfirming) && (
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <FileJson className="w-4 h-4 animate-pulse text-purple-500" /> Committing manifest root to chain...
              </p>
            )}

            {readyToCommit || isCommitPending || isCommitConfirming || isAlreadyCommitted ? (
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    const totalSize = isMode2
                      ? shardProgress.fileBytesTotal
                      : collectedMdus.reduce((acc, m) => acc + m.data.length, 0);
                    commitContent({
                      dealId,
                      manifestRoot: currentManifestRoot || '',
                      fileSize: totalSize,
                    });
                  }}
                  disabled={!readyToCommit || isCommitPending || isCommitConfirming || isAlreadyCommitted}
                  data-testid="mdu-commit"
                  className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-blue-500 disabled:opacity-50"
                >
                  {isCommitPending
                    ? 'Check Wallet...'
                    : isCommitConfirming
                      ? 'Confirming...'
                      : isAlreadyCommitted
                        ? 'Committed!'
                        : 'Commit to Chain'}
                </button>

                {commitHash && (
                  <div className="text-xs text-muted-foreground truncate">
                    Tx: {commitHash}
                  </div>
                )}
              </div>
            ) : null}

            {logs.length > 0 ? (
              <div className="mt-2 p-3 bg-secondary/50 rounded border border-border text-xs font-mono text-muted-foreground">
                <p className="mb-2 text-primary font-bold">System Activity:</p>
                <div ref={logContainerRef} className="space-y-1 max-h-32 overflow-y-auto">
                  {logs.map((log, i) => (
                    <p key={i}>{log}</p>
                  ))}
                  {processing && <p className="animate-pulse">...</p>}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Upload to SP Button */}
      {collectedMdus.length > 0 && currentManifestRoot && (
        <div className="flex flex-col gap-2">
            <button
              onClick={async () => {
                const ok = isMode2 ? await uploadMode2() : await uploadMdus(collectedMdus)
                if (ok) void mirrorSlabToGateway()
              }}
              disabled={activeUploading || processing || isUploadComplete}
              data-testid="mdu-upload"
              className={`mt-4 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-semibold shadow-sm transition-colors disabled:opacity-50 ${isUploadComplete ? 'bg-green-600/50 text-white cursor-not-allowed' : 'bg-green-600 hover:bg-green-500 text-primary-foreground'}`}
            >
              {activeUploading
                ? 'Uploading...'
                : isUploadComplete
                  ? 'Upload Complete'
                  : isMode2
                    ? `Upload Stripes (Mode 2)`
                    : `Upload ${collectedMdus.length} MDUs to SP`}
            </button>

            {!isMode2 && (activeUploading || isUploadComplete) && uploadProgress.length > 0 && (
              <div className="mt-2 p-3 bg-secondary/50 rounded border border-border text-xs font-mono text-muted-foreground">
                <p className="mb-1 text-primary font-bold">Upload Progress:</p>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {uploadProgress.map((p, i) => (
                      <div key={i} className="flex justify-between items-center">
                      <span>{p.label}:</span>
                      <span className={`font-bold ${p.status === 'complete' ? 'text-green-500' : p.status === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>
                        {p.status.toUpperCase()} {p.error ? `(${p.error})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isMode2 && mode2UploadError && (
              <div className="text-[11px] text-red-500">
                Mode 2 upload failed: {mode2UploadError}
              </div>
            )}

            {mirrorStatus !== 'idle' && (
              <div
                className={`text-[11px] ${mirrorStatus === 'error' ? 'text-red-500' : 'text-muted-foreground'}`}
              >
                Gateway mirror: {mirrorStatus === 'skipped' ? 'skipped' : mirrorStatus}
                {mirrorError ? ` (${mirrorError})` : ''}
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
        </div>
      )}
      </>
      )}
    </div>
  );
}
