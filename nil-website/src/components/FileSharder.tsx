import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { CheckCircle2, Cpu, FileJson, LoaderCircle, UploadCloud, Wallet } from 'lucide-react';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { pickExpansionWorkerCount } from '../lib/expansionWorkers';
import { workerClient } from '../lib/worker-client';
import { useDirectUpload } from '../hooks/useDirectUpload'; // New import
import { useDirectCommit } from '../hooks/useDirectCommit'; // New import
import { appConfig } from '../config';
import { NILFS_RECORD_PATH_MAX_BYTES, sanitizeNilfsRecordPath } from '../lib/nilfsPath';
import {
  deleteDealDirectory,
  listDealFiles,
  readManifestBlob,
  readManifestRoot,
  readMdu,
  readShard,
  writeSlabGenerationAtomically,
} from '../lib/storage/OpfsAdapter';
import {
  mode2RowsForK,
  parseNilfsFilesFromMdu0,
  parseNilfsRootTableFromMdu0,
  reconstructMduFromMode2SlotSlices,
} from '../lib/nilfsLocal';
import { decodeRawPrefixFromMdu, inferWitnessCountFromOpfs, RAW_MDU_CAPACITY } from '../lib/nilfsOpfsFetch';
import { lcdFetchDeal } from '../api/lcdClient';
import { providerFetchMduWindowWithSession } from '../api/providerClient';
import { parseServiceHint } from '../lib/serviceHint';
import { resolveProviderEndpoints } from '../lib/providerDiscovery';
import { useLocalGateway } from '../hooks/useLocalGateway';
import { maybeWrapNilceZstd, peekNilceHeader, NILCE_FLAG_COMPRESSION_ZSTD } from '../lib/nilce';
import { isGatewayMode2UploadEnabled, isTrustedLocalGatewayBase } from '../lib/transport/mode';
import { postSparseArtifact } from '../lib/upload/sparseTransport';
import { expandSparseBytes, makeSparseArtifact } from '../lib/upload/sparseArtifacts';
import { normalizeManifestRoot } from '../lib/cacheFreshness';
import {
  buildUploadPlan,
  nonTrivialBlobsForPayload,
  PLANNER_BLOBS_PER_MDU,
  PLANNER_TRIVIAL_BLOB_WEIGHT,
  weightedWorkForMdu,
} from '../lib/upload/planner';
import { createUploadEngine, type UploadTaskEvent } from '../lib/upload/engine';
import { createSparseHttpTransportPort } from '../lib/upload/httpTransport';
import { pickUploadParallelism } from '../lib/upload/uploadParallelism';
import { bootstrapAppendBaseFromMdus as buildBootstrappedAppendBase } from '../lib/upload/bootstrapAppendBase';
import { materializeBootstrapGeneration } from '../lib/upload/bootstrapGeneration';
import { resolveMode2AppendBase } from '../lib/upload/resolveAppendBase';
import { classifyNilfsCommitError } from '../lib/nilfsCommitError';
import { waitForTransactionReceipt } from '../lib/evmRpc';
import {
  decodeComputeRetrievalSessionIdsResult,
  encodeComputeRetrievalSessionIdsData,
  encodeConfirmRetrievalSessionsData,
  encodeOpenRetrievalSessionsData,
} from '../lib/nilstorePrecompile';

interface ShardItem {
  id: number;
  commitments: string[]; // Hex strings from witness
  status: 'pending' | 'processing' | 'expanded' | 'error';
}

type WasmStatus = 'idle' | 'initializing' | 'ready' | 'error';

interface PreparedBrowserMdu {
  index: number
  data: Uint8Array
  fullSize?: number
}

interface PreparedBrowserShard {
  data: Uint8Array
  fullSize?: number
}

interface PreparedBrowserShardSet {
  index: number
  shards: PreparedBrowserShard[]
}

type WorkflowStepState = 'idle' | 'active' | 'done' | 'error'
type UploadPanelState = 'idle' | 'running' | 'success' | 'error'
type DealSetupStatus = 'loading' | 'ready' | 'error'

type WorkflowDoneSummaryTone = 'neutral' | 'primary' | 'success'

interface WorkflowDoneSummaryChip {
  label: string
  value: string
  tone?: WorkflowDoneSummaryTone
}

interface WorkflowDoneSummary {
  headline: string
  secondary?: string
  chips: WorkflowDoneSummaryChip[]
}

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
  totalMdus: number;
  mdusDone: number;
  userBytesDone: number;
  currentMduIndex: number | null;
  currentMduKind: 'user' | 'witness' | 'meta' | null;
  lastOpMs: number | null;
}

type PreparePerfSample = {
  index: number
  kind: 'user' | 'witness' | 'meta'
  rawBytes: number
  encodeMs: number
  copyMs: number
  wasmMs: number
  workerTotalMs: number
  workerQueueMs: number
  workerExpandMs: number
  workerCommitMs: number
  workerRootMs: number
  workerRustEncodeMs: number
  workerRustRsMs: number
  workerRustCommitDecodeMs: number
  workerRustCommitTransformMs: number
  workerRustCommitMsmScalarPrepMs: number
  workerRustCommitMsmBucketFillMs: number
  workerRustCommitMsmReduceMs: number
  workerRustCommitMsmDoubleMs: number
  workerRustCommitMsmMs: number
  workerRustCommitCompressMs: number
  workerRustCommitMs: number
  workerRustCommitBackend?: string
  workerRustCommitMsmSubphasesAvailable?: boolean
  totalMs: number
  batchBlobs?: number
  shardCount?: number
  concurrency?: number
  expansionPath?: 'payload' | 'encoded_mdu' | 'progressive'
}

type PreparePerfProfile = {
  totalMs: number
  fileBytes: number
  logicalBytes: number
  totalMdus: number
  totalUserMdus: number
  totalWitnessMdus: number
  userConcurrency: number
  manifestMs: number
  wallClock: {
    prepareMs: number
    userStageMs: number
    witnessConcatMs: number
    witnessStageMs: number
    userRootRegistrationMs: number
    mdu0AppendMs: number
    mdu0StageMs: number
    rootsAssembleMs: number
    manifestMs: number
  }
  summary: {
    userSampleCount: number
    witnessSampleCount: number
    metaSampleCount: number
    maxUserTotalMs: number
    maxUserCommitMs: number
    maxUserExpandMs: number
    maxUserQueueMs: number
    maxWitnessTotalMs: number
    maxWitnessCommitMs: number
    maxWitnessQueueMs: number
    sumUserTotalMs: number
    sumUserCommitMs: number
    sumUserExpandMs: number
    sumUserQueueMs: number
    sumWitnessTotalMs: number
    sumWitnessCommitMs: number
    sumWitnessQueueMs: number
    slowestUserMduIndex: number | null
    slowestWitnessMduIndex: number | null
  }
  phases: {
    jsEncodeMs: number
    jsCopyMs: number
    workerQueueMs: number
    workerExpandMs: number
    workerCommitMs: number
    workerRootMs: number
    workerRustEncodeMs: number
    workerRustRsMs: number
    workerRustCommitDecodeMs: number
    workerRustCommitTransformMs: number
    workerRustCommitMsmScalarPrepMs: number
    workerRustCommitMsmBucketFillMs: number
    workerRustCommitMsmReduceMs: number
    workerRustCommitMsmDoubleMs: number
    workerRustCommitMsmMs: number
    workerRustCommitCompressMs: number
    workerRustCommitMs: number
    userStageWallMs: number
    witnessConcatWallMs: number
    witnessStageWallMs: number
    userRootRegistrationWallMs: number
    mdu0AppendWallMs: number
    mdu0StageWallMs: number
    rootsAssembleWallMs: number
    manifestMs: number
    unaccountedMs: number
  }
  notes: {
    phasesAreParallelSums: true
    unaccountedMsIsWallClockRemainder: true
    rustCommitBackend?: string
    rustCommitMsmSubphasesAvailable?: boolean
  }
  samples: {
    user: PreparePerfSample[]
    witness: PreparePerfSample[]
    meta: PreparePerfSample[]
  }
}

type BrowserPerfRun = {
  id: number
  fileName: string
  fileSize: number
  startedAtMs: number
  phaseStarts: Record<string, number>
}

function roundPerfMs(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? NaN)) return null
  return Math.round(Number(value) * 100) / 100
}

type NilBrowserPerfBundle = {
  browserPerfLog: Array<Record<string, unknown>>
  browserPerfLast: Record<string, unknown> | null
  prepareSummary: NilPrepareSummary | null
  prepareProfile: PreparePerfProfile | null
}

type NilPrepareSummary = PreparePerfProfile['summary'] & {
  prepareWallMs: number
  manifestMs: number
  userStageWallMs: number
  witnessConcatWallMs: number
  witnessStageWallMs: number
  userRootRegistrationWallMs: number
  mdu0AppendWallMs: number
  mdu0StageWallMs: number
  rootsAssembleWallMs: number
}

function maxBy(samples: PreparePerfSample[], pick: (sample: PreparePerfSample) => number): number {
  return samples.reduce((best, sample) => Math.max(best, pick(sample)), 0)
}

function createInitialShardProgress(fileBytesTotal = 0): ShardProgressState {
  return {
    phase: 'idle',
    label: '',
    blobsDone: 0,
    blobsTotal: 0,
    blobsInCurrentMdu: 0,
    blobsPerMdu: 64,
    workDone: 0,
    workTotal: 0,
    avgWorkMs: null,
    fileBytesTotal,
    currentOpStartedAtMs: null,
    startTsMs: null,
    totalUserMdus: 0,
    totalWitnessMdus: 0,
    totalMdus: 0,
    mdusDone: 0,
    userBytesDone: 0,
    currentMduIndex: null,
    currentMduKind: null,
    lastOpMs: null,
  }
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

function isWalletUserRejected(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error || '')
  const lower = text.toLowerCase()
  return (
    lower.includes('user denied transaction signature') ||
    lower.includes('user denied') ||
    lower.includes('user rejected') ||
    lower.includes('rejected the request') ||
    lower.includes('request rejected') ||
    lower.includes('code: 4001') ||
    lower.includes('error 4001')
  )
}

const gatewayUploadPollIntervalMs = 1000
const gatewayUploadPollTimeoutMs = 2500
const gatewayUploadHeartbeatStaleMs = 15_000
const gatewayFallbackWasmMaxFileBytes = Number.POSITIVE_INFINITY
const dealSetupPollIntervalMs = 1_000
const dealSetupMaxAttempts = 30
const MDU_SIZE_BYTES = 8 * 1024 * 1024
const MANIFEST_BLOB_SIZE_BYTES = 128 * 1024
const SHARDER_SLAB_VIEW_KEY = 'nil_dashboard_sharder_slab_view_v1'

function makePreparedMdu(index: number, data: Uint8Array, fullSize = MDU_SIZE_BYTES): PreparedBrowserMdu {
  const sparse = makeSparseArtifact({ kind: 'mdu', index, bytes: data, fullSize })
  return { index, data: sparse.bytes, fullSize: sparse.fullSize }
}

function makePreparedShard(index: number, slot: number, data: Uint8Array, fullSize = data.byteLength): PreparedBrowserShard {
  const sparse = makeSparseArtifact({ kind: 'shard', index, slot, bytes: data, fullSize })
  return { data: sparse.bytes, fullSize: sparse.fullSize }
}

function makePreparedManifest(bytes: Uint8Array, fullSize = MANIFEST_BLOB_SIZE_BYTES): { bytes: Uint8Array; fullSize: number } {
  const sparse = makeSparseArtifact({ kind: 'manifest', bytes, fullSize })
  return { bytes: sparse.bytes, fullSize: sparse.fullSize }
}

