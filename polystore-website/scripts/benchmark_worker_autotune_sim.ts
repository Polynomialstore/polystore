import {
  ExpansionWorkerAutotuneCacheStore,
  buildExpansionWorkerAutotuneCandidates,
  buildExpansionWorkerCalibrationPlan,
  finalizeExpansionWorkerAutotuneSelection,
  getCachedExpansionWorkerAutotuneSelection,
  pickExpansionWorkerCount,
} from '../src/lib/expansionWorkers'

function parseNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

const hardwareConcurrency = parseNumberEnv('HARDWARE_CONCURRENCY', 12)
const totalUserMdus = parseNumberEnv('TOTAL_USER_MDUS', 13)
const rsK = parseNumberEnv('RS_K', 8)
const rsM = parseNumberEnv('RS_M', 4)

// Default fixture mirrors issue #196's documented 100 MiB / RS 8+4 / 12 logical CPU browser profile.
// Values are total prepare wall-clock milliseconds by user-MDU worker concurrency.
const defaultWallMsByWorker: Record<number, number> = {
  1: 179_300,
  3: 115_200,
  5: 100_900,
  6: 109_700,
}
const wallMsByWorker = process.env.WALL_MS_BY_WORKER
  ? (JSON.parse(process.env.WALL_MS_BY_WORKER) as Record<string, number>)
  : defaultWallMsByWorker

const shape = {
  hardwareConcurrency,
  totalJobs: totalUserMdus,
  rsK,
  rsM,
  kzgCommitBackend: 'webgpu-scheduler',
  rustCommitBackend: 'webgpu-msm',
  kzgWebGpuAvailable: true,
  kzgWebGpuProbeStatus: 'passed',
  kzgWebGpuBucketWidth: 12,
  kzgWebGpuReductionMode: 'parallel16',
  kzgWebGpuCalibrationStatus: 'benchmark-matrix',
  kzgWebGpuCalibrationSource: 'benchmark-matrix',
  kzgWebGpuCalibrationCacheKey: 'simulated-webgpu-msm-fixture',
  schedulerOwner: 'browser-user-mdu-kzg-scheduler-v1',
  schedulerConcurrency: 1,
  schedulerMaxQueueDepth: 32,
}

const candidates = buildExpansionWorkerAutotuneCandidates(hardwareConcurrency, totalUserMdus)
const staticWorkerCount = pickExpansionWorkerCount(hardwareConcurrency, totalUserMdus)
const plan = buildExpansionWorkerCalibrationPlan(shape)
const samples = candidates.map((workerCount) => {
  const wallMs = Number(wallMsByWorker[workerCount] ?? wallMsByWorker[String(workerCount)])
  return {
    workerCount,
    wallMs,
    sampleJobs: totalUserMdus,
    scoreMs: wallMs / totalUserMdus,
  }
})
const store = new ExpansionWorkerAutotuneCacheStore({ storage: memoryStorage() })
const selection = finalizeExpansionWorkerAutotuneSelection(shape, samples, {
  cacheStore: store,
  calibrationComplete: true,
  nowMs: Date.now(),
})
const cached = getCachedExpansionWorkerAutotuneSelection(shape, store)
const staticWallMs = Number(wallMsByWorker[staticWorkerCount] ?? wallMsByWorker[String(staticWorkerCount)] ?? Number.NaN)
const selectedWallMs = Number(wallMsByWorker[selection.workerCount] ?? wallMsByWorker[String(selection.workerCount)] ?? Number.NaN)

console.log(
  JSON.stringify(
    {
      fixture: 'issue-196-deterministic-worker-autotune-sim',
      note:
        'Deterministic selector simulation; use browser prepare profiles for native WebGPU wall-clock evidence when available.',
      hardware_concurrency: hardwareConcurrency,
      total_user_mdus: totalUserMdus,
      rs_profile: `${rsK}+${rsM}`,
      static_worker_count: staticWorkerCount,
      candidates,
      plan,
      samples,
      selected_worker_count: selection.workerCount,
      selected_source: selection.source,
      selected_reason: selection.reason,
      cache_hit_after_store: cached?.cacheHit ?? false,
      cache_key: selection.cacheKey,
      static_wall_ms: staticWallMs,
      selected_wall_ms: selectedWallMs,
      improvement_vs_static_ms: Number.isFinite(staticWallMs) && Number.isFinite(selectedWallMs) ? staticWallMs - selectedWallMs : null,
      improvement_vs_static_pct:
        Number.isFinite(staticWallMs) && Number.isFinite(selectedWallMs) && staticWallMs > 0
          ? ((staticWallMs - selectedWallMs) / staticWallMs) * 100
          : null,
    },
    null,
    2,
  ),
)
