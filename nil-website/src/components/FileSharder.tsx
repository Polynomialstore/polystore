import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { FileJson, Cpu, Wallet } from 'lucide-react';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { workerClient } from '../lib/worker-client';
import { useDirectUpload } from '../hooks/useDirectUpload'; // New import
import { useDirectCommit } from '../hooks/useDirectCommit'; // New import
import { appConfig } from '../config';
import { NILFS_RECORD_PATH_MAX_BYTES, sanitizeNilfsRecordPath } from '../lib/nilfsPath';
import {
  listDealFiles,
  readManifestBlob,
  readManifestRoot,
  readMdu,
  readShard,
  writeSlabGenerationAtomically,
} from '../lib/storage/OpfsAdapter';
import { parseNilfsFilesFromMdu0 } from '../lib/nilfsLocal';
import { inferWitnessCountFromOpfs, RAW_MDU_CAPACITY } from '../lib/nilfsOpfsFetch';
import { lcdFetchDeal } from '../api/lcdClient';
import { parseServiceHint } from '../lib/serviceHint';
import { resolveProviderEndpoints } from '../lib/providerDiscovery';
import { useLocalGateway } from '../hooks/useLocalGateway';
import { maybeWrapNilceZstd, peekNilceHeader, NILCE_FLAG_COMPRESSION_ZSTD } from '../lib/nilce';
import { isTrustedLocalGatewayBase } from '../lib/transport/mode';

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

function alternateLoopbackBase(baseUrl: string): string | null {
  const raw = String(baseUrl || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost') {
      parsed.hostname = '127.0.0.1'
      return parsed.toString().replace(/\/$/, '')
    }
    if (host === '127.0.0.1') {
      parsed.hostname = 'localhost'
      return parsed.toString().replace(/\/$/, '')
    }
    return null
  } catch {
    return null
  }
}

function localGatewayCandidates(baseUrl: string): string[] {
  const seed = String(baseUrl || '').trim().replace(/\/$/, '')
  const candidates: string[] = []
  const push = (value: string | null | undefined) => {
    const clean = String(value || '').trim().replace(/\/$/, '')
    if (!clean) return
    if (!isTrustedLocalGatewayBase(clean)) return
    if (!candidates.includes(clean)) candidates.push(clean)
  }
  push(seed)
  push('http://127.0.0.1:8080')
  push('http://localhost:8080')
  if (isTrustedLocalGatewayBase(seed)) {
    push(alternateLoopbackBase(seed))
  }
  return candidates
}

function isGatewayNetworkError(msg: string): boolean {
  const text = String(msg || '')
  const lower = text.toLowerCase()
  return (
    lower.includes('failed to fetch') ||
    lower.includes('load failed') ||
    lower.includes('cors') ||
    lower.includes('cross-origin') ||
    lower.includes('networkerror') ||
    lower.includes('err_connection_refused') ||
    lower.includes('econnrefused') ||
    lower.includes('connection refused') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('connect refused') ||
    lower.includes('network is down') ||
    lower.includes('offline') ||
    lower.includes('timeout') ||
    lower.includes('could not connect') ||
    lower.includes('name resolution')
  )
}

function isProviderUploadConnectivityError(msg: string): boolean {
  const text = String(msg || '')
  const lower = text.toLowerCase()
  const providerPath =
    lower.includes('provider upload failed') ||
    lower.includes('mode2 provider upload failed') ||
    lower.includes('/sp/upload_mdu') ||
    lower.includes('/sp/upload')
  if (!providerPath) return false
  return (
    lower.includes('connection refused') ||
    lower.includes('econnrefused') ||
    lower.includes('dial tcp') ||
    lower.includes('failed to fetch') ||
    lower.includes('load failed') ||
    lower.includes('networkerror') ||
    lower.includes('timeout') ||
    lower.includes('connect refused')
  )
}

function formatGatewayError(error: unknown): string {
  if (error instanceof Error) {
    const name = String(error.name || '').trim()
    const message = String(error.message || '').trim()
    if (name && message) return `${name}: ${message}`
    return message || String(error)
  }
  return String(error || '')
}

const gatewayUploadPollIntervalMs = 1000
const gatewayUploadPollTimeoutMs = 2500
const gatewayUploadHeartbeatStaleMs = 15_000
const gatewayFallbackWasmMaxFileBytes = 32 * 1024 * 1024