export function FileSharder({ dealId, onCommitSuccess }: FileSharderProps) {
  const { isConnected, address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: appConfig.chainId });
  const { openConnectModal } = useConnectModal();
  const localGateway = useLocalGateway();
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('idle');

  const [shards, setShards] = useState<ShardItem[]>([]);
  const [collectedMdus, setCollectedMdus] = useState<PreparedBrowserMdu[]>([]);
  const [baseManifestRoot, setBaseManifestRoot] = useState<string>('');
  const [dealOwner, setDealOwner] = useState<string>('');
  const [currentManifestRoot, setCurrentManifestRoot] = useState<string | null>(null);
  const [currentManifestBlob, setCurrentManifestBlob] = useState<Uint8Array | null>(null);
  const [currentManifestBlobFullSize, setCurrentManifestBlobFullSize] = useState<number | null>(null);
  const [mirrorStatus, setMirrorStatus] = useState<'idle' | 'running' | 'success' | 'error' | 'skipped'>('idle')
  const [mirrorError, setMirrorError] = useState<string | null>(null)
  const [stripeParams, setStripeParams] = useState<{ k: number; m: number } | null>(null)
  const [stripeParamsLoaded, setStripeParamsLoaded] = useState(false)
  const [dealSetupStatus, setDealSetupStatus] = useState<DealSetupStatus>('loading')
  const [dealSetupMessage, setDealSetupMessage] = useState<string | null>(null)
  const [dealSetupReloadNonce, setDealSetupReloadNonce] = useState(0)
  const [slotBases, setSlotBases] = useState<string[]>([])
  const [slotProviders, setSlotProviders] = useState<string[]>([])
  const [mode2Shards, setMode2Shards] = useState<PreparedBrowserShardSet[]>([])
  const [mode2Uploading, setMode2Uploading] = useState(false)
  const [mode2UploadComplete, setMode2UploadComplete] = useState(false)
  const [mode2UploadError, setMode2UploadError] = useState<string | null>(null)
  const [compressUploads, setCompressUploads] = useState(true)
  const [slabViewMode, setSlabViewMode] = useState<'summary' | 'detail'>('summary')

  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [, setLogs] = useState<string[]>([]);
  const [shardProgress, setShardProgress] = useState<ShardProgressState>(createInitialShardProgress());
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
  const persistInFlightRef = useRef<Promise<void> | null>(null)
  const lastPersistedManifestRootRef = useRef<string | null>(null)
  const autoUploadManifestRef = useRef<string | null>(null)
  const autoCommitManifestRef = useRef<string | null>(null)
  const lastStaleCommitMessageRef = useRef<string | null>(null)
  const browserPerfRunRef = useRef<BrowserPerfRun | null>(null)
  const browserPerfSeqRef = useRef(1)
  const dealSetupAttemptRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const gatewayUploadProgressRef = useRef<{ phase: string; workDone: number; workTotal: number }>({
    phase: '',
    workDone: 0,
    workTotal: 0,
  })

  // Use the direct upload hook
  const { uploadProgress, isUploading, uploadMdus, reset: resetUpload } = useDirectUpload({
    dealId, 
    manifestRoot: currentManifestRoot || "",
    previousManifestRoot: baseManifestRoot || "",
    manifestBlob: currentManifestBlob,
    manifestBlobFullSize: currentManifestBlobFullSize ?? undefined,
    providerBaseUrl: slotBases[0] || appConfig.spBase,
  });

  // Use the direct commit hook
  const { commitContent, isPending: isCommitPending, isConfirming: isCommitConfirming, isSuccess: isCommitSuccess, hash: commitHash, error: commitError } = useDirectCommit();
  const uploadEngine = useMemo(
    () =>
      createUploadEngine({
        transport: createSparseHttpTransportPort(),
        parallelism: pickUploadParallelism(
          typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
        ),
        chainCommitter: {
          commitContent,
        },
      }),
    [commitContent],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const slabView = window.sessionStorage.getItem(SHARDER_SLAB_VIEW_KEY)
      if (slabView === 'summary' || slabView === 'detail') {
        setSlabViewMode(slabView)
      }
    } catch (e) {
      console.warn('Failed to restore sharder UI preferences', e)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(SHARDER_SLAB_VIEW_KEY, slabViewMode)
    } catch (e) {
      console.warn('Failed to persist sharder UI preferences', e)
    }
  }, [slabViewMode])

  const addLog = useCallback((msg: string) => setLogs(prev => [...prev, msg]), []);

  const browserPerfLog = useCallback(
    (event: string, extra: Record<string, unknown> = {}) => {
      const now = performance.now()
      const run = browserPerfRunRef.current
      const perfObj =
        typeof performance !== 'undefined'
          ? (performance as typeof performance & {
              memory?: {
                usedJSHeapSize?: number
                totalJSHeapSize?: number
                jsHeapSizeLimit?: number
              }
            })
          : null
      const memory = perfObj?.memory
      const payload = {
        ...extra,
        event,
        dealId,
        runId: run?.id ?? null,
        fileName: run?.fileName ?? null,
        fileBytes: run?.fileSize ?? null,
        sinceRunMs: run ? roundPerfMs(now - run.startedAtMs) : null,
        heapUsedBytes: roundPerfMs(memory?.usedJSHeapSize),
        heapTotalBytes: roundPerfMs(memory?.totalJSHeapSize),
        heapLimitBytes: roundPerfMs(memory?.jsHeapSizeLimit),
        visibilityState:
          typeof document !== 'undefined' && typeof document.visibilityState === 'string'
            ? document.visibilityState
            : null,
      }
      const MAX_BROWSER_PERF_EVENTS = 512
      if (typeof window !== 'undefined') {
        const perfWindow = window as typeof window & {
          __nilBrowserPerfLog?: Array<Record<string, unknown>>
          __nilBrowserPerfLast?: Record<string, unknown>
          __nilPerfBundle?: NilBrowserPerfBundle
        }
        if (!Array.isArray(perfWindow.__nilBrowserPerfLog)) {
          perfWindow.__nilBrowserPerfLog = []
        }
        perfWindow.__nilBrowserPerfLog.push(payload)
        if (perfWindow.__nilBrowserPerfLog.length > MAX_BROWSER_PERF_EVENTS) {
          perfWindow.__nilBrowserPerfLog.splice(0, perfWindow.__nilBrowserPerfLog.length - MAX_BROWSER_PERF_EVENTS)
        }
        perfWindow.__nilBrowserPerfLast = payload
        perfWindow.__nilPerfBundle = {
          browserPerfLog: perfWindow.__nilBrowserPerfLog,
          browserPerfLast: perfWindow.__nilBrowserPerfLast ?? null,
          prepareSummary: perfWindow.__nilPerfBundle?.prepareSummary ?? null,
          prepareProfile: perfWindow.__nilPerfBundle?.prepareProfile ?? null,
        }
      }
      if (import.meta.env.DEV) {
        console.log('[browser-perf]', payload)
      }
    },
    [dealId],
  )

  const browserPerfStartRun = useCallback(
    (file: File) => {
      browserPerfRunRef.current = {
        id: browserPerfSeqRef.current++,
        fileName: file.name,
        fileSize: file.size,
        startedAtMs: performance.now(),
        phaseStarts: {},
      }
      browserPerfLog('run:start', {
        hardwareConcurrency:
          typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
            ? Number(navigator.hardwareConcurrency)
            : null,
      })
    },
    [browserPerfLog],
  )

  const browserPerfStartPhase = useCallback(
    (phase: string, extra: Record<string, unknown> = {}) => {
      const run = browserPerfRunRef.current
      if (!run) return
      run.phaseStarts[phase] = performance.now()
      browserPerfLog(`${phase}:start`, extra)
    },
    [browserPerfLog],
  )

  const browserPerfEndPhase = useCallback(
    (phase: string, extra: Record<string, unknown> = {}) => {
      const run = browserPerfRunRef.current
      const now = performance.now()
      const startedAtMs = run?.phaseStarts[phase]
      const durationMs = startedAtMs !== undefined ? roundPerfMs(now - startedAtMs) : null
      if (run && startedAtMs !== undefined) {
        delete run.phaseStarts[phase]
      }
      browserPerfLog(`${phase}:end`, {
        durationMs,
        ...extra,
      })
    },
    [browserPerfLog],
  )

  const browserPerfUploadTaskEvent = useCallback(
    (event: UploadTaskEvent) => {
      browserPerfLog(`upload_task:${event.phase}`, {
        artifactKind: event.kind,
        target: event.target,
        index: event.index ?? null,
        slot: event.slot ?? null,
        bytes: event.bytes,
        fullSize: event.fullSize ?? null,
        durationMs: event.durationMs !== undefined ? roundPerfMs(event.durationMs) : null,
        ok: event.ok ?? null,
        error: event.error ?? null,
      })
    },
    [browserPerfLog],
  )
  const resetUploadPanel = useCallback(() => {
    setProcessing(false)
    setShards([])
    setCollectedMdus([])
    setCurrentManifestRoot(null)
    setCurrentManifestBlob(null)
    setCurrentManifestBlobFullSize(null)
    setLogs([])
    setShardProgress(createInitialShardProgress())
    resetUpload()
    setMode2Shards([])
    setMode2Uploading(false)
    setMode2UploadComplete(false)
    setMode2UploadError(null)
    setMirrorStatus('idle')
    setMirrorError(null)
    autoUploadManifestRef.current = null
    autoCommitManifestRef.current = null
    gatewayUploadProgressRef.current = {
      phase: '',
      workDone: 0,
      workTotal: 0,
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [resetUpload])

  const openRetrievalWindows = useCallback(
    async (
      params: {
        manifestRoot: string
        requests: Array<{
          key: string
          provider: string
          startMduIndex: number
          startBlobIndex: number
          blobCount: number
        }>
      },
    ): Promise<Map<string, `0x${string}`>> => {
      if (!publicClient) throw new Error('EVM RPC client unavailable')
      if (!walletClient) throw new Error('Wallet not connected')
      const signer = (walletClient.account?.address || address) as `0x${string}` | undefined
      if (!signer || !String(signer).startsWith('0x')) throw new Error('Connect wallet to open retrieval sessions')
      if (params.requests.length === 0) return new Map<string, `0x${string}`>()
      const requests = params.requests.map((request, idx) => ({
        dealId: BigInt(dealId),
        provider: request.provider,
        manifestRoot: params.manifestRoot as `0x${string}`,
        startMduIndex: BigInt(request.startMduIndex),
        startBlobIndex: request.startBlobIndex,
        blobCount: BigInt(request.blobCount),
        nonce: BigInt(Date.now() + idx),
        expiresAt: 0n,
      }))
      const computeCall = await publicClient.call({
        account: signer,
        to: appConfig.nilstorePrecompile as `0x${string}`,
        data: encodeComputeRetrievalSessionIdsData(requests),
      })
      const computeData = computeCall.data as `0x${string}`
      if (!computeData || computeData === '0x') throw new Error('computeRetrievalSessionIds returned empty data')
      const { sessionIds } = decodeComputeRetrievalSessionIdsResult(computeData)
      if (sessionIds.length !== requests.length) throw new Error('computeRetrievalSessionIds returned unexpected session count')
      const openTxHash = await walletClient.sendTransaction({
        account: signer,
        to: appConfig.nilstorePrecompile as `0x${string}`,
        data: encodeOpenRetrievalSessionsData(requests),
        value: 0n,
        chain: walletClient.chain ?? undefined,
      })
      await waitForTransactionReceipt(openTxHash)
      return new Map(params.requests.map((request, idx) => [request.key, sessionIds[idx] as `0x${string}`]))
    },
    [address, dealId, publicClient, walletClient],
  )

  const confirmMduRetrievalSessions = useCallback(
    async (sessionIds: readonly `0x${string}`[]) => {
      if (sessionIds.length === 0) return
      if (!publicClient) throw new Error('EVM RPC client unavailable')
      if (!walletClient) throw new Error('Wallet not connected')
      const signer = (walletClient.account?.address || address) as `0x${string}` | undefined
      if (!signer || !String(signer).startsWith('0x')) throw new Error('Connect wallet to confirm retrieval sessions')
      const txHash = await walletClient.sendTransaction({
        account: signer,
        to: appConfig.nilstorePrecompile as `0x${string}`,
        data: encodeConfirmRetrievalSessionsData(sessionIds),
        value: 0n,
        chain: walletClient.chain ?? undefined,
      })
      await waitForTransactionReceipt(txHash)
    },
    [address, publicClient, walletClient],
  )

  const isMode2 = Boolean(stripeParams && stripeParams.k > 0 && stripeParams.m > 0)
  const gatewayMode2Enabled = isMode2 && !appConfig.gatewayDisabled
  const gatewayReachable = isGatewayMode2UploadEnabled({
    gatewayDisabled: !gatewayMode2Enabled,
    gatewayBase: localGateway.url || appConfig.gatewayBase,
    localGatewayStatus: localGateway.status,
  })
  const activeUploading = isMode2 ? mode2Uploading : isUploading
  const isUploadComplete = isMode2
    ? mode2UploadComplete
    : uploadProgress.length > 0 && uploadProgress.every(p => p.status === 'complete');

  useEffect(() => {
    let cancelled = false
    async function loadDeal() {
      setStripeParamsLoaded(false)
      setDealSetupStatus('loading')
      setDealSetupMessage(null)
      dealSetupAttemptRef.current = 0
      if (!dealId) {
        setBaseManifestRoot('')
        setDealOwner('')
        setStripeParams(null)
        setSlotBases([])
        setSlotProviders([])
        setDealSetupStatus('ready')
        setStripeParamsLoaded(true)
        return
      }
      for (let attempt = 0; attempt < dealSetupMaxAttempts && !cancelled; attempt += 1) {
        dealSetupAttemptRef.current = attempt + 1
        try {
          const deal = await lcdFetchDeal(appConfig.lcdBase, dealId)
          const parsed = parseServiceHint(deal?.service_hint)
          const nextStripeParams =
            parsed.mode === 'mode2' && parsed.rsK && parsed.rsM
              ? { k: parsed.rsK, m: parsed.rsM }
              : parsed.mode === 'auto'
                ? { k: appConfig.defaultRsK, m: appConfig.defaultRsM }
                : null
          const endpoints = await resolveProviderEndpoints(appConfig.lcdBase, dealId)
          const readyEndpoints = endpoints.filter((endpoint) => String(endpoint.baseUrl || '').trim())
          const requiredEndpointCount =
            Array.isArray(deal?.providers) && deal.providers.length > 0
              ? deal.providers.length
              : nextStripeParams
                ? nextStripeParams.k + nextStripeParams.m
                : 1
          if (readyEndpoints.length < requiredEndpointCount) {
            throw new Error(
              `Waiting for ${String(requiredEndpointCount)} provider endpoints (${String(readyEndpoints.length)} ready).`,
            )
          }
          if (!cancelled) {
            setBaseManifestRoot(String(deal?.cid || '').trim())
            setDealOwner(String(deal?.owner || '').trim())
            setStripeParams(nextStripeParams)
            setSlotBases(readyEndpoints.map((endpoint) => endpoint.baseUrl))
            setSlotProviders(readyEndpoints.map((endpoint) => endpoint.provider))
            setDealSetupStatus('ready')
            setDealSetupMessage(null)
            setStripeParamsLoaded(true)
          }
          return
        } catch (error) {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error || 'Deal setup failed.')
          setDealSetupMessage(message)
          if (attempt < dealSetupMaxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, dealSetupPollIntervalMs))
            continue
          }
          setBaseManifestRoot('')
          setDealOwner('')
          setStripeParams(null)
          setSlotBases([])
          setSlotProviders([])
          setDealSetupStatus('error')
          setDealSetupMessage(
            message || 'Deal allocation is still propagating through chain and provider discovery. Retry in a moment.',
          )
          setStripeParamsLoaded(true)
        }
      }
    }
    loadDeal()
    return () => {
      cancelled = true
    }
  }, [dealId, dealSetupReloadNonce]);

  useEffect(() => {
    if (!isCommitSuccess) return;
    if (!currentManifestRoot || !dealId || !commitHash) return;
    if (lastCommitTxRef.current === commitHash) return;
    lastCommitTxRef.current = commitHash;
    lastCommitRef.current = currentManifestRoot;
    setBaseManifestRoot(currentManifestRoot)
    browserPerfLog('commit:confirmed', {
      commitHash,
      manifestRoot: currentManifestRoot,
    })

    const hasLocalArtifacts = collectedMdus.length > 0 || (isMode2 && mode2Shards.length > 0)
    const notifyCommitSuccess = () => {
      browserPerfLog('run:complete', {
        manifestRoot: currentManifestRoot,
        commitHash,
      })
      onCommitSuccess?.(dealId, currentManifestRoot, lastFileMetaRef.current || undefined)
    }
    if (!hasLocalArtifacts) {
      notifyCommitSuccess()
      return
    }

    const manifestRoot = currentManifestRoot
    const manifestBlob = currentManifestBlob
    const manifestBlobFullSize = currentManifestBlobFullSize
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
        const mdu0Artifact = mdus.find((mdu) => mdu.index === 0)
        const mdu0Bytes =
          mdu0Artifact?.data && mdu0Artifact.fullSize && mdu0Artifact.data.byteLength < mdu0Artifact.fullSize
            ? expandSparseBytes(mdu0Artifact.data, mdu0Artifact.fullSize)
            : mdu0Artifact?.data
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
                  shard ? [{ mduIndex: slabIndex, slot, data: shard.data, fullSize: shard.fullSize }] : [],
                )
              })
            : []
        browserPerfStartPhase('persist_local', {
          manifestRoot: safeRoot,
          mdus: mdus.length,
          shards: shardWrites.length,
        })
        await writeSlabGenerationAtomically(dealId, {
          manifestRoot: safeRoot,
          manifestBlob,
          manifestBlobFullSize: manifestBlobFullSize ?? undefined,
          mdus: mdus.map((mdu) => ({ index: mdu.index, data: mdu.data, fullSize: mdu.fullSize })),
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
        browserPerfEndPhase('persist_local', {
          ok: true,
          manifestRoot: safeRoot,
          mdus: mdus.length,
          shards: shardWrites.length,
        })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        addLog(`> Failed to save MDUs locally: ${msg}`)
        browserPerfEndPhase('persist_local', {
          ok: false,
          manifestRoot: safeRoot,
          error: msg,
        })
      } finally {
        notifyCommitSuccess()
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
    browserPerfEndPhase,
    browserPerfLog,
    browserPerfStartPhase,
    collectedMdus,
    commitHash,
    currentManifestBlob,
    currentManifestBlobFullSize,
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

  useEffect(() => {
    resetUploadPanel()
    lastFileMetaRef.current = null
  }, [dealId, resetUploadPanel])

  useEffect(() => {
    if (!commitError) {
      lastStaleCommitMessageRef.current = null
      return
    }
    if (!dealId) return
    const classified = classifyNilfsCommitError(commitError)
    if (!classified.staleBase) return
    if (lastStaleCommitMessageRef.current === classified.message) return
    lastStaleCommitMessageRef.current = classified.message

    addLog('> Commit rejected: local NilFS base is stale. Clearing browser slab cache for this deal...')
    addLog('> Refresh the deal state and retry. The browser will bootstrap the current committed slab before append.')

    void deleteDealDirectory(dealId)
      .then(() => {
        lastPersistedManifestRootRef.current = null
        addLog('> Cleared stale browser slab cache.')
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        addLog(`> Failed to clear stale browser slab cache: ${message}`)
      })
  }, [addLog, commitError, dealId]);

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
    const metadataTargets = bases.map((base) => ({
      baseUrl: base,
      mduPath: '/sp/upload_mdu',
      manifestPath: '/sp/upload_manifest',
      shardPath: '/sp/upload_shard',
      bundlePath: '/sp/upload_bundle',
      label: base,
    }))
    const shardTargets = metadataTargets
    const shardSets = mode2Shards.map((mdu) => ({
      index: 1 + witnessCount + mdu.index,
      shards: mdu.shards,
    }))

    setMode2Uploading(true)
    setMode2UploadError(null)
    setMode2UploadComplete(false)

    try {
      const result = await uploadEngine.uploadStriped({
        dealId,
        manifestRoot,
        previousManifestRoot: baseManifestRoot || '',
        manifestBlob: currentManifestBlob,
        manifestBlobFullSize: currentManifestBlobFullSize ?? undefined,
        metadataMdus,
        shardSets,
        metadataTargets,
        shardTargets,
        onTaskEvent: browserPerfUploadTaskEvent,
      })
      if (!result.ok) {
        throw new Error(result.error || 'Mode 2 upload failed')
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
  }, [baseManifestRoot, browserPerfUploadTaskEvent, collectedMdus, currentManifestBlob, currentManifestBlobFullSize, currentManifestRoot, dealId, mode2Shards, shardProgress.totalWitnessMdus, slotBases, stripeParams, uploadEngine])

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
        const res = await postSparseArtifact({
          url: `${gatewayBase}${mirrorMduPath}`,
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(idx),
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          artifact: {
            kind: 'mdu',
            index: idx,
            bytes: data,
          },
        })
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(txt || `gateway upload_mdu failed (${res.status})`)
        }
      }

      const manifestBlob = await readManifestBlob(dealId)
      if (manifestBlob && manifestBlob.byteLength > 0) {
        const manifestRes = await postSparseArtifact({
          url: `${gatewayBase}${mirrorManifestPath}`,
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          artifact: {
            kind: 'manifest',
            bytes: manifestBlob,
          },
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
        const res = await postSparseArtifact({
          url: `${gatewayBase}${mirrorShardPath}`,
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(entry.mduIndex),
            'X-Nil-Slot': String(entry.slot),
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          artifact: {
            kind: 'shard',
            index: entry.mduIndex,
            slot: entry.slot,
            bytes: shard,
          },
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

  const bootstrapMode2AppendBaseFromNetwork = useCallback(async (): Promise<{
    baseMdu0Bytes: Uint8Array
    existingUserMdus: Array<{ index: number; data: Uint8Array }>
    existingUserCount: number
    existingMaxEnd: number
    appendStartOffset: number
  } | null> => {
    const manifestRoot = normalizeManifestRoot(baseManifestRoot)
    const owner = String(dealOwner || '').trim()
    if (!manifestRoot || !owner || !stripeParams) {
      return null
    }
    const dataSlotProviders = slotProviders
      .map((value, slot) => ({
        slot,
        provider: String(value || '').trim(),
        base: String(slotBases[slot] || appConfig.spBase || '').trim().replace(/\/$/, ''),
      }))
      .filter((entry) => entry.provider && entry.base)
      .slice(0, Math.max(1, stripeParams.k))
    if (dataSlotProviders.length < Math.max(1, stripeParams.k)) {
      throw new Error('missing Mode 2 slot providers for bootstrap retrieval')
    }
    const rows = mode2RowsForK(stripeParams.k)

    const fetchCommittedMdu = async (mduIndex: number, kindLabel: string): Promise<Uint8Array> => {
      addLog(`> Bootstrap fetch: opening retrieval sessions for committed ${kindLabel} slices...`)
      const requests = dataSlotProviders.map((entry) => ({
        key: `${mduIndex}:${entry.slot}`,
        provider: entry.provider,
        startMduIndex: mduIndex,
        startBlobIndex: entry.slot * rows,
        blobCount: rows,
      }))
      const sessions = await openRetrievalWindows({ manifestRoot, requests })
      try {
        addLog(`> Bootstrap fetch: fetching committed ${kindLabel} slices...`)
        const slotSlices = await Promise.all(
          dataSlotProviders.map(async (entry) => {
            const sessionId = sessions.get(`${mduIndex}:${entry.slot}`)
            if (!sessionId) throw new Error(`missing retrieval session for ${kindLabel} slot ${entry.slot}`)
            const data = await providerFetchMduWindowWithSession(entry.base, manifestRoot, mduIndex, {
              dealId,
              owner,
              sessionId,
              startBlobIndex: entry.slot * rows,
              blobCount: rows,
            })
            return { slot: entry.slot, data }
          }),
        )
        return reconstructMduFromMode2SlotSlices(slotSlices, stripeParams.k)
      } finally {
        await confirmMduRetrievalSessions(Array.from(sessions.values()))
      }
    }

    addLog('> Mode 2 append: local slab missing/stale; bootstrapping committed slab from provider retrieval...')
    const mdu0Bytes = await fetchCommittedMdu(0, 'mdu_0')
    const files = parseNilfsFilesFromMdu0(mdu0Bytes)
    if (!files.length) {
      addLog('> Mode 2 append bootstrap: no committed NilFS files found on provider.')
      return null
    }

    const roots = parseNilfsRootTableFromMdu0(mdu0Bytes)
    let maxEnd = 0
    for (const file of files) {
      const start = Number(file.start_offset || 0)
      const sizeBytes = Number(file.size_bytes || 0)
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) continue
      maxEnd = Math.max(maxEnd, start + sizeBytes)
    }
    const userCount = maxEnd > 0 ? Math.ceil(maxEnd / RAW_MDU_CAPACITY) : 0
    if (roots.length < userCount) {
      throw new Error(`bootstrap root table mismatch: roots=${roots.length} user_mdus=${userCount}`)
    }
    const witnessCount = roots.length - userCount
    const userMduIndexes = Array.from({ length: userCount }, (_, idx) => 1 + witnessCount + idx)

    const userMdus = await Promise.all(
      userMduIndexes.map(async (mduIndex, idx) => {
        const data = await fetchCommittedMdu(mduIndex, `user mdu_${mduIndex}`)
        return { index: idx, data }
      }),
    )

    const bootstrapped = buildBootstrappedAppendBase({
      rawMduCapacity: RAW_MDU_CAPACITY,
      mdu0Bytes,
      userMdus,
      decodeRawMdu: decodeRawPrefixFromMdu,
    })
    if (!bootstrapped) {
      addLog('> Mode 2 append bootstrap: no committed NilFS files found on provider.')
      return null
    }

    try {
      await deleteDealDirectory(dealId)
      const materialized = await materializeBootstrapGeneration({
        baseMdu0Bytes: bootstrapped.baseMdu0Bytes,
        existingUserMdus: bootstrapped.existingUserMdus,
        expectedManifestRoot: manifestRoot,
        rsK: stripeParams.k,
        rsM: stripeParams.m,
        rawMduCapacity: RAW_MDU_CAPACITY,
        encodeToMdu,
        loadMdu0Builder: (data, maxUserMdus, commitmentsPerMdu) =>
          workerClient.loadMdu0Builder(data, maxUserMdus, commitmentsPerMdu),
        setMdu0Root: (index, root) => workerClient.setMdu0Root(index, root),
        getMdu0Bytes: () => workerClient.getMdu0Bytes(),
        expandMduRs: (data, k, m) => workerClient.expandMduRs(data, k, m),
        expandPayloadRs: (data, k, m) => workerClient.expandPayloadRs(data, k, m),
        shardFile: (data) => workerClient.shardFile(data),
        computeManifest: (roots) => workerClient.computeManifest(roots),
      })
      addLog(`> Mode 2 append bootstrap: verified committed manifest root ${materialized.manifestRoot}.`)
      await writeSlabGenerationAtomically(dealId, {
        manifestRoot: materialized.manifestRoot,
        manifestBlob: materialized.manifestBlob,
        mdus: [
          { index: 0, data: materialized.mdu0Bytes },
          ...materialized.witnessMdus.map((mdu) => ({ index: mdu.index, data: mdu.data })),
          ...materialized.userMdus.map((mdu) => ({
            index: 1 + materialized.witnessCount + mdu.index,
            data: mdu.data,
          })),
        ],
        shards: materialized.shardSets.flatMap((set) =>
          set.shards.map((shard, slot) => ({
            mduIndex: 1 + materialized.witnessCount + set.index,
            slot,
            data: shard.data,
            fullSize: shard.fullSize,
          })),
        ),
        metadata: {
          schema_version: 1,
          generation_id: `bootstrap-${materialized.manifestRoot.replace(/^0x/i, '').slice(0, 16)}`,
          deal_id: dealId,
          manifest_root: materialized.manifestRoot,
          owner,
          redundancy: { k: stripeParams.k, m: stripeParams.m, n: stripeParams.k + stripeParams.m },
          source: 'browser_bootstrap_retrieval',
          created_at: new Date().toISOString(),
          last_validated_at: new Date().toISOString(),
          witness_mdus: materialized.witnessCount,
          user_mdus: bootstrapped.existingUserCount,
          total_mdus: 1 + materialized.witnessCount + bootstrapped.existingUserCount,
          file_records: bootstrapped.files.map((file) => ({
            path: file.path,
            start_offset: Number(file.start_offset || 0),
            size_bytes: Number(file.size_bytes || 0),
            flags: Number(file.flags || 0),
          })),
        },
      })
      bootstrapped.baseMdu0Bytes = materialized.mdu0Bytes
      addLog(`> Mode 2 append bootstrap: cached committed slab locally (${bootstrapped.files.length} files, ${bootstrapped.existingUserCount} user MDUs, ${materialized.witnessCount} witness MDUs).`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      addLog(`> Mode 2 append bootstrap warning: failed to persist reconstructed slab locally (${msg}).`)
    }
    return bootstrapped
  }, [addLog, baseManifestRoot, confirmMduRetrievalSessions, dealId, dealOwner, openRetrievalWindows, slotBases, slotProviders, stripeParams]);

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
    if (shardProgress.mdusDone === 0 && shardProgress.userBytesDone === 0) {
      recentSpeedMibPerSecRef.current = 0;
      speedSamplesRef.current = [];
      etaDisplayMsRef.current = null;
      etaLastTickMsRef.current = null;
      etaLastRawMsRef.current = null;
    }
  }, [processing, shardProgress.startTsMs, shardProgress.mdusDone, shardProgress.userBytesDone]);

  useEffect(() => {
    if (!processing) return;
    void uiTick;

    const now = performance.now();

    // --- Rolling speed (effective bytes over a fixed window) ---
    // Using a fixed window avoids inflated "burst" speeds when progress events arrive in batches.
    const SPEED_WINDOW_MS = 3000;
    const bytesDone = Math.max(0, Math.min(shardProgress.fileBytesTotal, shardProgress.userBytesDone));
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
    const processedMib = shardProgress.userBytesDone > 0 ? shardProgress.userBytesDone / (1024 * 1024) : 0;
    const seconds = elapsedMs / 1000;
    const avgMibPerSec = seconds > 0 ? processedMib / seconds : 0;
    const mibPerSec = recentSpeedMibPerSecRef.current > 0 ? recentSpeedMibPerSecRef.current : avgMibPerSec;

    const phaseDetails = (() => {
      if (shardProgress.phase === 'shard_user') {
        const done = Math.max(0, Math.min(shardProgress.totalUserMdus, shardProgress.mdusDone))
        const parallel = shardProgress.label.toLowerCase().includes('parallel')
        if (parallel) return `User MDUs ${String(done)} / ${String(shardProgress.totalUserMdus)}`
        const current = Math.max(done + 1, Math.min(shardProgress.totalUserMdus, (shardProgress.currentMduIndex ?? 0) + 1))
        return `User MDU ${String(current)} / ${String(shardProgress.totalUserMdus)}`
      }
      if (shardProgress.phase === 'shard_witness') {
        const witnessDone = Math.max(0, shardProgress.mdusDone - shardProgress.totalUserMdus)
        const current = Math.max(
          witnessDone + 1,
          Math.min(shardProgress.totalWitnessMdus, (shardProgress.currentMduIndex ?? 0) + 1),
        )
        return `Witness MDU ${String(Math.min(current, shardProgress.totalWitnessMdus))} / ${String(shardProgress.totalWitnessMdus)}`
      }
      if (shardProgress.phase === 'finalize_mdu0') {
        return 'Finalizing MDU #0';
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
        const res = await postSparseArtifact({
          url: `${gatewayBase}${mirrorMduPath}`,
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(mdu.index),
            'X-Nil-Manifest-Root': manifestRoot,
            'X-Nil-Previous-Manifest-Root': baseManifestRoot || '',
            'Content-Type': 'application/octet-stream',
          },
          artifact: {
            kind: 'mdu',
            index: mdu.index,
            bytes: mdu.data,
            fullSize: mdu.fullSize,
          },
        })
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(txt || `gateway upload_mdu failed (${res.status})`)
        }
      }

      const manifestRes = await postSparseArtifact({
        url: `${gatewayBase}${mirrorManifestPath}`,
        headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Manifest-Root': manifestRoot,
            'X-Nil-Previous-Manifest-Root': baseManifestRoot || '',
            'Content-Type': 'application/octet-stream',
          },
        artifact: {
          kind: 'manifest',
          bytes: currentManifestBlob,
          fullSize: currentManifestBlobFullSize ?? undefined,
        },
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
            const res = await postSparseArtifact({
              url: `${gatewayBase}${mirrorShardPath}`,
              headers: {
                'X-Nil-Deal-ID': dealId,
                'X-Nil-Mdu-Index': String(slabIndex),
                'X-Nil-Slot': String(slot),
                'X-Nil-Manifest-Root': manifestRoot,
                'X-Nil-Previous-Manifest-Root': baseManifestRoot || '',
                'Content-Type': 'application/octet-stream',
              },
              artifact: {
                kind: 'shard',
                index: slabIndex,
                slot,
                bytes: shard.data,
                fullSize: shard.fullSize,
              },
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
    baseManifestRoot,
    collectedMdus,
    currentManifestBlob,
    currentManifestBlobFullSize,
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
      if (dealSetupStatus !== 'ready' || !stripeParamsLoaded) {
        alert('This deal is still finalizing. Wait for deal settings and provider routing to load before uploading.')
        return
      }

      if (persistInFlightRef.current) {
        try {
          await persistInFlightRef.current
        } catch {
          // ignore
        }
      }

      browserPerfStartRun(file)
      browserPerfStartPhase('read_file', {
        fileType: file.type || null,
      })
      lastFileMetaRef.current = { filePath: file.name, fileSizeBytes: file.size };
      const startTs = performance.now();
      autoCommitManifestRef.current = null
      setProcessing(true);
      setShards([]);
      setCollectedMdus([]);
      setCurrentManifestRoot(null);
      setCurrentManifestBlob(null);
      setCurrentManifestBlobFullSize(null);
      setLogs([]);
      autoUploadManifestRef.current = null
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
        totalMdus: 0,
        mdusDone: 0,
        userBytesDone: 0,
        currentMduIndex: null,
        currentMduKind: null,
        lastOpMs: null,
      });

      const useMode2 = Boolean(stripeParams && stripeParams.k > 0 && stripeParams.m > 0)
      const shouldTryGatewayMode2 = useMode2 && isGatewayMode2UploadEnabled({
        gatewayDisabled: !gatewayMode2Enabled,
        gatewayBase: localGateway.url || appConfig.gatewayBase,
        localGatewayStatus: localGateway.status,
      })
      browserPerfLog('flow:selected-path', {
        useMode2,
        shouldTryGatewayMode2,
        gatewayMode2Enabled,
        localGatewayStatus: localGateway.status,
      })

      if (useMode2 && gatewayMode2Enabled && !shouldTryGatewayMode2) {
        addLog('> Gateway diagnostics report disconnected; skipping gateway upload/status probes and using in-browser Mode 2 sharding + stripe upload.')
      }

      const RawMduCapacity = RAW_MDU_CAPACITY
      const rsK = useMode2 ? stripeParams!.k : 0
      const rsM = useMode2 ? stripeParams!.m : 0

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
          setCurrentManifestBlobFullSize(null)
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
            totalMdus: gatewayTotalMdus > 0 ? gatewayTotalMdus : p.totalMdus,
            mdusDone: gatewayTotalMdus > 0 ? gatewayTotalMdus : p.mdusDone,
            userBytesDone: Math.max(p.userBytesDone, gatewaySizeBytes),
            currentOpStartedAtMs: null,
            lastOpMs: performance.now() - startTs,
          }))
          browserPerfEndPhase('gateway_ingest', {
            ok: true,
            manifestRoot: root,
            sizeBytes: gatewaySizeBytes,
            totalMdus: gatewayTotalMdus,
            totalWitnessMdus: gatewayWitnessMdus,
            totalUserMdus: gatewayUserMdusFinal,
          })
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
              userBytesDone:
                bytesTotal > 0
                  ? Math.max(p.userBytesDone, Math.max(0, Math.min(bytesTotal, bytesDone)))
                  : p.userBytesDone,
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
              userBytesDone: 0,
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
            browserPerfStartPhase('gateway_ingest', {
              gatewayBase,
              attempt: i + 1,
            })
            const { payload, lastJob } = await runGatewayUpload(
              gatewayBase,
              'Gateway Mode 2: starting upload...',
              uploadId,
              gatewayBases,
            )
            if (finalizeGatewaySuccess(payload, lastJob)) return
            gatewayErrorMessage = 'gateway upload returned no manifest_root'
            gatewayUnreachable = false
            browserPerfEndPhase('gateway_ingest', {
              ok: false,
              gatewayBase,
              error: gatewayErrorMessage,
            })
            break
          } catch (e: unknown) {
            let msg = formatGatewayError(e)
            addLog(`> Gateway Mode 2 ingest failed: ${msg}`)
            browserPerfEndPhase('gateway_ingest', {
              ok: false,
              gatewayBase,
              error: msg,
            })

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
          browserPerfLog('gateway_ingest:fallback-blocked', {
            error: errorMessage,
          })
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
            browserPerfLog('gateway_ingest:fallback-blocked', {
              error: errorMessage,
              fileBytes: file.size,
            })
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
          browserPerfLog('gateway_ingest:fallback-browser', {
            fileBytes: file.size,
          })
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
        browserPerfStartPhase('prepare', {
          mode: useMode2 ? 'mode2' : 'mode1',
          path: shouldTryGatewayMode2 ? 'gateway' : 'browser',
        })
        await ensureWasmReady()
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        browserPerfEndPhase('prepare', {
          ok: false,
          error: `WASM init failed: ${msg}`,
        })
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
      browserPerfEndPhase('read_file', {
        ok: true,
        bufferBytes: buffer.byteLength,
      })
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
          browserPerfStartPhase('nilce_wrap', {
            inputBytes: bytes.length,
          })
          const wrapped = await maybeWrapNilceZstd(bytes)
          browserPerfEndPhase('nilce_wrap', {
            ok: true,
            wrapped: wrapped.wrapped,
            encoding: wrapped.encoding,
            inputBytes: logicalSizeBytes,
            outputBytes: wrapped.bytes.length,
          })
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
          browserPerfEndPhase('nilce_wrap', {
            ok: false,
            error: msg,
          })
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

    if (useMode2) {
      browserPerfStartPhase('append_bootstrap', {
        chainManifestRoot: baseManifestRoot || null,
      })
      const localManifestRoot = normalizeManifestRoot(await readManifestRoot(dealId).catch(() => null))
      const loadLocalAppendBase = async () => {
        const mdu0 = await readMdu(dealId, 0)
        if (!mdu0) return null
        const files = parseNilfsFilesFromMdu0(mdu0)
        if (files.length <= 0) return null
        const existing = await inferWitnessCountFromOpfs(dealId, files)
        if (existing.userCount <= 0) return null

        const localUserMdus: { index: number; data: Uint8Array }[] = []
        for (let i = 0; i < existing.userCount; i++) {
          const mdu = await readMdu(dealId, existing.slabStartIdx + i)
          if (!mdu) {
            throw new Error(`missing local MDU: mdu_${existing.slabStartIdx + i}.bin`)
          }
          localUserMdus.push({ index: i, data: mdu })
        }

        return {
          baseMdu0Bytes: mdu0,
          existingUserMdus: localUserMdus,
          existingUserCount: existing.userCount,
          existingMaxEnd: existing.maxEnd,
          appendStartOffset: existing.userCount * RawMduCapacity,
        }
      }

      try {
        const resolvedAppendBase = await resolveMode2AppendBase({
          localManifestRoot,
          chainManifestRoot: baseManifestRoot,
          loadLocal: loadLocalAppendBase,
          clearLocal: () => deleteDealDirectory(dealId).catch(() => undefined),
          bootstrapFromNetwork: bootstrapMode2AppendBaseFromNetwork,
          addLog,
          formatBytes,
        })
        baseMdu0Bytes = resolvedAppendBase.baseMdu0Bytes
        existingUserMdus = resolvedAppendBase.existingUserMdus
        existingUserCount = resolvedAppendBase.existingUserCount
        existingMaxEnd = resolvedAppendBase.existingMaxEnd
        browserPerfEndPhase('append_bootstrap', {
          ok: true,
          existingUserCount,
          existingMaxEnd,
          localManifestRoot,
        })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        browserPerfEndPhase('append_bootstrap', {
          ok: false,
          error: msg,
        })
        addLog(`> Mode 2 append bootstrap failed: ${msg}`)
        setShardProgress((p) => ({
          ...p,
          phase: 'error',
          label: `Mode 2 append bootstrap failed: ${msg}`,
          currentOpStartedAtMs: null,
          lastOpMs: performance.now() - startTs,
        }))
        setProcessing(false)
        return
      }
    }

    browserPerfStartPhase('plan_upload', {
      bytes: bytes.length,
      logicalBytes: logicalSizeBytes,
    })
    const uploadPlan = buildUploadPlan({
      fileBytes: bytes.length,
      rawMduCapacity: RawMduCapacity,
      useMode2,
      rsK,
      rsM,
      existingUserMdus: existingUserCount,
      existingMaxEnd,
    })
    const totalUserChunks = uploadPlan.totalUserMdus
    const totalFileBytes = uploadPlan.totalFileBytes
    const witnessMduCount = uploadPlan.witnessMduCount
    const totalMdus = uploadPlan.totalMdus
    const witnessPayloads = uploadPlan.witnessPayloads
    const userPayloads = uploadPlan.userPayloads
    const workTotal = uploadPlan.workTotal
    browserPerfEndPhase('plan_upload', {
      ok: true,
      totalUserMdus: uploadPlan.totalUserMdus,
      witnessMduCount: uploadPlan.witnessMduCount,
      blobsTotal: uploadPlan.blobsTotal,
      workTotal: uploadPlan.workTotal,
    })
    addLog(`DEBUG: File bytes: ${bytes.length}, RawMduCapacity: ${RawMduCapacity}, TotalUserMdus: ${totalUserChunks}`);
    console.log('[perf] sharding start', {
      file: file.name,
      rawBytes: bytes.length,
      rawMduCapacity: RawMduCapacity,
      totalUserMdus: totalUserChunks,
      witnessMduCount,
    });

    setShardProgress((p) => ({
      ...p,
      phase: 'planning',
      label: 'Planning slab layout...',
      blobsPerMdu: uploadPlan.blobsPerMdu,
      blobsTotal: uploadPlan.blobsTotal,
      blobsDone: 0,
      blobsInCurrentMdu: 0,
      workDone: 0,
      workTotal,
      fileBytesTotal: totalFileBytes,
      totalUserMdus: totalUserChunks,
      totalWitnessMdus: witnessMduCount,
      totalMdus,
      mdusDone: 0,
      userBytesDone: 0,
      currentOpStartedAtMs: null,
      currentMduIndex: null,
      currentMduKind: null,
    }));

    setShards(() => uploadPlan.shardItems.map((item) => ({ ...item })));

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

        let userMdusCommitted = 0;
        let witnessMdusCommitted = 0;
        let metaMdusCommitted = 0;
        let userBytesCommitted = 0;
        let workCommitted = 0;
        let prevCommitMsPerMdu: number | null = null;
        const overallMdusCommitted = () => userMdusCommitted + witnessMdusCommitted + metaMdusCommitted
        const overallBlobsCommitted = () => overallMdusCommitted() * uploadPlan.blobsPerMdu

        const pickBatchBlobs = (prevMduMs: number | null): number => {
          const TARGET_UPDATE_MS = 2500;
          const MIN_BATCH = 4;
          const MAX_BATCH = 16;
          if (!prevMduMs || !Number.isFinite(prevMduMs) || prevMduMs <= 0) return MIN_BATCH;
          const msPerBlob = prevMduMs / PLANNER_BLOBS_PER_MDU;
          const est = Math.round(TARGET_UPDATE_MS / Math.max(1, msPerBlob));
          return Math.max(MIN_BATCH, Math.min(MAX_BATCH, est));
        };

        let lastUiYieldMs = performance.now();
        const maybeYieldToUi = async (minIntervalMs = 250): Promise<void> => {
          const now = performance.now();
          if (now - lastUiYieldMs < minIntervalMs) return;
          lastUiYieldMs = now;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        };

        const userRoots: Uint8Array[] = [];
        const userMdus: PreparedBrowserMdu[] = [];
        const witnessDataBlobs: Uint8Array[] = [];
        const mode2UserShards: PreparedBrowserShardSet[] = [];
        const perfSamples: PreparePerfProfile['samples'] = {
          user: [],
          witness: [],
          meta: [],
        }
        const userStageStart = performance.now()
        const prepareHardwareConcurrency =
          typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
            ? Math.max(1, Number(navigator.hardwareConcurrency))
            : 4

        if (useMode2) {
          const userConcurrency = pickExpansionWorkerCount(prepareHardwareConcurrency, totalUserChunks)
          let nextUserIndex = 0

          const processMode2UserMdu = async (i: number): Promise<void> => {
            const opStart = performance.now()
            const isExisting = appendMode2 && i < existingUserCount
            const nonTrivialBlobs = nonTrivialBlobsForPayload(userPayloads[i] ?? 0)
            const workTotalThisMdu = weightedWorkForMdu(nonTrivialBlobs)
            setShardProgress((p) => ({
              ...p,
              phase: 'shard_user',
              label: userConcurrency > 1 ? `Sharding user MDUs in parallel (${userConcurrency} workers)...` : `Sharding user MDU #${i}...`,
              currentOpStartedAtMs: opStart,
              currentMduKind: 'user',
              currentMduIndex: i,
              blobsInCurrentMdu: 0,
              blobsDone: overallBlobsCommitted(),
              mdusDone: overallMdusCommitted(),
              userBytesDone: userBytesCommitted,
              workDone: workCommitted,
            }))
            setShards((prev) =>
              prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'processing' } : s)),
            )

            let rawChunk: Uint8Array = new Uint8Array()
            let encodedMdu: Uint8Array | null = null
            let encodeMs = 0

            if (isExisting) {
              encodedMdu = existingUserMdus[i].data
            } else {
              const newIndex = i - existingUserCount
              const start = newIndex * RawMduCapacity
              const end = Math.min(start + RawMduCapacity, bytes.length)
              rawChunk = bytes.subarray(start, end) as Uint8Array
            }
            const expansionInputSource = isExisting ? encodedMdu : rawChunk
            if (!expansionInputSource) {
              throw new Error(`missing expansion input for user MDU #${i}`)
            }
            const copyStart = performance.now()
            const chunkCopy = new Uint8Array(expansionInputSource)
            const copyMs = performance.now() - copyStart

            addLog(`> Sharding User MDU #${i}${isExisting ? ' (existing)' : ''} (RS ${rsK}+${rsM})${isExisting ? '' : ' via payload-aware path'}...`)
            const wasmStart = performance.now()
            const profileExpandedUserMdu = i === 0
            const result = isExisting
              ? await workerClient.expandMduRs(chunkCopy, rsK, rsM, { profile: profileExpandedUserMdu })
              : await workerClient.expandPayloadRs(chunkCopy, rsK, rsM, { profile: profileExpandedUserMdu })
            const wasmMs = performance.now() - wasmStart
            const workerTotalMs = Number(result.perf?.totalMs ?? 0)
            const workerExpandMs = Number(result.perf?.expandMs ?? 0)
            const workerRootMs = Number(result.perf?.rootMs ?? 0)
            const workerQueueMs = Math.max(0, wasmMs - workerTotalMs)
            const workerRustEncodeMs = Number(result.perf?.rustEncodeMs ?? 0)
            const workerRustRsMs = Number(result.perf?.rustRsMs ?? 0)
            const workerRustCommitDecodeMs = Number(result.perf?.rustCommitDecodeMs ?? 0)
            const workerRustCommitTransformMs = Number(result.perf?.rustCommitTransformMs ?? 0)
            const workerRustCommitMsmScalarPrepMs = Number(result.perf?.rustCommitMsmScalarPrepMs ?? 0)
            const workerRustCommitMsmBucketFillMs = Number(result.perf?.rustCommitMsmBucketFillMs ?? 0)
            const workerRustCommitMsmReduceMs = Number(result.perf?.rustCommitMsmReduceMs ?? 0)
            const workerRustCommitMsmDoubleMs = Number(result.perf?.rustCommitMsmDoubleMs ?? 0)
            const workerRustCommitMsmMs = Number(result.perf?.rustCommitMsmMs ?? 0)
            const workerRustCommitCompressMs = Number(result.perf?.rustCommitCompressMs ?? 0)
            const workerRustCommitMs = Number(result.perf?.rustCommitMs ?? 0)
            const workerRustCommitBackend =
              typeof result.perf?.rustCommitBackend === 'string' ? result.perf.rustCommitBackend : undefined
            const workerRustCommitMsmSubphasesAvailable =
              typeof result.perf?.rustCommitMsmSubphasesAvailable === 'boolean'
                ? result.perf.rustCommitMsmSubphasesAvailable
                : undefined

            if (!encodedMdu) {
              const encodeStart = performance.now()
              encodedMdu = encodeToMdu(rawChunk)
              encodeMs = performance.now() - encodeStart
            }
            userMdus[i] = makePreparedMdu(i, encodedMdu)

            const rootBytes = toU8(result.mdu_root)
            userRoots[i] = rootBytes
            const witnessFlat = toU8(result.witness_flat)
            witnessDataBlobs[i] = witnessFlat

            const shardsList: PreparedBrowserShard[] = []
            if (result.shards_flat && Number(result.shard_len ?? 0) > 0) {
              const shardLen = Number(result.shard_len)
              const shardsFlat = toU8(result.shards_flat)
              for (let offset = 0, slot = 0; offset < shardsFlat.byteLength; offset += shardLen, slot += 1) {
                shardsList.push(makePreparedShard(i, slot, shardsFlat.subarray(offset, offset + shardLen), shardLen))
              }
            } else {
              for (const [slot, shard] of (result.shards ?? []).entries()) {
                shardsList.push(makePreparedShard(i, slot, toU8(shard)))
              }
            }
            mode2UserShards[i] = { index: i, shards: shardsList }

            const opMs = performance.now() - opStart
            const perfSample: PreparePerfSample = {
              index: i,
              kind: 'user',
              rawBytes: isExisting ? userPayloads[i] ?? 0 : rawChunk.byteLength,
              expansionPath: isExisting ? 'encoded_mdu' : 'payload',
              concurrency: userConcurrency,
              encodeMs,
              copyMs,
              wasmMs,
              workerTotalMs,
              workerQueueMs,
              workerExpandMs,
              workerCommitMs: 0,
              workerRootMs,
              workerRustEncodeMs,
              workerRustRsMs,
              workerRustCommitDecodeMs,
              workerRustCommitTransformMs,
              workerRustCommitMsmScalarPrepMs,
              workerRustCommitMsmBucketFillMs,
              workerRustCommitMsmReduceMs,
              workerRustCommitMsmDoubleMs,
              workerRustCommitMsmMs,
              workerRustCommitCompressMs,
              workerRustCommitMs,
              workerRustCommitBackend,
              workerRustCommitMsmSubphasesAvailable,
              totalMs: opMs,
              shardCount:
                result.shards_flat && Number(result.shard_len ?? 0) > 0
                  ? Math.floor(toU8(result.shards_flat).byteLength / Math.max(1, Number(result.shard_len)))
                  : (result.shards ?? []).length,
            }
            perfSamples.user.push(perfSample)
            console.log('[perf] user mdu (mode2)', {
              ...perfSample,
            })
            prevCommitMsPerMdu = opMs
            userMdusCommitted += 1
            userBytesCommitted += userPayloads[i] ?? 0
            workCommitted += workTotalThisMdu
            setShardProgress((p) => {
              const blobsDone = overallBlobsCommitted()
              const avg =
                p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs
              return {
                ...p,
                blobsDone,
                blobsInCurrentMdu: 0,
                mdusDone: overallMdusCommitted(),
                userBytesDone: Math.min(p.fileBytesTotal, userBytesCommitted),
                currentOpStartedAtMs: null,
                lastOpMs: opMs,
                workDone: workCommitted,
                avgWorkMs: avg,
              }
            })
            setShards((prev) =>
              prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'expanded' } : s)),
            )
          }

          const workers = Array.from({ length: userConcurrency }, async () => {
            let hasMore = true
            while (hasMore) {
              const i = nextUserIndex
              nextUserIndex += 1
              if (i >= totalUserChunks) {
                hasMore = false
                continue
              }
              await processMode2UserMdu(i)
            }
          })
          await Promise.all(workers)
        } else {
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
                blobsDone: overallBlobsCommitted(),
                mdusDone: overallMdusCommitted(),
                userBytesDone: userBytesCommitted,
                workDone: workCommitted,
              }));
              setShards((prev) =>
                prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'processing' } : s)),
              );

              let rawChunk: Uint8Array = new Uint8Array();
              let encodedMdu: Uint8Array | null = null;
              let encodeMs = 0;

              if (isExisting) {
                encodedMdu = existingUserMdus[i].data;
              } else {
                const newIndex = i - existingUserCount;
                const start = newIndex * RawMduCapacity;
                const end = Math.min(start + RawMduCapacity, bytes.length);
                rawChunk = bytes.subarray(start, end) as Uint8Array;
              }
              const expansionInputSource = isExisting ? encodedMdu : rawChunk;
              if (!expansionInputSource) {
                throw new Error(`missing expansion input for user MDU #${i}`)
              }
              const copyStart = performance.now();
              const chunkCopy = new Uint8Array(expansionInputSource);
              const copyMs = performance.now() - copyStart;

              if (!encodedMdu) {
                const encodeStart = performance.now();
                encodedMdu = encodeToMdu(rawChunk);
                encodeMs = performance.now() - encodeStart;
              }
              if (!encodedMdu) {
                throw new Error(`missing encoded user MDU bytes for user MDU #${i}`)
              }
              userMdus.push(makePreparedMdu(i, encodedMdu));

              addLog(`> Sharding User MDU #${i}...`);
              const batchBlobs = pickBatchBlobs(prevCommitMsPerMdu);
              let lastProgressUiUpdateMs = 0;
              const wasmStart = performance.now();
              const result = await workerClient.shardFileProgressive(chunkCopy, {
                batchBlobs,
                onProgress: (progress) => {
                  const payload = progress as { kind?: string; done?: number; total?: number };
                  if (payload.kind !== 'blob') return;
                  const done = Number(payload.done ?? 0);
                  const now = performance.now();
                  const isFinal = done >= PLANNER_BLOBS_PER_MDU;
                  if (!isFinal && now - lastProgressUiUpdateMs < 100) return;
                  lastProgressUiUpdateMs = now;
                  setShardProgress((prev) => {
                    const blobsDone = overallBlobsCommitted() + done;
                    const doneNonTrivial = Math.min(done, nonTrivialBlobs);
                    const doneTrivial = Math.max(0, done - nonTrivialBlobs);
                    const workInMdu = doneNonTrivial + doneTrivial * PLANNER_TRIVIAL_BLOB_WEIGHT;
                    const workDone = workCommitted + Math.min(workTotalThisMdu, workInMdu);
                    const partialUserBytes = Math.min(rawChunk.byteLength, (done / PLANNER_BLOBS_PER_MDU) * rawChunk.byteLength);
                    const userBytesDone = Math.min(prev.fileBytesTotal, userBytesCommitted + partialUserBytes);
                    return {
                      ...prev,
                      blobsInCurrentMdu: done,
                      blobsDone,
                      mdusDone: overallMdusCommitted(),
                      userBytesDone,
                      workDone,
                      avgWorkMs:
                        prev.startTsMs && workDone > 0 ? (performance.now() - prev.startTsMs) / workDone : prev.avgWorkMs,
                    };
                  });
                },
              });
              const wasmMs = performance.now() - wasmStart;
              const workerTotalMs = Number(result.perf?.totalMs ?? 0);
              const workerCommitMs = Number(result.perf?.commitMs ?? 0);
              const workerRootMs = Number(result.perf?.rootMs ?? 0);
              const workerQueueMs = Math.max(0, wasmMs - workerTotalMs);

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
              const perfSample: PreparePerfSample = {
                index: i,
                kind: 'user',
                rawBytes: rawChunk.byteLength,
                expansionPath: 'progressive',
                encodeMs,
                copyMs,
                wasmMs,
                workerTotalMs,
                workerQueueMs,
                workerExpandMs: 0,
                workerCommitMs,
                workerRootMs,
                workerRustEncodeMs: 0,
                workerRustRsMs: 0,
                workerRustCommitDecodeMs: 0,
                workerRustCommitTransformMs: 0,
                workerRustCommitMsmScalarPrepMs: 0,
                workerRustCommitMsmBucketFillMs: 0,
                workerRustCommitMsmReduceMs: 0,
                workerRustCommitMsmDoubleMs: 0,
                workerRustCommitMsmMs: 0,
                workerRustCommitCompressMs: 0,
                workerRustCommitMs: 0,
                totalMs: opMs,
                batchBlobs,
              };
              perfSamples.user.push(perfSample);
              console.log('[perf] user mdu', {
                ...perfSample,
              });
              prevCommitMsPerMdu = opMs;
              userMdusCommitted += 1;
              userBytesCommitted += rawChunk.byteLength;
              workCommitted += workTotalThisMdu;
              setShardProgress((p) => {
                const blobsDone = overallBlobsCommitted();
                const avg =
                  p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
                return {
                  ...p,
                  blobsDone,
                  blobsInCurrentMdu: 0,
                  mdusDone: overallMdusCommitted(),
                  userBytesDone: Math.min(p.fileBytesTotal, userBytesCommitted),
                  currentOpStartedAtMs: null,
                  lastOpMs: opMs,
                  workDone: workCommitted,
                  avgWorkMs: avg,
                };
              });
              setShards((prev) =>
                prev.map((s) => (s.id === 1 + witnessMduCount + i ? { ...s, status: 'expanded' } : s)),
              );
              await maybeYieldToUi();
          }
        }

        if (useMode2) {
          setMode2Shards(mode2UserShards);
        }
        const userStageMs = performance.now() - userStageStart

        const witnessConcatStart = performance.now()
        const fullWitnessData = new Uint8Array(witnessDataBlobs.reduce((acc, b) => acc + b.length, 0));
        let offset = 0;
        for (const b of witnessDataBlobs) {
            fullWitnessData.set(b, offset);
            offset += b.length;
        }
        const witnessConcatMs = performance.now() - witnessConcatStart

        const witnessRoots: Uint8Array[] = [];
        const witnessMdus: PreparedBrowserMdu[] = [];
        
        const actualWitnessMduCount = Math.ceil(fullWitnessData.length / RawMduCapacity);
        if (actualWitnessMduCount !== witnessMduCount) {
          throw new Error(`witness_mdu_count mismatch (expected ${witnessMduCount}, got ${actualWitnessMduCount})`);
        }

        const witnessStageStart = performance.now()
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
              blobsDone: overallBlobsCommitted(),
              mdusDone: overallMdusCommitted(),
              userBytesDone: userBytesCommitted,
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
            const wasmStart = performance.now();
            const result = await workerClient.commitMduProfiled(chunkCopy);
            const wasmMs = performance.now() - wasmStart;
            const workerTotalMs = Number(result.perf?.totalMs ?? 0);
            const workerCommitMs = Number(result.perf?.commitMs ?? 0);
            const workerRootMs = Number(result.perf?.rootMs ?? 0);
            const workerQueueMs = Math.max(0, wasmMs - workerTotalMs);
            const workerRustCommitDecodeMs = Number(result.perf?.rustCommitDecodeMs ?? 0)
            const workerRustCommitTransformMs = Number(result.perf?.rustCommitTransformMs ?? 0)
            const workerRustCommitMsmScalarPrepMs = Number(result.perf?.rustCommitMsmScalarPrepMs ?? 0)
            const workerRustCommitMsmBucketFillMs = Number(result.perf?.rustCommitMsmBucketFillMs ?? 0)
            const workerRustCommitMsmReduceMs = Number(result.perf?.rustCommitMsmReduceMs ?? 0)
            const workerRustCommitMsmDoubleMs = Number(result.perf?.rustCommitMsmDoubleMs ?? 0)
            const workerRustCommitMsmMs = Number(result.perf?.rustCommitMsmMs ?? 0)
            const workerRustCommitCompressMs = Number(result.perf?.rustCommitCompressMs ?? 0)
            const workerRustCommitMs = Number(result.perf?.rustCommitMs ?? workerCommitMs)
            const workerRustCommitBackend =
              typeof result.perf?.rustCommitBackend === 'string' ? result.perf.rustCommitBackend : undefined
            const workerRustCommitMsmSubphasesAvailable =
              typeof result.perf?.rustCommitMsmSubphasesAvailable === 'boolean'
                ? result.perf.rustCommitMsmSubphasesAvailable
                : undefined

            const rootBytes = toU8(result.mdu_root);
            witnessRoots.push(rootBytes);
            witnessMdus.push(makePreparedMdu(1 + i, witnessMduBytes)); 

            const opMs = performance.now() - opStart;
            const perfSample: PreparePerfSample = {
              index: i,
              kind: 'witness',
              rawBytes: rawChunk.byteLength,
              expansionPath: 'progressive',
              encodeMs,
              copyMs,
              wasmMs,
              workerTotalMs,
              workerQueueMs,
              workerExpandMs: 0,
              workerCommitMs,
              workerRootMs,
              workerRustEncodeMs: 0,
              workerRustRsMs: 0,
              workerRustCommitDecodeMs,
              workerRustCommitTransformMs,
              workerRustCommitMsmScalarPrepMs,
              workerRustCommitMsmBucketFillMs,
              workerRustCommitMsmReduceMs,
              workerRustCommitMsmDoubleMs,
              workerRustCommitMsmMs,
              workerRustCommitCompressMs,
              workerRustCommitMs,
              workerRustCommitBackend,
              workerRustCommitMsmSubphasesAvailable,
              totalMs: opMs,
            };
            perfSamples.witness.push(perfSample);
            console.log('[perf] witness mdu', {
              ...perfSample,
            });
            prevCommitMsPerMdu = opMs;
            witnessMdusCommitted += 1;
            workCommitted += workTotalThisMdu;
            setShardProgress((p) => {
              const blobsDone = overallBlobsCommitted();
              const avg =
                p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
              return {
                ...p,
                blobsDone,
                blobsInCurrentMdu: 0,
                mdusDone: overallMdusCommitted(),
                userBytesDone: Math.min(p.fileBytesTotal, userBytesCommitted),
                currentOpStartedAtMs: null,
                lastOpMs: opMs,
                workDone: workCommitted,
                avgWorkMs: avg,
              };
            });
            setShards((prev) => prev.map((s) => (s.id === 1 + i ? { ...s, status: 'expanded' } : s)));
            await maybeYieldToUi();
        }
        const witnessStageMs = performance.now() - witnessStageStart

        const witnessRootsFlat = new Uint8Array(witnessRoots.length * 32)
        for (let i = 0; i < witnessRoots.length; i += 1) {
          witnessRootsFlat.set(witnessRoots[i], i * 32)
        }
        const userRootsFlat = new Uint8Array(userRoots.length * 32)
        for (let i = 0; i < userRoots.length; i += 1) {
          userRootsFlat.set(userRoots[i], i * 32)
        }

        const fileStartOffset = appendMode2 ? uploadPlan.appendStartOffset : 0;
        const recordPath = sanitizeNilfsRecordPath(file.name);
        if (recordPath !== file.name) {
          addLog(`> NilFS path truncated for V1 record table (max ${NILFS_RECORD_PATH_MAX_BYTES} bytes): ${recordPath}`);
        }
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
          blobsDone: overallBlobsCommitted(),
          mdusDone: overallMdusCommitted(),
          userBytesDone: userBytesCommitted,
          workDone: workCommitted,
        }));
        setShards((prev) => prev.map((s) => (s.id === 0 ? { ...s, status: 'processing' } : s)));
        const mdu0PrepareStart = performance.now()
        const mdu0PrepareResult = await workerClient.prepareAndCommitMdu0(
          witnessRootsFlat,
          witnessMduCount,
          userRootsFlat,
          recordPath,
          bytes.length,
          fileStartOffset,
          fileFlags,
        )
        const wasmMs = performance.now() - mdu0PrepareStart
        const userRootRegistrationMs =
          Number(mdu0PrepareResult.perf?.witnessRootSetMs ?? 0) + Number(mdu0PrepareResult.perf?.userRootSetMs ?? 0)
        const mdu0AppendMs =
          Number(mdu0PrepareResult.perf?.appendMs ?? 0) + Number(mdu0PrepareResult.perf?.bytesMs ?? 0)
        const mdu0Bytes = toU8(mdu0PrepareResult.mdu0_bytes);
        const workerTotalMs = Number(mdu0PrepareResult.perf?.totalMs ?? 0);
        const workerCommitMs = Number(mdu0PrepareResult.perf?.commitMs ?? 0);
        const workerRootMs = Number(mdu0PrepareResult.perf?.rootMs ?? 0);
        const workerQueueMs = Math.max(0, wasmMs - workerTotalMs);
        const workerRustCommitDecodeMs = Number(mdu0PrepareResult.perf?.rustCommitDecodeMs ?? 0)
        const workerRustCommitTransformMs = Number(mdu0PrepareResult.perf?.rustCommitTransformMs ?? 0)
        const workerRustCommitMsmScalarPrepMs = Number(mdu0PrepareResult.perf?.rustCommitMsmScalarPrepMs ?? 0)
        const workerRustCommitMsmBucketFillMs = Number(mdu0PrepareResult.perf?.rustCommitMsmBucketFillMs ?? 0)
        const workerRustCommitMsmReduceMs = Number(mdu0PrepareResult.perf?.rustCommitMsmReduceMs ?? 0)
        const workerRustCommitMsmDoubleMs = Number(mdu0PrepareResult.perf?.rustCommitMsmDoubleMs ?? 0)
        const workerRustCommitMsmMs = Number(mdu0PrepareResult.perf?.rustCommitMsmMs ?? 0)
        const workerRustCommitCompressMs = Number(mdu0PrepareResult.perf?.rustCommitCompressMs ?? 0)
        const workerRustCommitMs = Number(mdu0PrepareResult.perf?.rustCommitMs ?? workerCommitMs)
        const workerRustCommitBackend =
          typeof mdu0PrepareResult.perf?.rustCommitBackend === 'string' ? mdu0PrepareResult.perf.rustCommitBackend : undefined
        const workerRustCommitMsmSubphasesAvailable =
          typeof mdu0PrepareResult.perf?.rustCommitMsmSubphasesAvailable === 'boolean'
            ? mdu0PrepareResult.perf.rustCommitMsmSubphasesAvailable
            : undefined
        const mdu0Root = toU8(mdu0PrepareResult.mdu_root);
        setShards((prev) => prev.map((s) => (s.id === 0 ? { ...s, status: 'expanded' } : s)));
        const opMs = performance.now() - opStartMdu0;
        const mdu0StageMs = opMs
        const metaPerfSample: PreparePerfSample = {
          index: 0,
          kind: 'meta',
          rawBytes: mdu0Bytes.byteLength,
          expansionPath: 'progressive',
          encodeMs: 0,
          copyMs: 0,
          wasmMs,
          workerTotalMs,
          workerQueueMs,
          workerExpandMs: 0,
          workerCommitMs,
          workerRootMs,
          workerRustEncodeMs: 0,
          workerRustRsMs: 0,
          workerRustCommitDecodeMs,
          workerRustCommitTransformMs,
          workerRustCommitMsmScalarPrepMs,
          workerRustCommitMsmBucketFillMs,
          workerRustCommitMsmReduceMs,
          workerRustCommitMsmDoubleMs,
          workerRustCommitMsmMs,
          workerRustCommitCompressMs,
          workerRustCommitMs,
          workerRustCommitBackend,
          workerRustCommitMsmSubphasesAvailable,
          totalMs: opMs,
        }
        perfSamples.meta.push(metaPerfSample)
        console.log('[perf] meta mdu0', {
          prepareBuilderMs: Number(mdu0PrepareResult.perf?.prepareBuilderMs ?? 0),
          ...metaPerfSample,
        });
        prevCommitMsPerMdu = opMs;
        metaMdusCommitted += 1;
        workCommitted += workTotalThisMdu0;
        setShardProgress((p) => {
          const blobsDone = overallBlobsCommitted();
          const avg =
            p.startTsMs && workCommitted > 0 ? (performance.now() - p.startTsMs) / workCommitted : p.avgWorkMs;
          return {
            ...p,
            blobsDone,
            blobsInCurrentMdu: 0,
            mdusDone: overallMdusCommitted(),
            userBytesDone: Math.min(p.fileBytesTotal, userBytesCommitted),
            currentOpStartedAtMs: null,
            lastOpMs: opMs,
            workDone: workCommitted,
            avgWorkMs: avg,
          };
        });

        const rootsAssembleStart = performance.now()
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
        const rootsAssembleMs = performance.now() - rootsAssembleStart

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
          makePreparedMdu(0, mdu0Bytes),
          ...witnessMdus,
          ...userMdus.map((m) => ({ ...m, index: 1 + witnessMduCount + m.index })),
        ];

        const finalRootHex = '0x' + Array.from(manifest.root).map(b => b.toString(16).padStart(2, '0')).join('');
        const finalManifest = makePreparedManifest(toU8((manifest as unknown as { blob: Uint8Array | number[] }).blob));

        setCollectedMdus(finalMdus);
        setCurrentManifestRoot(finalRootHex);
        setCurrentManifestBlob(finalManifest.bytes);
        setCurrentManifestBlobFullSize(finalManifest.fullSize);
        
        setShardProgress((p) => ({
          ...p,
          phase: 'done',
          label: 'Client-side expansion complete.',
          currentOpStartedAtMs: null,
          currentMduIndex: null,
          currentMduKind: null,
          blobsDone: p.blobsTotal,
          blobsInCurrentMdu: 0,
          mdusDone: p.totalMdus,
          userBytesDone: p.fileBytesTotal,
        }));

        addLog(`> Manifest Root: ${finalRootHex.slice(0, 16)}...`);
        console.log(`[Debug] Full Manifest Root: ${finalRootHex}`);
        addLog(
          useMode2
            ? `> Total MDUs: ${finalMdus.length} (1 Meta + ${witnessMduCount} Witness + ${userMdus.length} User); ${mode2UserShards.length} striped user MDUs uploaded for this generation`
            : `> Total MDUs: ${finalMdus.length} (1 Meta + ${witnessMduCount} Witness + ${userMdus.length} User)`,
        );
        const elapsedMs = performance.now() - startTs;
        const sumBy = (samples: PreparePerfSample[], pick: (sample: PreparePerfSample) => number) =>
          samples.reduce((total, sample) => total + pick(sample), 0)
        const allSamples = [...perfSamples.user, ...perfSamples.witness, ...perfSamples.meta]
        const rustCommitBackend =
          perfSamples.user.find((sample) => typeof sample.workerRustCommitBackend === 'string')?.workerRustCommitBackend
        const rustCommitMsmSubphasesAvailable = perfSamples.user.some(
          (sample) => sample.workerRustCommitMsmSubphasesAvailable === true,
        )
        const slowestUserSample =
          perfSamples.user.reduce<PreparePerfSample | null>(
            (best, sample) => (!best || sample.totalMs > best.totalMs ? sample : best),
            null,
          ) ?? null
        const prepareProfile: PreparePerfProfile = {
          totalMs: elapsedMs,
          fileBytes: bytes.length,
          logicalBytes: logicalSizeBytes,
          totalMdus: finalMdus.length,
          totalUserMdus: totalUserChunks,
          totalWitnessMdus: witnessMduCount,
          userConcurrency: useMode2 ? pickExpansionWorkerCount(prepareHardwareConcurrency, totalUserChunks) : 1,
          manifestMs,
          wallClock: {
            prepareMs: elapsedMs,
            userStageMs,
            witnessConcatMs,
            witnessStageMs,
            userRootRegistrationMs,
            mdu0AppendMs,
            mdu0StageMs,
            rootsAssembleMs,
            manifestMs,
          },
          summary: {
            userSampleCount: perfSamples.user.length,
            witnessSampleCount: perfSamples.witness.length,
            metaSampleCount: perfSamples.meta.length,
            maxUserTotalMs: maxBy(perfSamples.user, (sample) => sample.totalMs),
            maxUserCommitMs: maxBy(perfSamples.user, (sample) => sample.workerRustCommitMs),
            maxUserExpandMs: maxBy(perfSamples.user, (sample) => sample.workerExpandMs),
            maxUserQueueMs: maxBy(perfSamples.user, (sample) => sample.workerQueueMs),
            maxWitnessTotalMs: maxBy(perfSamples.witness, (sample) => sample.totalMs),
            maxWitnessCommitMs: maxBy(perfSamples.witness, (sample) => sample.workerCommitMs),
            maxWitnessQueueMs: maxBy(perfSamples.witness, (sample) => sample.workerQueueMs),
            sumUserTotalMs: sumBy(perfSamples.user, (sample) => sample.totalMs),
            sumUserCommitMs: sumBy(perfSamples.user, (sample) => sample.workerRustCommitMs),
            sumUserExpandMs: sumBy(perfSamples.user, (sample) => sample.workerExpandMs),
            sumUserQueueMs: sumBy(perfSamples.user, (sample) => sample.workerQueueMs),
            sumWitnessTotalMs: sumBy(perfSamples.witness, (sample) => sample.totalMs),
            sumWitnessCommitMs: sumBy(perfSamples.witness, (sample) => sample.workerCommitMs),
            sumWitnessQueueMs: sumBy(perfSamples.witness, (sample) => sample.workerQueueMs),
            slowestUserMduIndex: slowestUserSample?.index ?? null,
            slowestWitnessMduIndex:
              perfSamples.witness.reduce<PreparePerfSample | null>(
                (best, sample) => (!best || sample.totalMs > best.totalMs ? sample : best),
                null,
              )?.index ?? null,
          },
          phases: {
            jsEncodeMs: sumBy(allSamples, (sample) => sample.encodeMs),
            jsCopyMs: sumBy(allSamples, (sample) => sample.copyMs),
            workerQueueMs: sumBy(allSamples, (sample) => sample.workerQueueMs),
            workerExpandMs: sumBy(allSamples, (sample) => sample.workerExpandMs),
            workerCommitMs: sumBy(allSamples, (sample) => sample.workerCommitMs),
            workerRootMs: sumBy(allSamples, (sample) => sample.workerRootMs),
            workerRustEncodeMs: sumBy(allSamples, (sample) => sample.workerRustEncodeMs),
            workerRustRsMs: sumBy(allSamples, (sample) => sample.workerRustRsMs),
            workerRustCommitDecodeMs: sumBy(allSamples, (sample) => sample.workerRustCommitDecodeMs),
            workerRustCommitTransformMs: sumBy(allSamples, (sample) => sample.workerRustCommitTransformMs),
            workerRustCommitMsmScalarPrepMs: sumBy(allSamples, (sample) => sample.workerRustCommitMsmScalarPrepMs),
            workerRustCommitMsmBucketFillMs: sumBy(allSamples, (sample) => sample.workerRustCommitMsmBucketFillMs),
            workerRustCommitMsmReduceMs: sumBy(allSamples, (sample) => sample.workerRustCommitMsmReduceMs),
            workerRustCommitMsmDoubleMs: sumBy(allSamples, (sample) => sample.workerRustCommitMsmDoubleMs),
            workerRustCommitMsmMs: sumBy(allSamples, (sample) => sample.workerRustCommitMsmMs),
            workerRustCommitCompressMs: sumBy(allSamples, (sample) => sample.workerRustCommitCompressMs),
            workerRustCommitMs: sumBy(allSamples, (sample) => sample.workerRustCommitMs),
            userStageWallMs: userStageMs,
            witnessConcatWallMs: witnessConcatMs,
            witnessStageWallMs: witnessStageMs,
            userRootRegistrationWallMs: userRootRegistrationMs,
            mdu0AppendWallMs: mdu0AppendMs,
            mdu0StageWallMs: mdu0StageMs,
            rootsAssembleWallMs: rootsAssembleMs,
            manifestMs,
            unaccountedMs: 0,
          },
          notes: {
            phasesAreParallelSums: true,
            unaccountedMsIsWallClockRemainder: true,
            rustCommitBackend,
            rustCommitMsmSubphasesAvailable,
          },
          samples: perfSamples,
        }
        prepareProfile.phases.unaccountedMs = Math.max(
          0,
          prepareProfile.totalMs -
            prepareProfile.phases.jsEncodeMs -
            prepareProfile.phases.jsCopyMs -
            prepareProfile.phases.workerQueueMs -
            prepareProfile.phases.workerExpandMs -
            prepareProfile.phases.workerCommitMs -
            prepareProfile.phases.workerRootMs -
            prepareProfile.phases.manifestMs,
        )

        if (typeof window !== 'undefined') {
          (
            window as typeof window & {
              __nilPreparePerf?: PreparePerfProfile
              __nilPrepareSummary?: NilPrepareSummary
              __nilPerfBundle?: NilBrowserPerfBundle
            }
          ).__nilPreparePerf = prepareProfile
          const prepareSummary = {
            prepareWallMs: roundPerfMs(elapsedMs) ?? 0,
            manifestMs: roundPerfMs(manifestMs) ?? 0,
            userStageWallMs: roundPerfMs(userStageMs) ?? 0,
            witnessConcatWallMs: roundPerfMs(witnessConcatMs) ?? 0,
            witnessStageWallMs: roundPerfMs(witnessStageMs) ?? 0,
            userRootRegistrationWallMs: roundPerfMs(userRootRegistrationMs) ?? 0,
            mdu0AppendWallMs: roundPerfMs(mdu0AppendMs) ?? 0,
            mdu0StageWallMs: roundPerfMs(mdu0StageMs) ?? 0,
            rootsAssembleWallMs: roundPerfMs(rootsAssembleMs) ?? 0,
            ...prepareProfile.summary,
          }
          ;(
            window as typeof window & {
              __nilPrepareSummary?: NilPrepareSummary
              __nilPerfBundle?: NilBrowserPerfBundle
              __nilBrowserPerfLog?: Array<Record<string, unknown>>
              __nilBrowserPerfLast?: Record<string, unknown>
            }
          ).__nilPrepareSummary = prepareSummary
          ;(
            window as typeof window & {
              __nilPerfBundle?: NilBrowserPerfBundle
              __nilBrowserPerfLog?: Array<Record<string, unknown>>
              __nilBrowserPerfLast?: Record<string, unknown>
            }
          ).__nilPerfBundle = {
            browserPerfLog:
              (
                window as typeof window & {
                  __nilBrowserPerfLog?: Array<Record<string, unknown>>
                }
              ).__nilBrowserPerfLog ?? [],
            browserPerfLast:
              (
                window as typeof window & {
                  __nilBrowserPerfLast?: Record<string, unknown>
                }
              ).__nilBrowserPerfLast ?? null,
            prepareSummary,
            prepareProfile,
          }
        }
        console.log('[perf] sharding totals', {
          totalMs: elapsedMs,
          fileBytes: bytes.length,
          totalMdus: finalMdus.length,
          totalUserMdus: totalUserChunks,
          totalWitnessMdus: witnessMduCount,
          manifestMs,
        });
        console.log('[perf] prepare summary', {
          prepareWallMs: roundPerfMs(elapsedMs),
          userConcurrency: prepareProfile.userConcurrency,
          totalUserMdus: totalUserChunks,
          totalWitnessMdus: witnessMduCount,
          userStageWallMs: roundPerfMs(userStageMs),
          witnessConcatWallMs: roundPerfMs(witnessConcatMs),
          witnessStageWallMs: roundPerfMs(witnessStageMs),
          userRootRegistrationWallMs: roundPerfMs(userRootRegistrationMs),
          mdu0AppendWallMs: roundPerfMs(mdu0AppendMs),
          mdu0StageWallMs: roundPerfMs(mdu0StageMs),
          rootsAssembleWallMs: roundPerfMs(rootsAssembleMs),
          maxUserTotalMs: roundPerfMs(prepareProfile.summary.maxUserTotalMs),
          maxUserCommitMs: roundPerfMs(prepareProfile.summary.maxUserCommitMs),
          maxUserExpandMs: roundPerfMs(prepareProfile.summary.maxUserExpandMs),
          maxUserQueueMs: roundPerfMs(prepareProfile.summary.maxUserQueueMs),
          maxWitnessTotalMs: roundPerfMs(prepareProfile.summary.maxWitnessTotalMs),
          maxWitnessCommitMs: roundPerfMs(prepareProfile.summary.maxWitnessCommitMs),
          maxWitnessQueueMs: roundPerfMs(prepareProfile.summary.maxWitnessQueueMs),
          sumUserCommitMs: roundPerfMs(prepareProfile.summary.sumUserCommitMs),
          sumUserExpandMs: roundPerfMs(prepareProfile.summary.sumUserExpandMs),
          sumUserQueueMs: roundPerfMs(prepareProfile.summary.sumUserQueueMs),
          sumWitnessCommitMs: roundPerfMs(prepareProfile.summary.sumWitnessCommitMs),
          sumWitnessQueueMs: roundPerfMs(prepareProfile.summary.sumWitnessQueueMs),
          rustCommitDecodeMs: roundPerfMs(prepareProfile.phases.workerRustCommitDecodeMs),
          rustCommitTransformMs: roundPerfMs(prepareProfile.phases.workerRustCommitTransformMs),
          rustCommitMsmScalarPrepMs: roundPerfMs(prepareProfile.phases.workerRustCommitMsmScalarPrepMs),
          rustCommitMsmBucketFillMs: roundPerfMs(prepareProfile.phases.workerRustCommitMsmBucketFillMs),
          rustCommitMsmReduceMs: roundPerfMs(prepareProfile.phases.workerRustCommitMsmReduceMs),
          rustCommitMsmDoubleMs: roundPerfMs(prepareProfile.phases.workerRustCommitMsmDoubleMs),
          workerRustCommitMsmMs: roundPerfMs(prepareProfile.phases.workerRustCommitMsmMs),
          rustCommitCompressMs: roundPerfMs(prepareProfile.phases.workerRustCommitCompressMs),
          rustCommitBackend,
          rustCommitMsmSubphasesAvailable,
          slowestUserMduIndex: prepareProfile.summary.slowestUserMduIndex,
          slowestWitnessMduIndex: prepareProfile.summary.slowestWitnessMduIndex,
          manifestMs: roundPerfMs(manifestMs),
          note: 'max* fields are closest to wall-clock critical path; sum* fields are parallel worker totals',
        });
        console.log('[perf] prepare profile', prepareProfile);
        browserPerfEndPhase('prepare', {
          ok: true,
          totalMs: roundPerfMs(elapsedMs),
          fileBytes: bytes.length,
          totalMdus: finalMdus.length,
          totalUserMdus: totalUserChunks,
          totalWitnessMdus: witnessMduCount,
          userConcurrency: prepareProfile.userConcurrency,
          userStageWallMs: roundPerfMs(userStageMs),
          witnessConcatWallMs: roundPerfMs(witnessConcatMs),
          witnessStageWallMs: roundPerfMs(witnessStageMs),
          userRootRegistrationWallMs: roundPerfMs(userRootRegistrationMs),
          mdu0AppendWallMs: roundPerfMs(mdu0AppendMs),
          mdu0StageWallMs: roundPerfMs(mdu0StageMs),
          rootsAssembleWallMs: roundPerfMs(rootsAssembleMs),
          maxUserTotalMs: roundPerfMs(prepareProfile.summary.maxUserTotalMs),
          maxUserCommitMs: roundPerfMs(prepareProfile.summary.maxUserCommitMs),
          maxUserExpandMs: roundPerfMs(prepareProfile.summary.maxUserExpandMs),
          maxUserQueueMs: roundPerfMs(prepareProfile.summary.maxUserQueueMs),
          maxWitnessTotalMs: roundPerfMs(prepareProfile.summary.maxWitnessTotalMs),
          maxWitnessCommitMs: roundPerfMs(prepareProfile.summary.maxWitnessCommitMs),
          maxWitnessQueueMs: roundPerfMs(prepareProfile.summary.maxWitnessQueueMs),
          sumUserCommitMs: roundPerfMs(prepareProfile.summary.sumUserCommitMs),
          sumUserExpandMs: roundPerfMs(prepareProfile.summary.sumUserExpandMs),
          sumUserQueueMs: roundPerfMs(prepareProfile.summary.sumUserQueueMs),
          sumWitnessCommitMs: roundPerfMs(prepareProfile.summary.sumWitnessCommitMs),
          sumWitnessQueueMs: roundPerfMs(prepareProfile.summary.sumWitnessQueueMs),
          slowestUserMduIndex: prepareProfile.summary.slowestUserMduIndex,
          slowestWitnessMduIndex: prepareProfile.summary.slowestWitnessMduIndex,
          manifestMs: roundPerfMs(manifestMs),
        })

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
        browserPerfLog('run:error', {
          error: msg,
        })
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
  }, [addLog, baseManifestRoot, bootstrapMode2AppendBaseFromNetwork, browserPerfEndPhase, browserPerfLog, browserPerfStartPhase, browserPerfStartRun, compressUploads, dealId, dealSetupStatus, ensureWasmReady, gatewayMode2Enabled, isConnected, localGateway.status, localGateway.url, rehydrateGatewayFromOpfs, resetUpload, stripeParams, stripeParamsLoaded]);

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
    e.target.value = ''
  };

  const isAlreadyCommitted = isCommitSuccess && lastCommitRef.current === currentManifestRoot;
  const hasManifestRoot = Boolean(currentManifestRoot && currentManifestRoot.trim());
  const readyToUpload =
    hasManifestRoot &&
    !isUploadComplete &&
    (collectedMdus.length > 0 || (isMode2 && mode2Shards.length > 0));
  const readyToCommit = hasManifestRoot && isUploadComplete && !isAlreadyCommitted;
  const commitRejectedByUser = isWalletUserRejected(commitError)
  const commitDisplayError = commitError && !commitRejectedByUser ? commitError : null
  const uploadErrorMessage =
    mode2UploadError ||
    uploadProgress.find((entry) => entry.status === 'error')?.error ||
    null
  const expansionError = shardProgress.phase === 'error'
  const uploadError = Boolean(uploadErrorMessage)
  const hasError = expansionError || uploadError || Boolean(commitDisplayError);
  const currentFileMeta = lastFileMetaRef.current
  const showStatusPanel =
    processing ||
    activeUploading ||
    readyToUpload ||
    readyToCommit ||
    isCommitPending ||
    isCommitConfirming ||
    isAlreadyCommitted ||
    hasError;
  const uploadPanelState = useMemo<UploadPanelState>(() => {
    if (hasError) return 'error'
    if (isAlreadyCommitted) return 'success'
    if (showStatusPanel || hasManifestRoot) return 'running'
    return 'idle'
  }, [hasError, hasManifestRoot, isAlreadyCommitted, showStatusPanel])
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
  const sharderSummary = useMemo(() => {
    if (isMode2 && gatewayMode2Enabled) {
      return gatewayReachable ? 'Using local gateway' : 'Processing in browser'
    }
    if (wasmStatus === 'initializing') return 'Preparing browser processing'
    if (wasmStatus === 'error') return 'Browser processing unavailable'
    return 'Processing in browser'
  }, [gatewayMode2Enabled, gatewayReachable, isMode2, wasmStatus])
  const sharderSummaryToneClass =
    wasmStatus === 'error'
      ? 'text-destructive'
      : gatewayReachable && isMode2 && gatewayMode2Enabled
        ? 'text-success'
        : 'text-muted-foreground'

  const startPreparedUpload = useCallback(
    async (trigger: 'auto' | 'manual' = 'manual') => {
      if (!currentManifestRoot) return false
      if (processing || activeUploading || isUploadComplete) return false

      browserPerfStartPhase('upload', {
        trigger,
        mode: isMode2 ? 'mode2' : 'mode1',
        preparedMdus: collectedMdus.length,
        stripedMdus: mode2Shards.length,
      })
      if (trigger === 'auto') {
        addLog('> Expansion complete. Starting upload to Storage Providers...')
      } else {
        addLog('> Retrying upload to Storage Providers...')
      }

      const ok = isMode2 ? await uploadMode2() : await uploadMdus(collectedMdus)
      browserPerfEndPhase('upload', {
        ok,
        mode: isMode2 ? 'mode2' : 'mode1',
      })
      if (ok) {
        void mirrorSlabToGateway()
      }
      return ok
    },
    [
      activeUploading,
      addLog,
      browserPerfEndPhase,
      browserPerfStartPhase,
      collectedMdus,
      currentManifestRoot,
      isMode2,
      isUploadComplete,
      mirrorSlabToGateway,
      mode2Shards.length,
      processing,
      uploadMdus,
      uploadMode2,
    ],
  )

  const retryPreparedUpload = useCallback(async () => {
    autoUploadManifestRef.current = currentManifestRoot
    await startPreparedUpload('manual')
  }, [currentManifestRoot, startPreparedUpload])

  useEffect(() => {
    if (!readyToUpload || processing || activeUploading || isUploadComplete) return
    const manifestRoot = String(currentManifestRoot || '').trim()
    if (!manifestRoot) return
    if (autoUploadManifestRef.current === manifestRoot) return
    autoUploadManifestRef.current = manifestRoot
    void startPreparedUpload('auto')
  }, [activeUploading, currentManifestRoot, isUploadComplete, processing, readyToUpload, startPreparedUpload])

  const workflowSteps = useMemo(() => {
    const stepState = (
      state: WorkflowStepState,
      title: string,
      detail: string,
    ) => ({ state, title, detail })

    const gatewayMode2Flow = isMode2 && gatewayMode2Enabled && gatewayReachable
    const selected = Boolean(currentFileMeta || processing || hasManifestRoot)
    const uploadDone = isUploadComplete || readyToCommit || isAlreadyCommitted || isCommitPending || isCommitConfirming
    const expandActiveInGatewayMode =
      processing &&
      shardProgress.phase !== 'gateway_uploading' &&
      shardProgress.phase !== 'done' &&
      shardProgress.phase !== 'error'

    const selectState: WorkflowStepState = expansionError && !selected ? 'error' : selected ? 'done' : 'active'
    const expandState: WorkflowStepState =
      expansionError && (processing || hasManifestRoot)
        ? 'error'
        : gatewayMode2Flow
          ? expandActiveInGatewayMode
            ? 'active'
            : hasManifestRoot || activeUploading || uploadDone
              ? 'done'
              : 'idle'
          : processing
            ? 'active'
            : hasManifestRoot
              ? 'done'
              : 'idle'
    const uploadState: WorkflowStepState =
      uploadError
        ? 'error'
        : activeUploading || shardProgress.phase === 'gateway_uploading'
          ? 'active'
          : uploadDone
            ? 'done'
            : hasManifestRoot
              ? 'active'
              : 'idle'
    const commitState: WorkflowStepState =
      commitDisplayError ? 'error' : isAlreadyCommitted ? 'done' : isCommitPending || isCommitConfirming ? 'active' : readyToCommit ? 'active' : 'idle'

    return [
      stepState(
        selectState,
        '1. Select file',
        currentFileMeta ? `${currentFileMeta.filePath} • ${formatBytes(currentFileMeta.fileSizeBytes)}` : '',
      ),
      stepState(
        expandState,
        '2. Expand slab',
        gatewayMode2Flow
          ? expandActiveInGatewayMode
            ? shardProgress.label || 'Gateway ingest and slab expansion'
            : hasManifestRoot || activeUploading || uploadDone
              ? 'Gateway ingest complete'
              : 'Gateway receives the file and computes slab layout'
          : processing
            ? shardProgress.label || 'Sharding in browser'
            : hasManifestRoot
              ? `${shards.length} MDUs prepared`
              : 'Browser computes slab layout',
      ),
      stepState(
        uploadState,
        '3. Upload to SPs',
        activeUploading || shardProgress.phase === 'gateway_uploading'
          ? 'Uploading sparse artifacts in parallel'
          : uploadDone
            ? 'Provider upload complete'
            : uploadErrorMessage
              ? uploadErrorMessage
              : hasManifestRoot
                ? 'Starts automatically after expansion'
                : gatewayMode2Flow
                  ? 'Starts after gateway ingest completes'
                  : 'Waiting for prepared artifacts',
      ),
      stepState(
        commitState,
        '4. Commit manifest',
        isAlreadyCommitted
          ? 'Committed on-chain'
          : isCommitPending || isCommitConfirming
            ? 'Waiting for wallet / chain confirmation'
            : commitRejectedByUser
              ? 'Wallet request canceled. Click commit to retry.'
            : readyToCommit
              ? 'Ready for final on-chain commit'
              : 'Commit becomes available after upload',
      ),
    ]
  }, [
    activeUploading,
    commitDisplayError,
    commitRejectedByUser,
    currentFileMeta,
    expansionError,
    gatewayMode2Enabled,
    gatewayReachable,
    hasManifestRoot,
    isAlreadyCommitted,
    isCommitConfirming,
    isCommitPending,
    isUploadComplete,
    isMode2,
    processing,
    readyToCommit,
    shardProgress.label,
    shardProgress.phase,
    shards.length,
    uploadError,
    uploadErrorMessage,
  ])

  const selectedFileDisplayName = useMemo(() => {
    const raw = String(currentFileMeta?.filePath || '').trim()
    if (!raw) return ''
    const normalized = raw.replace(/\\/g, '/')
    const parts = normalized.split('/')
    return parts[parts.length - 1] || raw
  }, [currentFileMeta])

  const uploadArtifactsDone = useMemo(
    () => uploadProgress.filter((entry) => entry.status === 'complete').length,
    [uploadProgress],
  )

  const workflowDoneSummaries = useMemo<Record<number, WorkflowDoneSummary | null>>(() => {
    const summaries: Record<number, WorkflowDoneSummary | null> = {
      0: null,
      1: null,
      2: null,
      3: null,
    }

    if (currentFileMeta) {
      const fullPath = String(currentFileMeta.filePath || '').trim()
      summaries[0] = {
        headline: selectedFileDisplayName || fullPath,
        secondary: fullPath && fullPath !== selectedFileDisplayName ? fullPath : undefined,
        chips: [
          { label: 'size', value: formatBytes(currentFileMeta.fileSizeBytes), tone: 'primary' },
        ],
      }
    }

    const totalPreparedMdus = shardProgress.totalMdus > 0 ? shardProgress.totalMdus : shards.length
    if (hasManifestRoot && totalPreparedMdus > 0) {
      const elapsedLabel = shardingUi.elapsedMs > 0 ? formatDuration(shardingUi.elapsedMs) : '—'
      const throughputLabel = shardingUi.mibPerSec > 0 ? `${shardingUi.mibPerSec.toFixed(2)} MiB/s` : '—'
      summaries[1] = {
        headline: `${String(totalPreparedMdus)} MDUs prepared`,
        chips: [
          { label: 'user', value: String(shardProgress.totalUserMdus), tone: 'neutral' },
          { label: 'witness', value: String(shardProgress.totalWitnessMdus), tone: 'neutral' },
          { label: 'elapsed', value: elapsedLabel, tone: 'primary' },
          { label: 'avg', value: throughputLabel, tone: 'primary' },
        ],
      }
    }

    if (isUploadComplete || readyToCommit || isAlreadyCommitted || isCommitPending || isCommitConfirming) {
      const uploadedArtifactsLabel =
        uploadProgress.length > 0
          ? `${String(uploadArtifactsDone)} / ${String(uploadProgress.length)} artifacts`
          : shardProgress.totalMdus > 0
            ? `${String(shardProgress.totalMdus)} MDUs uploaded`
            : 'Upload finished'
      const mirrorLabel =
        mirrorStatus === 'success'
          ? 'mirrored'
          : mirrorStatus === 'skipped'
            ? 'mirror skipped'
            : mirrorStatus === 'error'
              ? 'mirror failed'
              : null
      const mirrorTone: WorkflowDoneSummaryTone =
        mirrorStatus === 'error' ? 'primary' : 'neutral'
      summaries[2] = {
        headline: 'Provider upload complete',
        chips: [
          { label: 'artifacts', value: uploadedArtifactsLabel, tone: 'success' },
          ...(mirrorLabel ? [{ label: 'gateway', value: mirrorLabel, tone: mirrorTone }] : []),
        ],
      }
    }

    if (isAlreadyCommitted || Boolean(commitHash)) {
      const shortHash =
        commitHash && commitHash.length > 20
          ? `${commitHash.slice(0, 10)}…${commitHash.slice(-6)}`
          : commitHash || 'ready'
      summaries[3] = {
        headline: isAlreadyCommitted ? 'Committed on-chain' : 'Commit prepared',
        chips: [{ label: 'tx', value: shortHash, tone: isAlreadyCommitted ? 'success' : 'neutral' }],
      }
    }

    return summaries
  }, [
    commitHash,
    currentFileMeta,
    hasManifestRoot,
    isAlreadyCommitted,
    isCommitConfirming,
    isCommitPending,
    isUploadComplete,
    mirrorStatus,
    readyToCommit,
    selectedFileDisplayName,
    shardProgress.totalMdus,
    shardProgress.totalUserMdus,
    shardProgress.totalWitnessMdus,
    shards.length,
    shardingUi.elapsedMs,
    shardingUi.mibPerSec,
    uploadArtifactsDone,
    uploadProgress.length,
  ])

  const activeWorkflowStepIndex = useMemo(() => {
    const errorIdx = workflowSteps.findIndex((step) => step.state === 'error')
    if (errorIdx >= 0) return errorIdx
    const activeIdx = workflowSteps.findIndex((step) => step.state === 'active')
    if (activeIdx >= 0) return activeIdx
    let doneIdx = -1
    for (let i = 0; i < workflowSteps.length; i++) {
      if (workflowSteps[i].state === 'done') doneIdx = i
    }
    return doneIdx >= 0 ? doneIdx : 0
  }, [workflowSteps])

  const stepToneClasses: Record<WorkflowStepState, string> = {
    idle: 'border-border/50 bg-background/35 text-muted-foreground',
    active: 'border-primary/40 bg-primary/10 text-foreground',
    done: 'border-success/40 bg-success/10 text-foreground',
    error: 'border-destructive/40 bg-destructive/10 text-destructive',
  }
  const doneSummaryChipToneClasses: Record<WorkflowDoneSummaryTone, string> = {
    neutral: 'border-border/70 bg-background/50 text-muted-foreground',
    primary: 'border-primary/35 bg-primary/10 text-primary',
    success: 'border-success/35 bg-success/10 text-success',
  }
  const hasActiveWorkflowStep = useMemo(
    () => workflowSteps.some((step) => step.state === 'active'),
    [workflowSteps],
  )
  const showRetryUpload =
    !isUploadComplete &&
    !activeUploading &&
    !processing &&
    (expansionError || uploadError || readyToUpload)

  const slabRoleForShard = useCallback((shard: ShardItem): 'meta' | 'witness' | 'user' => {
    if (shard.id === 0) return 'meta'
    if (shard.id <= shardProgress.totalWitnessMdus) return 'witness'
    return 'user'
  }, [shardProgress.totalWitnessMdus])

  const slabStateForShard = useCallback((shard: ShardItem): 'complete' | 'processing' | 'empty' | 'error' | 'pending_witness' => {
    if (shard.status === 'expanded') return 'complete'
    if (shard.status === 'processing') return 'processing'
    if (shard.status === 'error') return 'error'
    if (slabRoleForShard(shard) === 'witness') return 'pending_witness'
    return 'empty'
  }, [slabRoleForShard])

  const slabLegendCounts = useMemo(() => {
    const counts: Record<'complete' | 'processing' | 'empty' | 'error' | 'pending_witness', number> = {
      complete: 0,
      processing: 0,
      empty: 0,
      error: 0,
      pending_witness: 0,
    }
    for (const shard of shards) {
      counts[slabStateForShard(shard)] += 1
    }
    return counts
  }, [shards, slabStateForShard])

  const slabRoleSummary = useMemo(() => {
    const summary: Record<'meta' | 'witness' | 'user', { total: number; complete: number; processing: number; pending: number; error: number }> = {
      meta: { total: 0, complete: 0, processing: 0, pending: 0, error: 0 },
      witness: { total: 0, complete: 0, processing: 0, pending: 0, error: 0 },
      user: { total: 0, complete: 0, processing: 0, pending: 0, error: 0 },
    }
    for (const shard of shards) {
      const role = slabRoleForShard(shard)
      const state = slabStateForShard(shard)
      summary[role].total += 1
      if (state === 'complete') summary[role].complete += 1
      if (state === 'processing') summary[role].processing += 1
      if (state === 'error') summary[role].error += 1
      if (state === 'empty' || state === 'pending_witness') summary[role].pending += 1
    }
    return summary
  }, [shards, slabRoleForShard, slabStateForShard])
  const triggerPreparedCommit = useCallback(
    async (trigger: 'auto' | 'manual' = 'manual') => {
      if (!readyToCommit || !currentManifestRoot) return false
      if (isCommitPending || isCommitConfirming || isAlreadyCommitted) return false

      browserPerfStartPhase('commit', {
        trigger,
        manifestRoot: currentManifestRoot,
      })
      if (trigger === 'auto') {
        addLog('> Upload complete. Starting on-chain commit...')
      } else {
        addLog('> Retrying on-chain commit...')
      }

      try {
        await uploadEngine.commitPreparedContent({
          dealId,
          previousManifestRoot: baseManifestRoot,
          manifestRoot: currentManifestRoot || '',
          isMode2,
          fileBytesTotal: shardProgress.fileBytesTotal,
          totalWitnessMdus: shardProgress.totalWitnessMdus,
          totalUserMdus: shardProgress.totalUserMdus,
          mdus: collectedMdus,
        })
        browserPerfEndPhase('commit', {
          ok: true,
          manifestRoot: currentManifestRoot,
        })
        return true
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        browserPerfEndPhase('commit', {
          ok: false,
          manifestRoot: currentManifestRoot,
          error: msg,
        })
        addLog(`Commit failed: ${msg}`)
        return false
      }
    },
    [
      addLog,
      baseManifestRoot,
      browserPerfEndPhase,
      browserPerfStartPhase,
      collectedMdus,
      currentManifestRoot,
      dealId,
      isAlreadyCommitted,
      isCommitConfirming,
      isCommitPending,
      isMode2,
      readyToCommit,
      shardProgress.fileBytesTotal,
      shardProgress.totalUserMdus,
      shardProgress.totalWitnessMdus,
      uploadEngine,
    ],
  )

  useEffect(() => {
    if (!readyToCommit || !currentManifestRoot) return
    if (isCommitPending || isCommitConfirming || isAlreadyCommitted) return
    const manifestRoot = String(currentManifestRoot || '').trim()
    if (!manifestRoot) return
    if (autoCommitManifestRef.current === manifestRoot) return
    autoCommitManifestRef.current = manifestRoot
    void triggerPreparedCommit('auto')
  }, [
    currentManifestRoot,
    isAlreadyCommitted,
    isCommitConfirming,
    isCommitPending,
    readyToCommit,
    triggerPreparedCommit,
  ])

  return (
    <div className="w-full space-y-4">
      {!isConnected ? (
        <button
          onClick={() => openConnectModal?.()}
          className="glass-panel industrial-border w-full border-2 border-dashed border-border bg-card px-6 py-10 text-center transition-all hover:border-primary/50 hover:bg-secondary/40"
        >
            <div className="nil-tab-inset mx-auto mb-4 flex h-12 w-12 items-center justify-center">
              <Wallet className="h-6 w-6 text-foreground" />
            </div>
          <div className="text-sm font-semibold text-foreground">Connect wallet to upload</div>
          <div className="mt-1 text-xs text-muted-foreground">Deals and files are owned by your Nil address.</div>
        </button>
      ) : (
        <>
          {!stripeParamsLoaded || dealSetupStatus === 'loading' ? (
            <div
              className="glass-panel industrial-border p-8 text-center"
              data-testid="mdu-deal-setup-panel"
              data-setup-state="loading"
            >
              <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-none border-2 border-border border-t-primary" />
              <div className="text-sm font-semibold text-foreground">Finalizing deal allocation…</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Waiting for the chain, LCD, and provider routing to agree on this deal before upload starts.
              </div>
              {dealSetupMessage ? (
                <div className="mt-3 text-[10px] font-mono-data uppercase tracking-[0.18em] text-muted-foreground">
                  {dealSetupMessage}
                </div>
              ) : null}
              <div className="mt-2 text-[10px] font-mono-data uppercase tracking-[0.18em] text-muted-foreground">
                Attempt {String(Math.max(1, dealSetupAttemptRef.current))} / {String(dealSetupMaxAttempts)}
              </div>
            </div>
          ) : dealSetupStatus === 'error' ? (
            <div
              className="glass-panel industrial-border p-8 text-center"
              data-testid="mdu-deal-setup-panel"
              data-setup-state="error"
            >
              <div className="text-sm font-semibold text-destructive">Deal setup is still propagating</div>
              <div className="mt-2 text-xs text-muted-foreground">
                Upload will stay blocked until this deal is visible through deal detail lookup and provider routing.
              </div>
              {dealSetupMessage ? (
                <div className="mt-3 text-[10px] font-mono-data uppercase tracking-[0.18em] text-muted-foreground">
                  {dealSetupMessage}
                </div>
              ) : null}
              <button
                type="button"
                data-testid="mdu-deal-setup-retry"
                onClick={() => setDealSetupReloadNonce((value) => value + 1)}
                className="cta-shadow mt-5 inline-flex items-center justify-center border border-primary bg-primary px-5 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Retry setup
              </button>
            </div>
          ) : (
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          className={`relative overflow-hidden glass-panel industrial-border p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)] text-sm ${isDragging ? 'border-primary/50 bg-primary/5' : ''}`}
          data-testid="mdu-upload-card"
          data-panel-state={uploadPanelState}
          data-upload-phase={uploadPhase}
        >
          <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
          {processing ? (
            <div className="absolute inset-0 pointer-events-none opacity-10 bg-primary/5" />
          ) : null}

          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="nil-section-label mb-2">/proc/sharder</p>
              <div className="text-sm font-semibold text-foreground">
                {isAlreadyCommitted
                  ? 'Upload complete'
                  : processing
                  ? 'Preparing upload'
                  : activeUploading
                    ? 'Uploading to providers'
                    : isCommitPending || isCommitConfirming
                      ? 'Committing to chain'
                      : hasError
                        ? 'Upload needs attention'
                        : currentFileMeta
                          ? 'Upload in progress'
                          : 'Upload file'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {currentFileMeta
                  ? `${currentFileMeta.filePath} • ${formatBytes(currentFileMeta.fileSizeBytes)}`
                  : 'Choose a file to add to this deal. Progress appears below.'}
              </div>
            </div>
            {hasActiveWorkflowStep ? (
              <div className="text-[9px] font-mono-data uppercase tracking-[0.2em] text-muted-foreground">
                Active
              </div>
            ) : null}
          </div>
          <div className="relative space-y-2">
            <div className="space-y-1.5">
              {workflowSteps.map((step, index) => {
                const expanded = step.state === 'error' || index === activeWorkflowStepIndex
                const doneSummary = step.state === 'done' && !expanded ? workflowDoneSummaries[index] : null
                return (
                  <div key={step.title} className={`nil-tab-panel px-3 py-2.5 ${stepToneClasses[step.state]}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data">
                        {step.state === 'done' ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                        ) : step.state === 'active' && index === 0 ? (
                          <span className="inline-block h-3.5 w-3.5 rounded-full border border-primary/70" />
                        ) : step.state === 'active' ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" />
                        ) : step.state === 'error' ? (
                          <UploadCloud className="h-3.5 w-3.5" />
                        ) : (
                          <span className="inline-block h-3.5 w-3.5 border border-current/50" />
                        )}
                        <span>{step.title}</span>
                      </div>
                      {step.state === 'active' ? null : (
                        <div className="text-[9px] font-mono-data uppercase tracking-[0.2em] text-muted-foreground">
                          {step.state === 'done' ? 'Done' : step.state === 'error' ? 'Error' : 'Pending'}
                        </div>
                      )}
                    </div>
                    {doneSummary ? (
                      <div className="mt-2 space-y-1.5">
                        <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                          {doneSummary.headline}
                        </div>
                        {doneSummary.secondary ? (
                          <div className="truncate text-[10px] font-mono-data text-muted-foreground">
                            {doneSummary.secondary}
                          </div>
                        ) : null}
                        {doneSummary.chips.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {doneSummary.chips.map((chip, chipIndex) => {
                              const tone = chip.tone || 'neutral'
                              return (
                                <span
                                  key={`${chip.label}-${chip.value}-${chipIndex}`}
                                  className={`inline-flex items-center gap-1 border px-2 py-1 text-[10px] font-mono-data tracking-[0.14em] ${doneSummaryChipToneClasses[tone]}`}
                                >
                                  <span className="uppercase opacity-80">{chip.label}</span>
                                  <span className="font-semibold normal-case tracking-normal">{chip.value}</span>
                                </span>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {expanded ? (
                      <div className="mt-2 space-y-2">
                        {step.detail ? (
                          <div className="text-[11px] font-mono-data leading-relaxed">{step.detail}</div>
                        ) : null}

                        {index === 0 ? (
                          <div className={`nil-tab-panel p-3 ${isDragging ? 'border-primary/50 bg-primary/10' : ''}`}>
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                <div className={`text-[10px] font-mono-data uppercase tracking-[0.2em] ${sharderSummaryToneClass}`}>
                                  {wasmStatus === 'initializing' ? (
                                    <span className="animate-pulse">{sharderSummary}</span>
                                  ) : (
                                    sharderSummary
                                  )}
                                </div>
                              </div>
                              <label className="cta-shadow inline-flex cursor-pointer items-center justify-center border border-primary bg-primary px-4 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]">
                                Select file
                                <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} data-testid="mdu-file-input" />
                              </label>
                            </div>
                            <label className="mt-3 inline-flex items-center gap-2 text-[10px] font-mono-data uppercase tracking-[0.2em] text-muted-foreground cursor-pointer">
                              <div className={`flex h-4 w-4 items-center justify-center border transition-colors ${compressUploads ? 'bg-primary border-primary' : 'bg-transparent border-border'}`}>
                                {compressUploads && <div className="h-1.5 w-1.5 bg-primary-foreground" />}
                              </div>
                              <input
                                type="checkbox"
                                className="hidden"
                                checked={compressUploads}
                                disabled={processing || activeUploading}
                                onChange={(e) => setCompressUploads(e.target.checked)}
                              />
                              <span>Compress before upload</span>
                            </label>
                          </div>
                        ) : null}

                        {index === 1 && processing ? (
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
                                  shardProgress.totalMdus > 0 ? `${shardProgress.mdusDone}/${shardProgress.totalMdus} MDUs` : '—'
                                )}
                              </div>
                            </div>

                            <div className="h-2 w-full overflow-hidden border border-border/60 bg-background/40">
                              <div
                                className="h-full bg-primary transition-[width] duration-300 ease-out dark:shadow-[0_0_18px_hsl(var(--primary)_/_0.25)]"
                                style={{ width: `${(shardingUi.overallPct * 100).toFixed(1)}%` }}
                              />
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
                              <div className="nil-tab-inset px-2 py-2">
                                <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Elapsed</div>
                                <div className="mt-1 text-foreground font-mono-data">{formatDuration(shardingUi.elapsedMs)}</div>
                              </div>
                              <div className="nil-tab-inset px-2 py-2">
                                <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">ETA</div>
                                <div className="mt-1 text-foreground font-mono-data">
                                  {shardingUi.etaMs == null ? '—' : formatDuration(shardingUi.etaMs)}
                                </div>
                              </div>
                              <div className="nil-tab-inset px-2 py-2">
                                <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data opacity-70">Throughput</div>
                                <div className="mt-1 text-foreground font-mono-data">{shardingUi.mibPerSec.toFixed(2)} MiB/s</div>
                              </div>
                              <div className="nil-tab-inset px-2 py-2">
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
                          </div>
                        ) : null}

                        {index === 1 && shards.length > 0 ? (
                          <div className="nil-tab-panel mt-1 p-3" data-testid="mdu-slab-map-step">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">
                                  /mnt/slab_map
                                </div>
                                <h3 className="mt-1 text-sm font-semibold flex items-center gap-2 text-foreground">
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
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setSlabViewMode('summary')}
                                  className={`border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] ${slabViewMode === 'summary' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'}`}
                                >
                                  Summary
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSlabViewMode('detail')}
                                  className={`border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] ${slabViewMode === 'detail' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'}`}
                                >
                                  Detail
                                </button>
                              </div>
                            </div>

                            <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px] font-mono-data uppercase tracking-[0.18em] text-muted-foreground">
                              <span className="nil-tab-inset px-2 py-1">
                                {slabLegendCounts.complete} complete
                              </span>
                              <span className="nil-tab-inset px-2 py-1">
                                {slabLegendCounts.processing} processing
                              </span>
                              <span className="nil-tab-inset px-2 py-1">
                                {slabLegendCounts.pending_witness} pending witness
                              </span>
                              <span className="nil-tab-inset px-2 py-1">
                                {slabLegendCounts.empty} empty
                              </span>
                              <span className="nil-tab-inset px-2 py-1">
                                {slabLegendCounts.error} error
                              </span>
                              <div className="ml-auto text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                                {shards.filter((s) => s.status === 'expanded').length} / {shards.length} MDUs Expanded
                              </div>
                            </div>

                            {slabViewMode === 'summary' ? (
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                {(['meta', 'witness', 'user'] as const).map((role) => {
                                  const row = slabRoleSummary[role]
                                  return (
                                    <div key={role} className="nil-tab-panel p-3 text-[10px] font-mono-data uppercase tracking-[0.18em]">
                                      <div className="font-bold text-foreground">
                                        {role === 'meta' ? 'Meta MDU' : role === 'witness' ? 'Witness MDUs' : 'User MDUs'}
                                      </div>
                                      <div className="mt-2 text-muted-foreground">
                                        Total: <span className="text-foreground">{row.total}</span>
                                      </div>
                                      <div className="mt-1 text-success">
                                        Complete: <span className="text-foreground">{row.complete}</span>
                                      </div>
                                      <div className="mt-1 text-primary">
                                        Processing: <span className="text-foreground">{row.processing}</span>
                                      </div>
                                      <div className="mt-1 text-muted-foreground">
                                        Pending: <span className="text-foreground">{row.pending}</span>
                                      </div>
                                      <div className="mt-1 text-destructive">
                                        Error: <span className="text-foreground">{row.error}</span>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="relative grid max-h-[420px] grid-cols-[repeat(auto-fit,minmax(172px,1fr))] gap-3 overflow-y-auto pr-2">
                                {shards.map((shard) => {
                                  const role = slabRoleForShard(shard)
                                  const stateKey = slabStateForShard(shard)
                                  const state = stateKey === 'pending_witness' ? 'PENDING WITNESS' : stateKey.toUpperCase()
                                  const stateClass =
                                    stateKey === 'complete'
                                      ? 'text-success'
                                      : stateKey === 'processing'
                                        ? 'text-primary'
                                        : stateKey === 'error'
                                          ? 'text-destructive'
                                          : stateKey === 'pending_witness'
                                            ? 'text-primary'
                                            : 'text-muted-foreground'
                                  const cellClass =
                                    stateKey === 'complete'
                                      ? 'bg-success'
                                      : stateKey === 'processing'
                                        ? 'bg-primary/20 animate-pulse'
                                        : stateKey === 'error'
                                          ? 'bg-destructive/30'
                                          : stateKey === 'pending_witness'
                                            ? 'bg-primary/10'
                                            : 'bg-background/50'
                                  const ringClass =
                                    stateKey === 'complete'
                                      ? 'ring-1 ring-success/30'
                                      : stateKey === 'processing'
                                        ? 'ring-1 ring-primary/30'
                                        : stateKey === 'error'
                                          ? 'ring-1 ring-destructive/30'
                                          : stateKey === 'pending_witness'
                                            ? 'ring-1 ring-primary/20'
                                            : 'ring-1 ring-border/30'

                                  return (
                                    <div
                                      key={shard.id}
                                      className={`relative min-h-[168px] overflow-hidden glass-panel industrial-border p-3 ${ringClass}`}
                                      title={shard.commitments[0] || 'Pending...'}
                                    >
                                      {stateKey === 'processing' ? (
                                        <div className="absolute inset-0 pointer-events-none bg-primary/5 opacity-10" />
                                      ) : null}

                                      <div className="relative flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
                                        <span>MDU {shard.id}</span>
                                        <span className={stateClass}>{state}</span>
                                      </div>

                                      <div className="relative mt-3 grid grid-cols-8 gap-[1px] bg-border/40 p-[1px]">
                                        {Array.from({ length: 64 }).map((_, i) => (
                                          <div key={i} className={`aspect-square ${cellClass}`} />
                                        ))}
                                      </div>

                                      <div className="relative mt-3 truncate text-[10px] font-mono-data uppercase tracking-[0.2em] text-muted-foreground">
                                        {role === 'meta' ? 'Meta MDU' : role === 'witness' ? 'Witness MDU' : 'User MDU'}
                                      </div>

                                      <div className="relative mt-1 truncate text-[10px] font-mono-data uppercase tracking-[0.2em] text-muted-foreground">
                                        {stateKey === 'complete'
                                          ? `ROOT ${shard.commitments[0]?.slice(0, 8) ?? '—'}…`
                                          : stateKey === 'processing'
                                            ? 'EXPANDING...'
                                            : stateKey === 'pending_witness'
                                              ? 'WAITING FOR USER ROOTS'
                                              : stateKey === 'error'
                                                ? 'RETRY REQUIRED'
                                                : 'PENDING'}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        ) : null}

                        {index === 2 ? (
                          <div className="space-y-2">
                            {activeUploading ? (
                              <p className="flex items-center gap-2 text-[11px] font-mono-data text-muted-foreground">
                                <FileJson className="w-4 h-4 animate-pulse text-primary" />
                                {isMode2 ? 'Uploading Mode 2 shards to Storage Providers...' : 'Uploading MDUs directly to Storage Provider...'}
                              </p>
                            ) : null}

                            {readyToUpload && !processing && !activeUploading ? (
                              <div className="nil-tab-panel px-3 py-2 text-[11px] font-mono-data text-muted-foreground ring-1 ring-primary/15">
                                Expansion complete. Upload starts automatically; use retry only if the provider step fails.
                              </div>
                            ) : null}

                            {showRetryUpload ? (
                              <button
                                onClick={() => {
                                  void retryPreparedUpload()
                                }}
                                data-testid="mdu-upload"
                                className="cta-shadow mt-1 inline-flex items-center justify-center border border-primary bg-primary px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-50"
                              >
                                Retry Upload
                              </button>
                            ) : isUploadComplete ? (
                              <div
                                data-testid="mdu-upload-state"
                                className="nil-tab-panel mt-1 border-success/30 bg-success/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-success"
                              >
                                Upload Complete
                              </div>
                            ) : null}

                            {!isMode2 && (activeUploading || isUploadComplete) && uploadProgress.length > 0 ? (
                              <div className="nil-tab-panel mt-2 p-3 text-[10px] font-mono-data text-muted-foreground">
                                <p className="mb-1 text-primary font-bold uppercase tracking-[0.2em]">Upload Progress</p>
                                <div className="space-y-1 max-h-24 overflow-y-auto">
                                  {uploadProgress.map((p, i) => (
                                    <div key={i} className="flex justify-between items-center">
                                      <span>{p.label}:</span>
                                      <span className={`font-bold ${p.status === 'complete' ? 'text-success' : p.status === 'error' ? 'text-destructive' : 'text-primary'}`}>
                                        {p.status.toUpperCase()} {p.error ? `(${p.error})` : ''}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {isMode2 && mode2UploadError ? (
                              <div className="nil-tab-panel text-[11px] font-mono-data text-destructive border-destructive/30 bg-destructive/5">
                                Mode 2 upload failed: {mode2UploadError}
                              </div>
                            ) : null}

                            {mirrorStatus !== 'idle' ? (
                              <div
                                className={`nil-tab-panel text-[11px] font-mono-data ${mirrorStatus === 'error' ? 'text-destructive border-destructive/30 bg-destructive/5' : 'text-muted-foreground'}`}
                              >
                                Gateway mirror: {mirrorStatus === 'skipped' ? 'skipped' : mirrorStatus}
                                {mirrorError ? ` (${mirrorError})` : ''}
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {index === 3 ? (
                          <div className="space-y-2">
                            {readyToCommit && !processing && !activeUploading ? (
                              <div className="nil-tab-panel px-3 py-2 text-[11px] font-mono-data text-muted-foreground ring-1 ring-primary/15">
                                Upload complete. Commit starts automatically; retry only if the wallet or chain step fails.
                              </div>
                            ) : null}

                            {(isCommitPending || isCommitConfirming) ? (
                              <p className="flex items-center gap-2 text-[11px] font-mono-data text-muted-foreground">
                                <FileJson className="w-4 h-4 animate-pulse text-primary" /> Committing manifest root to chain...
                              </p>
                            ) : null}

                            {readyToCommit || isCommitPending || isCommitConfirming || isAlreadyCommitted ? (
                              <div className="flex flex-col gap-2">
                                <button
                                  onClick={() => {
                                    void triggerPreparedCommit('manual')
                                  }}
                                  disabled={!readyToCommit || isCommitPending || isCommitConfirming || isAlreadyCommitted}
                                  data-testid="mdu-commit"
                                  className="cta-shadow inline-flex items-center justify-center border border-primary bg-primary px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] disabled:opacity-50"
                                >
                                  {isCommitPending
                                    ? 'Check Wallet...'
                                    : isCommitConfirming
                                      ? 'Confirming...'
                                      : isAlreadyCommitted
                                        ? 'Committed!'
                                        : 'Commit to Chain'}
                                </button>

                                {commitHash ? (
                                  <div className="text-[10px] font-mono-data text-muted-foreground truncate uppercase tracking-[0.2em]">
                                    Tx: {commitHash}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>

            {hasError ? (
              <div className="nil-tab-panel border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] font-mono-data text-destructive">
                {commitDisplayError ? `Commit failed: ${commitDisplayError.message}` : null}
                {commitDisplayError && mode2UploadError ? <span className="mx-2 text-border">|</span> : null}
                {mode2UploadError ? `Upload failed: ${mode2UploadError}` : null}
                {!commitDisplayError && !mode2UploadError && shardProgress.label ? shardProgress.label : null}
              </div>
            ) : null}
          </div>
        </div>
          )}

      </>
      )}
    </div>
  );
}