export function FileSharder({ dealId, onCommitSuccess }: FileSharderProps) {
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const localGateway = useLocalGateway();
  const gatewayGuiReleaseUrl = 'https://github.com/Nil-Store/nil-store/releases/latest'
  
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('idle');

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
  const [compressUploads, setCompressUploads] = useState(true)

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
  const persistInFlightRef = useRef<Promise<void> | null>(null)
  const lastPersistedManifestRootRef = useRef<string | null>(null)
  const gatewayUploadProgressRef = useRef<{ phase: string; workDone: number; workTotal: number }>({
    phase: '',
    workDone: 0,
    workTotal: 0,
  })

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

    const hasLocalArtifacts = collectedMdus.length > 0 || (isMode2 && mode2Shards.length > 0)
    if (!hasLocalArtifacts) return

    const manifestRoot = currentManifestRoot
    const manifestBlob = currentManifestBlob
    const mdus = collectedMdus.slice()
    const shards = mode2Shards.slice()
    const witnessCount = shardProgress.totalWitnessMdus
    const safeWitnessCount = Number.isFinite(witnessCount) && witnessCount > 0 ? Math.floor(witnessCount) : 0

    const persistPromise = (async () => {
      const safeRoot = String(manifestRoot || '').trim()
      if (!safeRoot) return
      if (lastPersistedManifestRootRef.current === safeRoot) return

      // Serialize writes to OPFS to avoid interleaving blobs from multiple commits.
      if (persistInFlightRef.current) {
        try {
          await persistInFlightRef.current
        } catch {
          // ignore: new commit will attempt to write a complete slab anyway
        }
      }

      try {
        addLog('> Saving committed slab to OPFS...')
        const mdu0Bytes = mdus.find((mdu) => mdu.index === 0)?.data
        const parsedFiles = mdu0Bytes ? parseNilfsFilesFromMdu0(mdu0Bytes) : []
        const fileRecords = parsedFiles.map((file) => ({
          path: file.path,
          start_offset: Number(file.start_offset) || 0,
          size_bytes: Number(file.size_bytes) || 0,
          flags: Number(file.flags) || 0,
        }))
        const maxEnd = fileRecords.reduce((max, file) => {
          const end = file.start_offset + file.size_bytes
          return end > max ? end : max
        }, 0)
        const userMdusByOffsets = maxEnd > 0 ? Math.ceil(maxEnd / RAW_MDU_CAPACITY) : 0
        const userMdusByIndices = mdus.reduce((count, mdu) => (mdu.index > safeWitnessCount ? count + 1 : count), 0)
        const userMdus = Math.max(userMdusByOffsets, userMdusByIndices)
        const totalMdus = 1 + safeWitnessCount + userMdus
        const generationId = safeRoot.replace(/^0x/i, '').trim() || safeRoot
        const shardWrites =
          isMode2 && shards.length > 0
            ? shards.flatMap((mdu) => {
                const slabIndex = 1 + witnessCount + mdu.index
                return mdu.shards.flatMap((shard, slot) =>
                  shard ? [{ mduIndex: slabIndex, slot, data: shard }] : [],
                )
              })
            : []
        await writeSlabGenerationAtomically(dealId, {
          manifestRoot: safeRoot,
          manifestBlob,
          mdus: mdus.map((mdu) => ({ index: mdu.index, data: mdu.data })),
          shards: shardWrites,
          metadata: {
            schema_version: 1,
            generation_id: generationId,
            deal_id: dealId,
            manifest_root: safeRoot,
            owner: address || undefined,
            redundancy:
              isMode2 && stripeParams
                ? { k: stripeParams.k, m: stripeParams.m, n: stripeParams.k + stripeParams.m }
                : undefined,
            source: isMode2 ? 'browser_mode2_commit' : 'browser_mode1_commit',
            created_at: new Date().toISOString(),
            last_validated_at: null,
            witness_mdus: safeWitnessCount,
            user_mdus: userMdus,
            total_mdus: totalMdus,
            file_records: fileRecords,
          },
        })

        lastPersistedManifestRootRef.current = safeRoot
        addLog('> Saved MDUs locally (OPFS). Deal Explorer should show files now.')
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        addLog(`> Failed to save MDUs locally: ${msg}`)
      }
    })()

    persistInFlightRef.current = persistPromise
    void persistPromise.finally(() => {
      if (persistInFlightRef.current === persistPromise) {
        persistInFlightRef.current = null
      }
    })
  }, [
    addLog,
    collectedMdus,
    commitHash,
    currentManifestBlob,
    currentManifestRoot,
    dealId,
    isCommitSuccess,
    isMode2,
    mode2Shards,
    onCommitSuccess,
    shardProgress.totalWitnessMdus,
    address,
    stripeParams,
  ]);

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

  const rehydrateGatewayFromOpfs = useCallback(async (): Promise<boolean> => {
    const gatewaySeed = (localGateway.url || appConfig.gatewayBase || 'http://127.0.0.1:8080').replace(/\/$/, '')
    const gatewayBases = localGatewayCandidates(gatewaySeed)
    const spBase = appConfig.spBase.replace(/\/$/, '')
    const gatewayBase = gatewayBases.find((base) => base !== spBase) || ''
    if (!gatewayBase || appConfig.gatewayDisabled) {
      return false
    }

    let manifestRoot = String((await readManifestRoot(dealId)) || '').trim()
    if (!manifestRoot) {
      manifestRoot = String(lastCommitRef.current || '').trim()
    }
    if (!manifestRoot) {
      try {
        const deal = await lcdFetchDeal(appConfig.lcdBase, dealId)
        manifestRoot = String(deal?.cid || '').trim()
      } catch {
        manifestRoot = ''
      }
    }
    const manifestKey = manifestRoot.replace(/^0x/i, '').trim()
    if (!manifestKey || /^0+$/.test(manifestKey)) {
      addLog('> Gateway rehydrate skipped: no committed manifest root found in browser/on-chain state.')
      return false
    }

    const mdu0 = await readMdu(dealId, 0)
    if (!mdu0) {
      addLog('> Gateway rehydrate skipped: local MDU #0 missing in OPFS.')
      return false
    }

    const nilfsFiles = parseNilfsFilesFromMdu0(mdu0)
    if (nilfsFiles.length === 0) {
      addLog('> Gateway rehydrate skipped: local MDU #0 has no file records.')
      return false
    }

    let witnessCount = 0
    try {
      const inferred = await inferWitnessCountFromOpfs(dealId, nilfsFiles)
      witnessCount = inferred.witnessCount
      if (inferred.userCount <= 0) {
        addLog('> Gateway rehydrate skipped: no local user MDUs found in OPFS.')
        return false
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      addLog(`> Gateway rehydrate skipped: unable to infer slab layout (${msg}).`)
      return false
    }

    const fileNames = await listDealFiles(dealId)
    const shardFiles = fileNames
      .map((name) => {
        const m = /^mdu_(\d+)_slot_(\d+)\.bin$/.exec(name)
        if (!m) return null
        const mduIndex = Number(m[1])
        const slot = Number(m[2])
        if (!Number.isFinite(mduIndex) || !Number.isFinite(slot)) return null
        return { mduIndex, slot }
      })
      .filter((entry): entry is { mduIndex: number; slot: number } => !!entry)
      .sort((a, b) => a.mduIndex - b.mduIndex || a.slot - b.slot)

    if (shardFiles.length === 0) {
      addLog('> Gateway rehydrate skipped: no local shard files found in OPFS.')
      return false
    }

    let mirrorMduPath = '/sp/upload_mdu'
    let mirrorShardPath = '/sp/upload_shard'
    let mirrorManifestPath = '/sp/upload_manifest'
    try {
      const statusRes = await fetch(`${gatewayBase}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(2500),
      })
      if (statusRes.ok) {
        const payload = await statusRes.json().catch(() => null)
        const mode = payload && typeof payload === 'object' && typeof payload.mode === 'string'
          ? payload.mode.trim().toLowerCase()
          : ''
        if (mode === 'router' || mode === 'proxy') {
          mirrorMduPath = '/gateway/mirror_mdu'
          mirrorShardPath = '/gateway/mirror_shard'
          mirrorManifestPath = '/gateway/mirror_manifest'
          addLog('> Gateway proxy mode detected (legacy "router" alias); rehydrate will use mirror endpoints.')
        }
      } else if (statusRes.status !== 404) {
        addLog(`> Gateway rehydrate skipped: gateway unavailable (${statusRes.status}).`)
        return false
      } else {
        const health = await fetch(`${gatewayBase}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2500),
        })
        if (!health.ok) {
          addLog(`> Gateway rehydrate skipped: gateway unavailable (${health.status}).`)
          return false
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      addLog(`> Gateway rehydrate skipped: cannot reach local gateway (${msg}).`)
      return false
    }

    addLog('> Rehydrating local gateway from browser OPFS cache...')

    try {
      for (let idx = 0; idx <= witnessCount; idx++) {
        const data = idx === 0 ? mdu0 : await readMdu(dealId, idx)
        if (!data) {
          throw new Error(`missing local MDU: mdu_${idx}.bin`)
        }
        const res = await fetch(`${gatewayBase}${mirrorMduPath}`, {
          method: 'POST',
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(idx),
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: new Blob([data as any]),
        })
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(txt || `gateway upload_mdu failed (${res.status})`)
        }
      }

      const manifestBlob = await readManifestBlob(dealId)
      if (manifestBlob && manifestBlob.byteLength > 0) {
        const manifestRes = await fetch(`${gatewayBase}${mirrorManifestPath}`, {
          method: 'POST',
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: new Blob([manifestBlob as any]),
        })
        if (!manifestRes.ok) {
          const txt = await manifestRes.text().catch(() => '')
          throw new Error(txt || `gateway upload_manifest failed (${manifestRes.status})`)
        }
      } else {
        addLog('> Rehydrate note: local manifest blob missing; continuing with MDUs/shards only.')
      }

      for (const entry of shardFiles) {
        const shard = await readShard(dealId, entry.mduIndex, entry.slot)
        if (!shard) {
          throw new Error(`missing local shard: mdu_${entry.mduIndex}_slot_${entry.slot}.bin`)
        }
        const res = await fetch(`${gatewayBase}${mirrorShardPath}`, {
          method: 'POST',
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(entry.mduIndex),
            'X-Nil-Slot': String(entry.slot),
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

      addLog(`> Rehydrated local gateway from OPFS cache (${witnessCount + 1} MDUs, ${shardFiles.length} shards).`)
      return true
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      addLog(`> Gateway rehydrate failed: ${msg}`)
      return false
    }
  }, [addLog, dealId, localGateway.url])

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

    const gatewaySeed = (localGateway.url || appConfig.gatewayBase || 'http://127.0.0.1:8080').replace(/\/$/, '')
    const gatewayBases = localGatewayCandidates(gatewaySeed)
    const spBase = appConfig.spBase.replace(/\/$/, '')
    const gatewayBase = gatewayBases.find((base) => base !== spBase) || ''
    if (!gatewayBase) return
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
        const mode = payload && typeof payload === 'object' && typeof payload.mode === 'string'
          ? payload.mode.trim().toLowerCase()
          : ''
        if (mode === 'router' || mode === 'proxy') {
          mirrorMduPath = '/gateway/mirror_mdu'
          mirrorShardPath = '/gateway/mirror_shard'
          mirrorManifestPath = '/gateway/mirror_manifest'
          addLog('> Gateway proxy mode detected (legacy "router" alias); using mirror endpoints.')
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
    localGateway.url,
    shardProgress.totalWitnessMdus,
  ]);

  // Note: OPFS persistence is handled in the commit-success effect above so we can
  // await it before starting the next file without being cancelled by state resets.

  const ensureWasmReady = useCallback(async () => {
    if (wasmStatus === 'ready') return
    if (wasmInitPromiseRef.current) {
      await wasmInitPromiseRef.current
      return
    }

    const promise = (async () => {
      setWasmStatus('initializing')
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

      if (persistInFlightRef.current) {
        try {
          await persistInFlightRef.current
        } catch {
          // ignore
        }
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
          updated_at?: string
          started_at?: string
          bytes_done?: number
          bytes_total?: number
          steps_done?: number
          steps_total?: number
          result?: {
            manifest_root?: string
            size_bytes?: number
            file_size_bytes?: number
            total_mdus?: number
            witness_mdus?: number
            allocated_length?: number
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
          const sizeBytes = resultObj ? asNumber(resultObj.size_bytes) : undefined
          const fileSizeBytes = resultObj ? asNumber(resultObj.file_size_bytes) : undefined
          const totalMdus = resultObj ? asNumber(resultObj.total_mdus) : undefined
          const witnessMdus = resultObj ? asNumber(resultObj.witness_mdus) : undefined
          const allocatedLength = resultObj ? asNumber(resultObj.allocated_length) : undefined

          return {
            status: typeof obj.status === 'string' ? obj.status : undefined,
            phase: typeof obj.phase === 'string' ? obj.phase : undefined,
            message: typeof obj.message === 'string' ? obj.message : undefined,
            error: typeof obj.error === 'string' ? obj.error : undefined,
            updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : undefined,
            started_at: typeof obj.started_at === 'string' ? obj.started_at : undefined,
            bytes_done: asNumber(obj.bytes_done),
            bytes_total: asNumber(obj.bytes_total),
            steps_done: asNumber(obj.steps_done),
            steps_total: asNumber(obj.steps_total),
            result:
              manifestRoot || sizeBytes !== undefined || fileSizeBytes !== undefined || totalMdus !== undefined || witnessMdus !== undefined || allocatedLength !== undefined
                ? {
                    manifest_root: manifestRoot,
                    size_bytes: sizeBytes,
                    file_size_bytes: fileSizeBytes,
                    total_mdus: totalMdus,
                    witness_mdus: witnessMdus,
                    allocated_length: allocatedLength,
                  }
                : undefined,
          }
        }

        const finalizeGatewaySuccess = (
          payload: {
            manifest_root?: string
            cid?: string
            size_bytes?: number
            file_size_bytes?: number
            allocated_length?: number
            total_mdus?: number
            witness_mdus?: number
          } | null,
          statusSnapshot: GatewayUploadJobStatus | null,
        ): boolean => {
          const statusRoot = String(statusSnapshot?.result?.manifest_root || '')
          const statusTotalMdus = Number(statusSnapshot?.result?.total_mdus ?? 0) || 0
          const statusWitnessMdus = Number(statusSnapshot?.result?.witness_mdus ?? 0) || 0
          const statusAllocatedLength = Number(statusSnapshot?.result?.allocated_length ?? 0) || 0
          const root = String(payload?.manifest_root || payload?.cid || statusRoot || '').trim()
          if (!root) {
            setMode2UploadError('gateway upload returned no manifest_root')
            setShardProgress((p) => ({
              ...p,
              phase: 'error',
              label: 'Gateway upload returned no manifest_root',
              currentOpStartedAtMs: null,
              lastOpMs: performance.now() - startTs,
            }))
            setProcessing(false)
            return false
          }

          const gatewaySizeBytes = Number(payload?.size_bytes ?? payload?.file_size_bytes ?? file.size) || file.size
          const gatewayTotalMdus = Number(
            payload?.total_mdus ?? statusTotalMdus ?? payload?.allocated_length ?? statusAllocatedLength,
          ) || 0
          const gatewayWitnessMdus = Number(payload?.witness_mdus ?? statusWitnessMdus) || 0
          const gatewayUserMdus = gatewayTotalMdus > 0 ? Math.max(0, gatewayTotalMdus - 1 - gatewayWitnessMdus) : 0
          const gatewayUserMdusFromAllocated = gatewayUserMdus === 0
            ? Math.max(0, (Number(payload?.allocated_length ?? statusAllocatedLength) || 0) - 1 - gatewayWitnessMdus)
            : gatewayUserMdus
          const gatewayUserMdusFinal = gatewayUserMdusFromAllocated || gatewayUserMdus

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
            totalUserMdus: gatewayUserMdusFinal,
            totalWitnessMdus: gatewayWitnessMdus,
            currentOpStartedAtMs: null,
            lastOpMs: performance.now() - startTs,
          }))
          setProcessing(false)
          return true
        }

        const newUploadId = () =>
          globalThis.crypto && 'randomUUID' in globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`

        type GatewayUploadPayload = {
          manifest_root?: string
          cid?: string
          size_bytes?: number
          file_size_bytes?: number
          allocated_length?: number
          total_mdus?: number
          witness_mdus?: number
        } | null

        type GatewayUploadAcceptedPayload = {
          status?: string
          upload_id?: string
          status_url?: string
        }

        const buildUploadForm = (id: string) => {
          const form = new FormData()
          form.append('deal_id', dealId)
          form.append('file_path', file.name)
          form.append('upload_id', id)
          form.append('file_size_bytes', String(file.size))
          form.append('file', file)
          return form
        }

        const runGatewayUpload = async (
          gatewayBase: string,
          initialLabel: string,
          uploadId: string,
          allGatewayBases: string[],
        ): Promise<{ payload: GatewayUploadPayload; lastJob: GatewayUploadJobStatus | null; hadStatus: boolean }> => {
          let lastJob: GatewayUploadJobStatus | null = null
          let hadStatus = false
          let staleWarned = false
          let lastStatusTs = 0
          let lastStatusLogKey = ''
          const buildStatusBaseCandidates = () => {
            const seen = new Set<string>()
            const candidates: string[] = []
            const pushStatusCandidate = (candidateBase: string) => {
              const base = String(candidateBase || '').trim().replace(/\/$/, '')
              if (!base) return
              if (seen.has(base)) return
              seen.add(base)
              const statusUrl = `${base}/gateway/upload-status?deal_id=${encodeURIComponent(dealId)}&upload_id=${encodeURIComponent(uploadId)}`
              candidates.push(statusUrl)
            }

            const dedupe = allGatewayBases.length ? allGatewayBases : [gatewayBase]
            for (const base of dedupe) {
              pushStatusCandidate(base)
            }
            return candidates
          }

          const normalizeStatusUrl = (raw: string): string | null => {
            if (!raw) return null
            try {
              const parsed = new URL(raw, gatewayBase)
              if (!/^https?:$/.test(parsed.protocol)) return null
              if (String(parsed.pathname || '').trim() !== '/gateway/upload-status') {
                parsed.pathname = '/gateway/upload-status'
              }
              parsed.searchParams.set('deal_id', String(dealId).trim())
              parsed.searchParams.set('upload_id', uploadId)
              return parsed.toString()
            } catch {
              return null
            }
          }

          let statusPollCandidates = buildStatusBaseCandidates()
          const url = `${gatewayBase}/gateway/upload?deal_id=${encodeURIComponent(dealId)}&upload_id=${encodeURIComponent(uploadId)}`
          const phaseToDisplay = (phaseRaw: string): ShardPhase => {
            const phase = String(phaseRaw || '').trim()
            switch (phase) {
              case 'receiving':
                return 'gateway_receiving'
              case 'encoding':
                return 'gateway_encoding'
              case 'uploading':
                return 'gateway_uploading'
              case 'done':
                return 'done'
              default:
                return 'planning'
            }
          }
          const applyProgress = (job: GatewayUploadJobStatus) => {
            const phase = phaseToDisplay(String(job.phase || '').trim())
            const status = String(job.status || '').trim()
            const message = String(job.message || '').trim()
            const bytesDone = Number(job.bytes_done || 0) || 0
            const bytesTotal = Number(job.bytes_total || 0) || 0
            const stepsDone = Number(job.steps_done || 0) || 0
            const stepsTotal = Number(job.steps_total || 0) || 0

            const useBytes = phase === 'gateway_receiving' && bytesTotal > 0
            const candidateDone = useBytes ? bytesDone : stepsDone
            const candidateTotal = useBytes ? bytesTotal : stepsTotal

            const logKey = `${status}|${phase}|${message}`
            if (logKey && logKey !== lastStatusLogKey) {
              addLog(`> Gateway upload status: status=${status || 'working'} phase=${phase || 'planning'} message=${message || 'working'}`)
              lastStatusLogKey = logKey
            }

            const lastByPhase = gatewayUploadProgressRef.current
            const samePhase = lastByPhase.phase === phase
            const fallbackTotal = samePhase ? lastByPhase.workTotal : candidateTotal
            const fallbackDone = samePhase ? lastByPhase.workDone : candidateDone

            const normalizedTotal = candidateTotal > 0 ? candidateTotal : fallbackTotal
            let normalizedDone = candidateDone > 0 ? candidateDone : fallbackDone

            if (normalizedTotal > 0 && normalizedDone > normalizedTotal) {
              normalizedDone = normalizedTotal
            }

            gatewayUploadProgressRef.current = {
              phase: phase,
              workDone: normalizedDone,
              workTotal: normalizedTotal,
            }

            setShardProgress((p) => ({
              ...p,
              phase,
              label: `Gateway Mode 2: ${message || phase || status || 'working'}`,
              workDone: normalizedDone,
              workTotal: normalizedTotal,
              blobsDone: normalizedDone,
              blobsTotal: normalizedTotal,
              fileBytesTotal: bytesTotal > 0 ? bytesTotal : p.fileBytesTotal,
            }))
          }

          const parseAccepted = (value: unknown): GatewayUploadAcceptedPayload | null => {
            if (!value || typeof value !== 'object') return null
            const obj = value as Record<string, unknown>
            if (typeof obj['status'] !== 'string' || String(obj['status']).toLowerCase() !== 'accepted') return null

            return {
              status: String(obj['status']),
              upload_id: typeof obj['upload_id'] === 'string' ? String(obj['upload_id']) : undefined,
              status_url: typeof obj['status_url'] === 'string' ? String(obj['status_url']).trim() : undefined,
            }
          }

          const parseGatewayUploadPayload = (value: unknown): GatewayUploadPayload | null => {
            if (!value || typeof value !== 'object') return null
            const obj = value as Record<string, unknown>
            const manifestRoot = typeof obj.manifest_root === 'string' ? obj.manifest_root : undefined
            const cid = typeof obj.cid === 'string' ? obj.cid : undefined
            const sizeBytes = asNumber(obj.size_bytes)
            const fileSizeBytes = asNumber(obj.file_size_bytes)
            const totalMdus = asNumber(obj.total_mdus)
            const witnessMdus = asNumber(obj.witness_mdus)
            const allocatedLength = asNumber(obj.allocated_length)

            if (
              manifestRoot === undefined &&
              cid === undefined &&
              sizeBytes === undefined &&
              fileSizeBytes === undefined &&
              totalMdus === undefined &&
              witnessMdus === undefined &&
              allocatedLength === undefined
            ) {
              return null
            }

            return {
              manifest_root: manifestRoot,
              cid,
              size_bytes: sizeBytes,
              file_size_bytes: fileSizeBytes,
              allocated_length: allocatedLength,
              total_mdus: totalMdus,
              witness_mdus: witnessMdus,
            }
          }

          const pollStatusOnce = async (): Promise<GatewayUploadJobStatus | null> => {
            for (const pollUrl of statusPollCandidates) {
              try {
                const res = await fetch(pollUrl, { method: 'GET', signal: AbortSignal.timeout(gatewayUploadPollTimeoutMs) })
                if (res.ok) {
                  const job = parseGatewayUploadJobStatus(await res.json().catch(() => null))
                  if (job) {
                    lastJob = job
                    hadStatus = true
                    lastStatusTs = performance.now()
                    staleWarned = false
                    applyProgress(job)
                    return job
                  }
                }
              } catch {
                // Ignore polling errors; the primary upload request is the source of truth.
              }
            }
            return null
          }

          const updateHeartbeat = () => {
            if (hadStatus && lastStatusTs > 0 && performance.now() - lastStatusTs >= gatewayUploadHeartbeatStaleMs && !staleWarned) {
              staleWarned = true
              setShardProgress((p) => ({
                ...p,
                label: 'Gateway Mode 2: upload heartbeat stalled; waiting for provider status...',
              }))
            }
          }

          const waitForUploadCompletion = async (): Promise<{
            payload: GatewayUploadPayload
            lastJob: GatewayUploadJobStatus | null
            hadStatus: boolean
          }> => {
            const deadline = performance.now() + 10 * 60_000
            while (performance.now() < deadline) {
              const job = await pollStatusOnce()
              updateHeartbeat()
              if (job?.status === 'error') {
                throw new Error(job.error || 'gateway upload failed')
              }
              if (job?.status === 'success') {
                if (!job.result?.manifest_root) {
                  throw new Error('gateway upload completed without manifest_root')
                }
                return {
                  payload: {
                    manifest_root: job.result?.manifest_root,
                    cid: undefined,
                    size_bytes: job.result?.size_bytes,
                    file_size_bytes: job.result?.file_size_bytes,
                    allocated_length: job.result?.allocated_length,
                    total_mdus: job.result?.total_mdus,
                    witness_mdus: job.result?.witness_mdus,
                  },
                  lastJob: job,
                  hadStatus: true,
                }
              }
              await new Promise((r) => setTimeout(r, gatewayUploadPollIntervalMs))
            }
            throw new Error('gateway upload timed out while waiting for completion')
          }

          const probeInFlightUpload = async (): Promise<GatewayUploadJobStatus | null> => {
            const deadline = performance.now() + 4_000
            while (performance.now() < deadline) {
              const job = await pollStatusOnce()
              if (job) {
                return job
              }
              await new Promise((r) => setTimeout(r, 250))
            }
            return null
          }

          try {
            setMode2Uploading(true)
            gatewayUploadProgressRef.current = {
              phase: 'gateway_receiving',
              workDone: 0,
              workTotal: 0,
            }
            setShardProgress((p) => ({
              ...p,
              phase: 'gateway_receiving',
              label: initialLabel,
              workDone: 0,
              workTotal: file.size,
              blobsDone: 0,
              blobsTotal: file.size,
              fileBytesTotal: file.size,
              currentOpStartedAtMs: performance.now(),
            }))

            let resp: Response
            try {
              resp = await fetch(url, {
                method: 'POST',
                body: buildUploadForm(uploadId),
                signal: AbortSignal.timeout(1_800_000),
              })
            } catch (err: unknown) {
              addLog('> Gateway upload request had a transport issue; probing status for in-flight upload')
              const job = await probeInFlightUpload()
              if (!job) {
                throw err
              }
              if (job.status === 'error') {
                throw new Error(job.error || 'gateway upload failed')
              }
              if (job.status === 'success') {
                if (!job.result?.manifest_root) {
                  throw new Error('gateway upload completed without manifest_root')
                }
                return {
                  payload: {
                    manifest_root: job.result?.manifest_root,
                    cid: undefined,
                    size_bytes: job.result?.size_bytes,
                    file_size_bytes: job.result?.file_size_bytes,
                    allocated_length: job.result?.allocated_length,
                    total_mdus: job.result?.total_mdus,
                    witness_mdus: job.result?.witness_mdus,
                  },
                  lastJob: job,
                  hadStatus: true,
                }
              }
              return await waitForUploadCompletion()
            }

            if (!resp.ok) {
              const txt = await resp.text().catch(() => '')
              const statusErr = String((lastJob as GatewayUploadJobStatus | null)?.error || '')
              throw new Error(txt || statusErr || `gateway upload failed (${resp.status})`)
            }

            const rawPayload = (await resp.json().catch(() => null)) as GatewayUploadPayload | GatewayUploadAcceptedPayload
            const acceptedPayload = parseAccepted(rawPayload)
            if (acceptedPayload) {
              const statusPollUrl = String(acceptedPayload.status_url || '').trim()
              if (statusPollUrl) {
                const normalizedStatus = normalizeStatusUrl(statusPollUrl)
                if (normalizedStatus) {
                  const set = new Set<string>(statusPollCandidates)
                  if (!set.has(normalizedStatus)) {
                    statusPollCandidates.unshift(normalizedStatus)
                  }
                }
                if (statusPollCandidates.length === 0) {
                  throw new Error('gateway upload accepted with invalid status_url')
                }
              } else {
                addLog('> Gateway upload accepted without status_url; using computed status endpoint')
              }

              if (statusPollCandidates.length === 0) {
                statusPollCandidates = buildStatusBaseCandidates()
                if (statusPollCandidates.length === 0) {
                  throw new Error('gateway upload accepted without status polling endpoint')
                }
              }
              addLog(`> Gateway upload accepted; tracking upload_id=${acceptedPayload.upload_id || uploadId}`)
              addLog(`> Gateway upload status endpoints: ${statusPollCandidates.join(' | ')}`)
              return await waitForUploadCompletion()
            }

            const payload = parseGatewayUploadPayload(rawPayload)
            if (!payload) {
              throw new Error('Gateway upload returned unexpected payload')
            }
            return { payload, lastJob, hadStatus }
          } finally {
            setMode2Uploading(false)
          }
        }
        const uploadId = newUploadId()

        const gatewaySeed = (localGateway.url || appConfig.gatewayBase || 'http://localhost:8080').replace(/\/$/, '')
        const gatewayBases = localGatewayCandidates(gatewaySeed)
        let gatewayErrorMessage = ''
        let gatewayUnreachable = false
        let providerUploadUnavailable = false

        for (let i = 0; i < gatewayBases.length; i++) {
          const gatewayBase = gatewayBases[i]
          try {
            const { payload, lastJob } = await runGatewayUpload(
              gatewayBase,
              'Gateway Mode 2: starting upload...',
              uploadId,
              gatewayBases,
            )
            if (finalizeGatewaySuccess(payload, lastJob)) return
            gatewayErrorMessage = 'gateway upload returned no manifest_root'
            gatewayUnreachable = false
            break
          } catch (e: unknown) {
            let msg = formatGatewayError(e)
            addLog(`> Gateway Mode 2 ingest failed: ${msg}`)

            const missingLocalState =
              /mode2 append failed/i.test(msg) &&
              /failed to resolve existing slab dir|failed to read existing MDU #0|failed to copy existing shard|failed to decode witness mdu|existing Mode 2 slab has no user MDUs/i.test(
                msg,
              )
            if (missingLocalState) {
              addLog('> Gateway is missing prior slab state; attempting browser-to-gateway rehydrate from OPFS...')
              const rehydrated = await rehydrateGatewayFromOpfs()
              if (rehydrated) {
                try {
                  addLog('> Gateway rehydrated from browser cache; retrying upload...')
                  const { payload } = await runGatewayUpload(
                    gatewayBase,
                    'Gateway rehydrated from browser cache; retrying upload...',
                    uploadId,
                    gatewayBases,
                  )
                  if (finalizeGatewaySuccess(payload, null)) return
                  msg = 'gateway upload returned no manifest_root'
                } catch (retryErr: unknown) {
                  msg = formatGatewayError(retryErr)
                  addLog(`> Gateway retry after rehydrate failed: ${msg}`)
                }
              }
            }

            const providerPathUnavailable = isProviderUploadConnectivityError(msg)
            if (providerPathUnavailable) {
              providerUploadUnavailable = true
              addLog('> Storage Provider path is unavailable (SP endpoint refused/timeout). Ensure SP gateways are running on 127.0.0.1:8082-8084.')
            }
            const unreachable = isGatewayNetworkError(msg) && !providerPathUnavailable
            gatewayErrorMessage = msg
            gatewayUnreachable = unreachable
            if (unreachable && i < gatewayBases.length - 1) {
              addLog(`> Gateway unavailable at ${gatewayBase}; retrying via ${gatewayBases[i + 1]}...`)
              continue
            }
            break
          }
        }

        if (providerUploadUnavailable && gatewayErrorMessage) {
          const errorMessage = `Storage Provider upload path unavailable: ${gatewayErrorMessage}`
          setMode2UploadError(errorMessage)
          setShardProgress((p) => ({
            ...p,
            phase: 'error',
            label: errorMessage,
            currentOpStartedAtMs: null,
            lastOpMs: performance.now() - startTs,
          }))
          setProcessing(false)
          return
        }
        if (gatewayUnreachable) {
          if (file.size > gatewayFallbackWasmMaxFileBytes) {
            const sizeLabel = formatBytes(file.size)
            const errorMessage = `Gateway unavailable while processing ${sizeLabel}. In-browser fallback is disabled for large files; please keep the local gateway running, allow local network access for localhost/127.0.0.1, and retry.`
            addLog(`> ${errorMessage}`)
            setMode2UploadError(errorMessage)
            setShardProgress((p) => ({
              ...p,
              phase: 'error',
              label: errorMessage,
              currentOpStartedAtMs: null,
              lastOpMs: performance.now() - startTs,
            }))
            setProcessing(false)
            return
          }

          addLog('> Gateway unavailable; falling back to in-browser Mode 2 sharding + stripe upload.')
          setMode2UploadError(null)
          setShardProgress((p) => ({
            ...p,
            phase: 'planning',
            label: 'Gateway unavailable; falling back to in-browser sharding...',
            currentOpStartedAtMs: null,
            lastOpMs: performance.now() - startTs,
          }))
        } else if (gatewayErrorMessage) {
          setMode2UploadError(gatewayErrorMessage)
          setShardProgress((p) => ({
            ...p,
            phase: 'error',
            label: `Gateway Mode 2 ingest failed: ${gatewayErrorMessage}`,
            currentOpStartedAtMs: null,
            lastOpMs: performance.now() - startTs,
          }))
          setProcessing(false)
          return
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
      let bytes: Uint8Array = new Uint8Array(buffer)
      let logicalSizeBytes = file.size
      let fileFlags = 0
      let contentEncoding: 'none' | 'zstd' = 'none'

      const header = peekNilceHeader(bytes)
      const hasNilceHeader = header.ok && !header.error
      if (header.ok) {
        if (header.error) {
          addLog(`> NilCE header error: ${header.error.message}`)
        } else {
          if (header.uncompressedLen) {
            logicalSizeBytes = header.uncompressedLen
          }
          if (header.encoding && header.encoding !== 'none') {
            contentEncoding = header.encoding
            if (header.encoding === 'zstd') {
              fileFlags |= NILCE_FLAG_COMPRESSION_ZSTD
            }
            addLog(`> NilCE: detected existing ${header.encoding} header (${formatBytes(logicalSizeBytes)} logical)`)
          } else if (header.encoding === 'none') {
            addLog(`> NilCE: detected existing header (${formatBytes(logicalSizeBytes)} logical)`)
          }
        }
      }

      if (compressUploads && contentEncoding === 'none' && !hasNilceHeader) {
        try {
          const wrapped = await maybeWrapNilceZstd(bytes)
          if (wrapped.wrapped && wrapped.encoding === 'zstd') {
            bytes = wrapped.bytes as Uint8Array
            contentEncoding = 'zstd'
            fileFlags |= NILCE_FLAG_COMPRESSION_ZSTD
            logicalSizeBytes = wrapped.uncompressedLen
            addLog(
              `> NilCE: compressed ${formatBytes(wrapped.uncompressedLen)} -> ${formatBytes(wrapped.bytes.length)}`,
            )
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          addLog(`> NilCE compression failed; proceeding without compression (${msg})`)
        }
      }

      lastFileMetaRef.current = { filePath: file.name, fileSizeBytes: logicalSizeBytes }
      if (bytes.length !== file.size) {
        setShardProgress((p) => ({
          ...p,
          fileBytesTotal: bytes.length,
        }))
      }
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

            let rawChunk: Uint8Array = new Uint8Array();
            let encodedMdu: Uint8Array;
            let encodeMs = 0;

            if (isExisting) {
              encodedMdu = existingUserMdus[i].data;
            } else {
              const newIndex = i - existingUserCount;
              const start = newIndex * RawMduCapacity;
              const end = Math.min(start + RawMduCapacity, bytes.length);
              rawChunk = bytes.subarray(start, end) as Uint8Array;
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
        await workerClient.appendFileToMdu0(recordPath, bytes.length, fileStartOffset, fileFlags);

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
        const mib = logicalSizeBytes / (1024 * 1024);
        const seconds = elapsedMs / 1000;
        const avgMibPerSec = seconds > 0 ? mib / seconds : 0;
        const speedStr = `${avgMibPerSec.toFixed(2)} MiB/s (file avg)`;
        const sizeLabel =
          contentEncoding === 'none'
            ? formatBytes(logicalSizeBytes)
            : `${formatBytes(logicalSizeBytes)} (stored ${formatBytes(bytes.length)})`
        addLog(
          `Done. Client-side expansion complete. Time: ${formatDuration(elapsedMs)}. Data: ${sizeLabel}. Speed: ${speedStr}.`,
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
  }, [addLog, compressUploads, dealId, ensureWasmReady, gatewayMode2Enabled, isConnected, localGateway.url, rehydrateGatewayFromOpfs, resetUpload, stripeParams]);

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
  const uploadPhase = useMemo(() => {
    if (hasError) return 'error'
    if (isAlreadyCommitted) return 'done'
    if (isCommitPending || isCommitConfirming) return 'committing'
    if (readyToCommit) return 'ready_to_commit'
    if (activeUploading) return isMode2 ? 'gateway_uploading' : 'uploading'
    if (processing) return shardProgress.phase || 'processing'
    if (readyToUpload) return 'ready_to_upload'
    if (hasManifestRoot) return 'manifest_ready'
    return 'idle'
  }, [
    activeUploading,
    hasError,
    hasManifestRoot,
    isAlreadyCommitted,
    isCommitConfirming,
    isCommitPending,
    isMode2,
    processing,
    readyToCommit,
    readyToUpload,
    shardProgress.phase,
  ])

  useEffect(() => {
    const node = logContainerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [logs.length, processing, activeUploading, readyToCommit, isCommitPending, isCommitConfirming, isAlreadyCommitted, hasError]);

  return (
    <div className="w-full space-y-4">
      {!isConnected ? (
        <button
          onClick={() => openConnectModal?.()}
          className="w-full rounded-xl border border-dashed border-border bg-background/60 px-6 py-10 text-center transition-all hover:border-primary/50 hover:bg-secondary/40"
        >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-border/60 bg-secondary/60">
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
          ) : (
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={`
                border-2 border-dashed rounded-none p-8 transition-all duration-300 relative overflow-hidden group industrial-border
                ${isDragging
                  ? 'border-primary bg-primary/10 scale-[1.005]'
                  : 'border-border/60 hover:border-primary/40 bg-card'
                }
              `}
            >
               {/* Keep hover scan only; avoid persistent grid bleed inside the slab. */}
               <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none animate-scan" />

              <div className="relative z-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 flex h-12 w-12 items-center justify-center rounded-none bg-primary/10 border border-primary/40">
                    <Cpu className="h-6 w-6 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold hud-path">/dev/shm_sharder_v1</div>
                    <div className="mt-1 text-[10px] text-muted-foreground font-mono-data">
                      {isMode2 && gatewayMode2Enabled ? (
                        gatewayReachable ? (
                          <span className="text-accent font-bold">[GW_LOCAL_OPTIMIZED] HYBRID_INGEST_READY</span>
                        ) : (
                          <span className="text-primary font-bold">[BROWSER_FALLBACK] WASM_KZG_SHARDING_READY</span>
                        )
                      ) : wasmStatus === 'initializing' ? (
                        <span className="animate-pulse">BOOTING_WASM_KZG_CONTEXT...</span>
                      ) : wasmStatus === 'error' ? (
                        <span className="text-destructive font-bold">ERROR: WASM_INIT_FAILED</span>
                      ) : (
                        <span>WASM_READY :: MODE1_BROWSER_SHARDING</span>
                      )}
                    </div>
                  </div>
                </div>
                <label className="inline-flex w-full cursor-pointer items-center justify-center bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.3)] dark:shadow-[0_0_15px_hsl(var(--primary)_/_0.2)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,0.3)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none sm:w-auto">
                  LOAD_OBJECT
                  <input type="file" className="hidden" onChange={handleFileSelect} data-testid="mdu-file-input" />
                </label>
              </div>
              <div className="relative z-10 mt-6 flex flex-wrap items-center gap-4 text-[10px] font-mono-data text-muted-foreground uppercase tracking-widest">
                <label className="flex items-center gap-2 cursor-pointer group/chk">
                  <div className={`w-4 h-4 border flex items-center justify-center transition-colors ${compressUploads ? 'bg-primary border-primary' : 'bg-transparent border-border'}`}>
                    {compressUploads && <div className="w-1.5 h-1.5 bg-primary-foreground" />}
                  </div>
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={compressUploads}
                    disabled={processing || activeUploading}
                    onChange={(e) => setCompressUploads(e.target.checked)}
                  />
                  <span>NilCE_ZSTD_COMPRESSION</span>
                </label>
                <div className="h-3 w-[1px] bg-border/40" />
                {!appConfig.gatewayDisabled && !gatewayReachable ? (
                  <a
                    href={gatewayGuiReleaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    GET_DESKTOP_GATEWAY
                  </a>
                ) : (
                  <span className="opacity-40">SYSTEM_READY</span>
                )}
              </div>
            </div>
          )}

      {showStatusPanel && (
        <div
          className="relative overflow-hidden glass-panel industrial-border p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)] text-sm"
          data-testid="mdu-status-panel"
          data-upload-phase={uploadPhase}
        >
          {processing ? (
            <div className="absolute inset-0 pointer-events-none animate-scan opacity-25" />
          ) : null}

          <p className="relative text-[10px] font-bold hud-path mb-2">
            /proc/sharder
          </p>
          <div className="relative space-y-2">
            {hasError ? (
              <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] font-mono-data text-destructive">
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
                    <Cpu className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground">
                      {isMode2 && gatewayMode2Enabled && shardProgress.label.startsWith('Gateway Mode 2')
                        ? 'Gateway ingest'
                        : 'WASM Sharding'}
                    </span>
                    <span className="text-muted-foreground font-mono-data uppercase tracking-[0.2em]">•</span>
                    <span className="text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                      {isMode2 && gatewayMode2Enabled && shardProgress.label.startsWith('Gateway Mode 2')
                        ? shardProgress.label
                        : shardingUi.phaseDetails || 'Working...'}
                    </span>
                  </p>
                  <div className="text-[10px] font-mono-data text-muted-foreground uppercase tracking-[0.2em] whitespace-nowrap">
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

                <div className="h-2 w-full overflow-hidden border border-border/60 bg-background/40">
                  <div
                    className="h-full bg-primary transition-[width] duration-300 ease-out dark:shadow-[0_0_18px_hsl(var(--primary)_/_0.25)]"
                    style={{ width: `${(shardingUi.overallPct * 100).toFixed(1)}%` }}
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-muted-foreground">
                  <div className="glass-panel industrial-border px-2 py-2">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Elapsed</div>
                    <div className="mt-1 text-foreground font-mono-data">{formatDuration(shardingUi.elapsedMs)}</div>
                  </div>
                  <div className="glass-panel industrial-border px-2 py-2">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">ETA</div>
                    <div className="mt-1 text-foreground font-mono-data">
                      {shardingUi.etaMs == null ? '—' : formatDuration(shardingUi.etaMs)}
                    </div>
                  </div>
                  <div className="glass-panel industrial-border px-2 py-2">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Throughput</div>
                    <div className="mt-1 text-foreground font-mono-data">{shardingUi.mibPerSec.toFixed(2)} MiB/s</div>
                  </div>
                  <div className="glass-panel industrial-border px-2 py-2">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Op Time</div>
                    <div className="mt-1 text-foreground font-mono-data">
                      {shardProgress.currentOpStartedAtMs
                        ? formatDuration(shardingUi.currentOpMs)
                        : shardProgress.lastOpMs != null
                          ? formatDuration(shardProgress.lastOpMs)
                          : '—'}
                    </div>
                  </div>
                </div>

                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer select-none hover:text-foreground font-mono-data uppercase tracking-[0.2em] text-[10px] font-bold">
                    Under the hood
                  </summary>
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="glass-panel industrial-border px-2 py-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">File</div>
                      <div className="mt-1 text-foreground font-mono-data">{formatBytes(shardProgress.fileBytesTotal)}</div>
                    </div>
                    <div className="glass-panel industrial-border px-2 py-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">MDUs</div>
                      <div className="mt-1 text-foreground font-mono-data">
                        {shardProgress.totalUserMdus} user • {shardProgress.totalWitnessMdus} witness • 1 meta
                      </div>
                    </div>
                    <div className="glass-panel industrial-border px-2 py-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Blobs</div>
                      <div className="mt-1 text-foreground font-mono-data">
                        {shardProgress.blobsDone}/{shardProgress.blobsTotal}
                      </div>
                    </div>
                    <div className="glass-panel industrial-border px-2 py-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Phase</div>
                      <div className="mt-1 text-foreground font-mono-data">{shardProgress.phase}</div>
                    </div>
                    <div className="glass-panel industrial-border px-2 py-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Current</div>
                      <div className="mt-1 text-foreground font-mono-data">
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
              <p className="flex items-center gap-2 text-[11px] font-mono-data text-muted-foreground">
                <FileJson className="w-4 h-4 animate-pulse text-primary" />
                {isMode2 ? 'Uploading Mode 2 shards to Storage Providers...' : 'Uploading MDUs directly to Storage Provider...'}
              </p>
            )}

            {readyToUpload && !processing && !activeUploading ? (
              <div className="glass-panel industrial-border px-3 py-2 text-[11px] font-mono-data text-muted-foreground ring-1 ring-primary/15">
                Expansion complete. Ready to upload to Storage Providers.
              </div>
            ) : null}

            {readyToCommit && !processing && !activeUploading ? (
              <div className="glass-panel industrial-border px-3 py-2 text-[11px] font-mono-data text-muted-foreground ring-1 ring-primary/15">
                Upload complete. Commit the manifest root to update your deal on-chain and make the file visible in the Deal Explorer.
              </div>
            ) : null}

            {(isCommitPending || isCommitConfirming) && (
              <p className="flex items-center gap-2 text-[11px] font-mono-data text-muted-foreground">
                <FileJson className="w-4 h-4 animate-pulse text-primary" /> Committing manifest root to chain...
              </p>
            )}

            {readyToCommit || isCommitPending || isCommitConfirming || isAlreadyCommitted ? (
              <div className="flex flex-col gap-2">
                <button
                  onClick={async () => {
                    const totalSize = isMode2
                      ? shardProgress.fileBytesTotal
                      : collectedMdus.reduce((acc, m) => acc + m.data.length, 0);

                    const witnessMdus = Math.max(0, Number(shardProgress.totalWitnessMdus) || 0)
                    const totalMdus = isMode2
                      ? Math.max(0, 1 + witnessMdus + Math.max(0, Number(shardProgress.totalUserMdus) || 0))
                      : Math.max(0, collectedMdus.length)

                    try {
                      await commitContent({
                        dealId,
                        manifestRoot: currentManifestRoot || '',
                        fileSize: totalSize,
                        totalMdus,
                        witnessMdus,
                      })
                    } catch (e: unknown) {
                      const msg = e instanceof Error ? e.message : String(e)
                      addLog(`Commit failed: ${msg}`)
                    }
                  }}
                  disabled={!readyToCommit || isCommitPending || isCommitConfirming || isAlreadyCommitted}
                  data-testid="mdu-commit"
                  className="inline-flex items-center justify-center bg-primary px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.16)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] disabled:opacity-50"
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
                  <div className="text-[10px] font-mono-data text-muted-foreground truncate uppercase tracking-[0.2em]">
                    Tx: {commitHash}
                  </div>
                )}
              </div>
            ) : null}

            {logs.length > 0 ? (
              <div className="mt-2 p-3 glass-panel industrial-border text-[10px] font-mono-data text-muted-foreground">
                <p className="mb-2 text-primary font-bold uppercase tracking-[0.2em]">System Activity</p>
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
              className={`mt-4 inline-flex items-center justify-center px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.16)] transition-all disabled:opacity-50 ${isUploadComplete ? 'bg-accent/20 text-accent cursor-not-allowed ring-1 ring-accent/30' : 'bg-primary hover:bg-primary/90 text-primary-foreground'}`}
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
              <div className="mt-2 p-3 glass-panel industrial-border text-[10px] font-mono-data text-muted-foreground">
                <p className="mb-1 text-primary font-bold uppercase tracking-[0.2em]">Upload Progress</p>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {uploadProgress.map((p, i) => (
                      <div key={i} className="flex justify-between items-center">
                      <span>{p.label}:</span>
                      <span className={`font-bold ${p.status === 'complete' ? 'text-accent' : p.status === 'error' ? 'text-destructive' : 'text-primary'}`}>
                        {p.status.toUpperCase()} {p.error ? `(${p.error})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isMode2 && mode2UploadError && (
              <div className="text-[11px] font-mono-data text-destructive">
                Mode 2 upload failed: {mode2UploadError}
              </div>
            )}

            {mirrorStatus !== 'idle' && (
              <div
                className={`text-[11px] font-mono-data ${mirrorStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                Gateway mirror: {mirrorStatus === 'skipped' ? 'skipped' : mirrorStatus}
                {mirrorError ? ` (${mirrorError})` : ''}
              </div>
            )}
        </div>
      )}

      {/* Visualization Grid */}
      {shards.length > 0 && (
        <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
          <div className="relative flex justify-between items-center mb-6 gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">
                /mnt/slab_map
              </div>
              <h3 className="mt-2 text-sm font-semibold flex items-center gap-2 text-foreground">
                <FileJson className="w-4 h-4 text-primary" />
                Slab Map
              </h3>
              <div className="mt-1 text-[11px] text-muted-foreground font-mono-data">
                8&nbsp;MiB MDU = 64 × 128&nbsp;KiB blobs.{" "}
                <Link to="/technology?section=mdu-primer" className="text-primary hover:underline">
                  MDU primer
                </Link>
              </div>
            </div>
            <div className="shrink-0 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
              {shards.filter((s) => s.status === 'expanded').length} / {shards.length} MDUs Expanded
            </div>
          </div>

          <div className="relative grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 max-h-[420px] overflow-y-auto pr-2">
            {shards.map((shard) => {
              const state =
                shard.status === 'expanded' ? 'COMPLETE' : shard.status === 'processing' ? 'PROCESSING' : 'EMPTY'
              const stateClass =
                shard.status === 'expanded'
                  ? 'text-accent'
                  : shard.status === 'processing'
                    ? 'text-primary'
                    : 'text-muted-foreground'
              const cellClass =
                shard.status === 'expanded'
                  ? 'bg-accent'
                  : shard.status === 'processing'
                    ? 'bg-primary/20 animate-pulse'
                    : 'bg-background/50'
              const ringClass =
                shard.status === 'expanded'
                  ? 'ring-1 ring-accent/30'
                  : shard.status === 'processing'
                    ? 'ring-1 ring-primary/30'
                    : 'ring-1 ring-border/30'

              return (
                <div
                  key={shard.id}
                  className={`relative overflow-hidden glass-panel industrial-border aspect-square p-2 ${ringClass}`}
                  title={shard.commitments[0] || 'Pending...'}
                >
                  {shard.status === 'processing' ? (
                    <div className="absolute inset-0 pointer-events-none animate-scan opacity-20" />
                  ) : null}

                  <div className="relative flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
                    <span>MDU {shard.id}</span>
                    <span className={stateClass}>{state}</span>
                  </div>

                  <div className="relative mt-2 grid grid-cols-8 gap-[1px] bg-border/40 p-[1px]">
                    {Array.from({ length: 64 }).map((_, i) => (
                      <div key={i} className={`aspect-square ${cellClass}`} />
                    ))}
                  </div>

                  <div className="relative mt-2 truncate text-[10px] font-mono-data text-muted-foreground uppercase tracking-[0.2em]">
                    {shard.status === 'expanded'
                      ? `ROOT ${shard.commitments[0]?.slice(0, 8) ?? '—'}…`
                      : shard.status === 'processing'
                        ? 'EXPANDING...'
                        : 'PENDING'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
