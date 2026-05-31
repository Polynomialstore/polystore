export const DEFAULT_EXPANSION_HARDWARE_CONCURRENCY = 4
const MAX_EXPANSION_WORKERS = 6
export const EXPANSION_WORKER_AUTOTUNE_VERSION = 2
export const EXPANSION_WORKER_AUTOTUNE_CONTRACT = 'mode2-user-mdu-rs-kzg-v2'
export const EXPANSION_WORKER_AUTOTUNE_STORAGE_PREFIX = 'polystore:upload-prep-worker-autotune:'
export const MIN_AUTOTUNE_USER_MDUS = 8
export const MAX_AUTOTUNE_SAMPLE_USER_MDUS = 11
export const DEFAULT_EXPANSION_WORKER_AUTOTUNE_TIMEOUT_MS = 30_000
export const MAX_AUTOTUNE_EXPANSION_WORKERS = 8

export type ExpansionWorkerAutotuneSource =
  | 'static-disabled'
  | 'static-small-upload'
  | 'static-single-candidate'
  | 'static-unavailable'
  | 'cache-hit'
  | 'cache-miss'
  | 'calibrated'
  | 'fallback-timeout'
  | 'fallback-error'
  | 'fallback-no-samples'

export type ExpansionWorkerAutotuneShape = {
  hardwareConcurrency?: number
  totalJobs?: number
  rsK?: number
  rsM?: number
  contract?: string
  kzgCommitBackend?: string | null
  rustCommitBackend?: string | null
  kzgWebGpuAvailable?: boolean | null
  kzgWebGpuProbeStatus?: string | null
  kzgWebGpuCircuitOpen?: boolean | null
  kzgWebGpuBucketWidth?: number | null
  kzgWebGpuReductionMode?: string | null
  kzgWebGpuCalibrationStatus?: string | null
  kzgWebGpuCalibrationSource?: string | null
  kzgWebGpuCalibrationCacheKey?: string | null
  schedulerOwner?: string | null
  schedulerConcurrency?: number | null
  schedulerMaxQueueDepth?: number | null
  schedulerBatchMaxMdus?: number | null
  schedulerBatchMaxBlobs?: number | null
  schedulerBatchMaxBytes?: number | null
}

export type NormalizedExpansionWorkerAutotuneShape = Required<
  Pick<ExpansionWorkerAutotuneShape, 'contract'>
> & {
  hardwareConcurrency: number
  totalJobs: number
  rsK: number
  rsM: number
  jobBucket: string
  backendKey: string
  schedulerKey: string
  cacheKey: string
}

export type ExpansionWorkerAutotuneCache = {
  version: number
  contract: string
  cacheKey: string
  hardwareConcurrency: number
  totalJobs: number
  jobBucket: string
  rsK: number
  rsM: number
  backendKey: string
  schedulerKey: string
  selectedWorkerCount: number
  staticWorkerCount: number
  candidates: number[]
  sampledCandidates: number[]
  measuredAtMs: number
  scoreMs: number
  sampleCount: number
  reason: string
}

export type ExpansionWorkerAutotuneSample = {
  workerCount: number
  wallMs: number
  sampleJobs?: number
  scoreMs?: number
}

export type ExpansionWorkerCalibrationPlan = {
  enabled: boolean
  shouldCalibrate: boolean
  source: ExpansionWorkerAutotuneSource
  reason: string
  staticWorkerCount: number
  candidates: number[]
  sampleBatches: Array<{ workerCount: number; sampleJobs: number }>
  maxSampleJobs: number
  minJobs: number
  timeoutMs: number
  cacheKey: string
  hardwareConcurrency: number
  totalJobs: number
  rsK: number
  rsM: number
}

export type ExpansionWorkerAutotuneSelection = {
  version: number
  contract: string
  workerCount: number
  selectedWorkerCount: number
  staticWorkerCount: number
  candidates: number[]
  sampledCandidates: number[]
  source: ExpansionWorkerAutotuneSource
  cacheHit: boolean
  cacheKey: string
  reason: string
  scoreMs: number | null
  measuredAtMs: number | null
  sampleCount: number
  hardwareConcurrency: number
  totalJobs: number
  rsK: number
  rsM: number
  jobBucket: string
  backendKey: string
  schedulerKey: string
  timedOut: boolean
  cacheWritable: boolean
  samples: ExpansionWorkerAutotuneSample[]
}

export type ExpansionWorkerAutotuneStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Math.floor(Number(value))
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  return fallback
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  const numeric = Math.floor(Number(value))
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function normalizePart(value: unknown): string {
  const normalized = String(value ?? 'unknown').trim().toLowerCase()
  return normalized || 'unknown'
}

function normalizeBoolPart(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : 'unknown'
}

function normalizeNumberPart(value: unknown): string {
  const numeric = normalizeOptionalPositiveInteger(value)
  return numeric === null ? 'unknown' : String(numeric)
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.floor(value)).filter((value) => Number.isFinite(value) && value > 0))].sort(
    (a, b) => a - b,
  )
}

export function normalizeExpansionHardwareConcurrency(hardwareConcurrency?: number): number {
  return Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(Number(hardwareConcurrency)))
    : DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
}

export function normalizeExpansionTotalJobs(totalJobs?: number): number {
  return Number.isFinite(totalJobs) ? Math.max(1, Math.floor(Number(totalJobs))) : 1
}

export function expansionWorkerJobBucket(totalJobs?: number): string {
  const jobs = normalizeExpansionTotalJobs(totalJobs)
  if (jobs < MIN_AUTOTUNE_USER_MDUS) return `lt${MIN_AUTOTUNE_USER_MDUS}`
  if (jobs < 16) return '8-15'
  if (jobs < 32) return '16-31'
  if (jobs < 64) return '32-63'
  return '64+'
}

export function pickExpansionWorkerCount(hardwareConcurrency?: number, totalJobs?: number): number {
  const hc = normalizeExpansionHardwareConcurrency(hardwareConcurrency)
  const jobCap = Number.isFinite(totalJobs) ? normalizeExpansionTotalJobs(totalJobs) : Number.POSITIVE_INFINITY

  let desired = 1
  if (hc >= 10) desired = MAX_EXPANSION_WORKERS
  else if (hc >= 8) desired = 5
  else if (hc >= 6) desired = 4
  else if (hc >= 4) desired = 3
  else if (hc >= 3) desired = 2

  return Math.max(1, Math.min(desired, jobCap))
}

export function buildExpansionWorkerAutotuneCandidates(hardwareConcurrency?: number, totalJobs?: number): number[] {
  const staticCount = pickExpansionWorkerCount(hardwareConcurrency, totalJobs)
  const jobCap = Number.isFinite(totalJobs) ? normalizeExpansionTotalJobs(totalJobs) : Number.POSITIVE_INFINITY
  if (jobCap < MIN_AUTOTUNE_USER_MDUS || staticCount <= 1) return [staticCount]

  const hc = normalizeExpansionHardwareConcurrency(hardwareConcurrency)
  const upper = Math.max(1, Math.min(MAX_AUTOTUNE_EXPANSION_WORKERS, jobCap, hc, Math.max(staticCount, 1)))
  const preferred = staticCount <= 3 ? [1, 2, staticCount] : [1, 3, 5, staticCount]
  return uniqueSorted(preferred.filter((candidate) => candidate <= upper))
}

export function createExpansionWorkerAutotuneBackendKey(shape: ExpansionWorkerAutotuneShape = {}): string {
  return [
    'kzg',
    normalizePart(shape.kzgCommitBackend),
    normalizePart(shape.rustCommitBackend),
    normalizeBoolPart(shape.kzgWebGpuAvailable),
    normalizePart(shape.kzgWebGpuProbeStatus),
    normalizeBoolPart(shape.kzgWebGpuCircuitOpen),
    normalizeNumberPart(shape.kzgWebGpuBucketWidth),
    normalizePart(shape.kzgWebGpuReductionMode),
    normalizePart(shape.kzgWebGpuCalibrationStatus),
    normalizePart(shape.kzgWebGpuCalibrationSource),
    normalizePart(shape.kzgWebGpuCalibrationCacheKey),
  ].join(':')
}

export function createExpansionWorkerAutotuneSchedulerKey(shape: ExpansionWorkerAutotuneShape = {}): string {
  return [
    'scheduler',
    normalizePart(shape.schedulerOwner),
    normalizeNumberPart(shape.schedulerConcurrency),
    normalizeNumberPart(shape.schedulerMaxQueueDepth),
    normalizeNumberPart(shape.schedulerBatchMaxMdus),
    normalizeNumberPart(shape.schedulerBatchMaxBlobs),
    normalizeNumberPart(shape.schedulerBatchMaxBytes),
  ].join(':')
}

export function normalizeExpansionWorkerAutotuneShape(
  shape: ExpansionWorkerAutotuneShape = {},
): NormalizedExpansionWorkerAutotuneShape {
  const hardwareConcurrency = normalizeExpansionHardwareConcurrency(shape.hardwareConcurrency)
  const totalJobs = normalizeExpansionTotalJobs(shape.totalJobs)
  const rsK = normalizePositiveInteger(shape.rsK, 8)
  const rsM = normalizePositiveInteger(shape.rsM, 4)
  const contract = normalizePart(shape.contract ?? EXPANSION_WORKER_AUTOTUNE_CONTRACT)
  const jobBucket = expansionWorkerJobBucket(totalJobs)
  const backendKey = createExpansionWorkerAutotuneBackendKey(shape)
  const schedulerKey = createExpansionWorkerAutotuneSchedulerKey(shape)
  const cacheKey = [
    `v${EXPANSION_WORKER_AUTOTUNE_VERSION}`,
    contract,
    `hc=${hardwareConcurrency}`,
    `rs=${rsK}+${rsM}`,
    `jobs=${jobBucket}`,
    backendKey,
    schedulerKey,
  ].join('|')

  return {
    contract,
    hardwareConcurrency,
    totalJobs,
    rsK,
    rsM,
    jobBucket,
    backendKey,
    schedulerKey,
    cacheKey,
  }
}

export function createExpansionWorkerAutotuneCacheKey(shape: ExpansionWorkerAutotuneShape = {}): string {
  return normalizeExpansionWorkerAutotuneShape(shape).cacheKey
}

function resolveDefaultAutotuneStorage(): ExpansionWorkerAutotuneStorage | null {
  try {
    return (globalThis as unknown as { localStorage?: ExpansionWorkerAutotuneStorage }).localStorage ?? null
  } catch {
    return null
  }
}

function normalizeExpansionWorkerAutotuneCache(
  raw: unknown,
  shape: ExpansionWorkerAutotuneShape = {},
): ExpansionWorkerAutotuneCache | null {
  const normalized = normalizeExpansionWorkerAutotuneShape(shape)
  const obj = raw as Partial<ExpansionWorkerAutotuneCache> | null | undefined
  if (!obj || obj.version !== EXPANSION_WORKER_AUTOTUNE_VERSION) return null
  if (obj.contract !== normalized.contract || obj.cacheKey !== normalized.cacheKey) return null
  if (obj.hardwareConcurrency !== normalized.hardwareConcurrency) return null
  if (obj.rsK !== normalized.rsK || obj.rsM !== normalized.rsM) return null
  if (obj.jobBucket !== normalized.jobBucket) return null
  if (obj.backendKey !== normalized.backendKey || obj.schedulerKey !== normalized.schedulerKey) return null

  const candidates = buildExpansionWorkerAutotuneCandidates(normalized.hardwareConcurrency, normalized.totalJobs)
  const candidateSet = new Set(candidates)
  const selectedWorkerCount = Math.floor(Number(obj.selectedWorkerCount))
  if (!candidateSet.has(selectedWorkerCount)) return null
  const staticWorkerCount = pickExpansionWorkerCount(normalized.hardwareConcurrency, normalized.totalJobs)
  const measuredAtMs = Number(obj.measuredAtMs)
  const scoreMs = Number(obj.scoreMs)
  const sampleCount = Math.floor(Number(obj.sampleCount))
  if (!Number.isFinite(measuredAtMs) || measuredAtMs <= 0) return null
  if (!Number.isFinite(scoreMs) || scoreMs <= 0) return null
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) return null

  return {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    contract: normalized.contract,
    cacheKey: normalized.cacheKey,
    hardwareConcurrency: normalized.hardwareConcurrency,
    totalJobs: normalized.totalJobs,
    jobBucket: normalized.jobBucket,
    rsK: normalized.rsK,
    rsM: normalized.rsM,
    backendKey: normalized.backendKey,
    schedulerKey: normalized.schedulerKey,
    selectedWorkerCount,
    staticWorkerCount,
    candidates,
    sampledCandidates: uniqueSorted(Array.isArray(obj.sampledCandidates) ? obj.sampledCandidates : []),
    measuredAtMs,
    scoreMs,
    sampleCount,
    reason: typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason : 'cached worker autotune result',
  }
}

export function isUsableExpansionWorkerAutotuneCache(
  cache: ExpansionWorkerAutotuneCache | null | undefined,
  shapeOrHardwareConcurrency?: ExpansionWorkerAutotuneShape | number,
  totalJobs?: number,
): cache is ExpansionWorkerAutotuneCache {
  if (!cache) return false
  const shape =
    typeof shapeOrHardwareConcurrency === 'object'
      ? shapeOrHardwareConcurrency
      : { hardwareConcurrency: shapeOrHardwareConcurrency, totalJobs }
  return normalizeExpansionWorkerAutotuneCache(cache, shape) !== null
}

export class ExpansionWorkerAutotuneCacheStore {
  private readonly entries = new Map<string, ExpansionWorkerAutotuneCache>()
  private readonly storage: ExpansionWorkerAutotuneStorage | null
  private readonly storagePrefix: string

  constructor(options: { storage?: ExpansionWorkerAutotuneStorage | null; storagePrefix?: string } = {}) {
    this.storage = options.storage === undefined ? resolveDefaultAutotuneStorage() : options.storage
    this.storagePrefix = options.storagePrefix ?? EXPANSION_WORKER_AUTOTUNE_STORAGE_PREFIX
  }

  get(shape: ExpansionWorkerAutotuneShape): ExpansionWorkerAutotuneCache | null {
    const normalized = normalizeExpansionWorkerAutotuneShape(shape)
    const memoryEntry = normalizeExpansionWorkerAutotuneCache(this.entries.get(normalized.cacheKey), shape)
    if (memoryEntry) return memoryEntry
    this.entries.delete(normalized.cacheKey)

    if (!this.storage) return null
    try {
      const raw = this.storage.getItem(`${this.storagePrefix}${normalized.cacheKey}`)
      if (!raw) return null
      const parsed = normalizeExpansionWorkerAutotuneCache(JSON.parse(raw), shape)
      if (!parsed) {
        this.storage.removeItem(`${this.storagePrefix}${normalized.cacheKey}`)
        return null
      }
      this.entries.set(normalized.cacheKey, parsed)
      return parsed
    } catch {
      return null
    }
  }

  set(shape: ExpansionWorkerAutotuneShape, cache: ExpansionWorkerAutotuneCache): void {
    const normalized = normalizeExpansionWorkerAutotuneCache(cache, shape)
    if (!normalized) throw new Error('invalid expansion worker autotune cache entry')
    this.entries.set(normalized.cacheKey, normalized)
    try {
      this.storage?.setItem(`${this.storagePrefix}${normalized.cacheKey}`, JSON.stringify(normalized))
    } catch {
      // Persistent storage is best-effort. The in-memory cache remains valid for this page session.
    }
  }

  invalidate(shape?: ExpansionWorkerAutotuneShape): void {
    if (shape) {
      const key = normalizeExpansionWorkerAutotuneShape(shape).cacheKey
      this.entries.delete(key)
      try {
        this.storage?.removeItem(`${this.storagePrefix}${key}`)
      } catch {
        // best effort
      }
      return
    }

    for (const key of this.entries.keys()) {
      try {
        this.storage?.removeItem(`${this.storagePrefix}${key}`)
      } catch {
        // best effort
      }
    }
    this.entries.clear()
  }
}

export const defaultExpansionWorkerAutotuneCacheStore = new ExpansionWorkerAutotuneCacheStore()

export function selectionFromExpansionWorkerAutotuneCache(
  cache: ExpansionWorkerAutotuneCache,
  shape: ExpansionWorkerAutotuneShape = {},
): ExpansionWorkerAutotuneSelection {
  const normalized = normalizeExpansionWorkerAutotuneShape(shape)
  return {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    contract: normalized.contract,
    workerCount: cache.selectedWorkerCount,
    selectedWorkerCount: cache.selectedWorkerCount,
    staticWorkerCount: cache.staticWorkerCount,
    candidates: cache.candidates,
    sampledCandidates: cache.sampledCandidates,
    source: 'cache-hit',
    cacheHit: true,
    cacheKey: cache.cacheKey,
    reason: cache.reason || 'cached worker autotune result',
    scoreMs: cache.scoreMs,
    measuredAtMs: cache.measuredAtMs,
    sampleCount: cache.sampleCount,
    hardwareConcurrency: normalized.hardwareConcurrency,
    totalJobs: normalized.totalJobs,
    rsK: normalized.rsK,
    rsM: normalized.rsM,
    jobBucket: normalized.jobBucket,
    backendKey: normalized.backendKey,
    schedulerKey: normalized.schedulerKey,
    timedOut: false,
    cacheWritable: false,
    samples: [],
  }
}

export function getCachedExpansionWorkerAutotuneSelection(
  shape: ExpansionWorkerAutotuneShape,
  cacheStore: ExpansionWorkerAutotuneCacheStore | null | undefined = defaultExpansionWorkerAutotuneCacheStore,
): ExpansionWorkerAutotuneSelection | null {
  const cache = cacheStore?.get(shape) ?? null
  return cache ? selectionFromExpansionWorkerAutotuneCache(cache, shape) : null
}

export function staticExpansionWorkerAutotuneSelection(
  shape: ExpansionWorkerAutotuneShape = {},
  source: ExpansionWorkerAutotuneSource = 'static-unavailable',
  reason = 'using static hardware-concurrency worker count',
): ExpansionWorkerAutotuneSelection {
  const normalized = normalizeExpansionWorkerAutotuneShape(shape)
  const staticWorkerCount = pickExpansionWorkerCount(normalized.hardwareConcurrency, normalized.totalJobs)
  return {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    contract: normalized.contract,
    workerCount: staticWorkerCount,
    selectedWorkerCount: staticWorkerCount,
    staticWorkerCount,
    candidates: buildExpansionWorkerAutotuneCandidates(normalized.hardwareConcurrency, normalized.totalJobs),
    sampledCandidates: [],
    source,
    cacheHit: false,
    cacheKey: normalized.cacheKey,
    reason,
    scoreMs: null,
    measuredAtMs: null,
    sampleCount: 0,
    hardwareConcurrency: normalized.hardwareConcurrency,
    totalJobs: normalized.totalJobs,
    rsK: normalized.rsK,
    rsM: normalized.rsM,
    jobBucket: normalized.jobBucket,
    backendKey: normalized.backendKey,
    schedulerKey: normalized.schedulerKey,
    timedOut: false,
    cacheWritable: false,
    samples: [],
  }
}

export function buildExpansionWorkerCalibrationPlan(
  shape: ExpansionWorkerAutotuneShape = {},
  options: {
    enabled?: boolean
    minJobs?: number
    maxSampleJobs?: number
    timeoutMs?: number
  } = {},
): ExpansionWorkerCalibrationPlan {
  const normalized = normalizeExpansionWorkerAutotuneShape(shape)
  const enabled = options.enabled !== false
  const minJobs = normalizePositiveInteger(options.minJobs, MIN_AUTOTUNE_USER_MDUS)
  const maxSampleJobs = normalizePositiveInteger(options.maxSampleJobs, MAX_AUTOTUNE_SAMPLE_USER_MDUS)
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_EXPANSION_WORKER_AUTOTUNE_TIMEOUT_MS)
  const staticWorkerCount = pickExpansionWorkerCount(normalized.hardwareConcurrency, normalized.totalJobs)
  const candidates = buildExpansionWorkerAutotuneCandidates(normalized.hardwareConcurrency, normalized.totalJobs)

  let source: ExpansionWorkerAutotuneSource = 'cache-miss'
  let reason = 'runtime calibration required: no valid cached worker count for this shape'
  let shouldCalibrate = true

  if (!enabled) {
    source = 'static-disabled'
    reason = 'worker autotune disabled; using static hardware-concurrency worker count'
    shouldCalibrate = false
  } else if (normalized.totalJobs < minJobs) {
    source = 'static-small-upload'
    reason = `small upload (${normalized.totalJobs} user MDUs < ${minJobs}); skipping worker calibration`
    shouldCalibrate = false
  } else if (candidates.length <= 1) {
    source = 'static-single-candidate'
    reason = 'only one safe worker-count candidate; using static hardware-concurrency worker count'
    shouldCalibrate = false
  }

  const sampleBatches: Array<{ workerCount: number; sampleJobs: number }> = []
  if (shouldCalibrate) {
    const lowerCandidates = candidates.filter((candidate) => candidate < staticWorkerCount).sort((a, b) => b - a)
    const higherCandidates = candidates.filter((candidate) => candidate > staticWorkerCount).sort((a, b) => a - b)
    const orderedCandidates = [
      ...lowerCandidates.slice(0, 1),
      staticWorkerCount,
      ...lowerCandidates.slice(1),
      ...higherCandidates,
    ].filter((candidate, index, values) => candidates.includes(candidate) && values.indexOf(candidate) === index)
    let remaining = Math.min(maxSampleJobs, normalized.totalJobs)
    for (const workerCount of orderedCandidates) {
      if (remaining <= 0) break
      const sampleJobs = Math.min(workerCount, remaining, normalized.totalJobs)
      if (workerCount > 1 && sampleJobs < workerCount) continue
      sampleBatches.push({ workerCount, sampleJobs })
      remaining -= sampleJobs
    }
    if (sampleBatches.length === 0) {
      source = 'static-unavailable'
      reason = 'calibration budget could not fit a valid worker-count sample; using static worker count'
      shouldCalibrate = false
    }
  }

  return {
    enabled,
    shouldCalibrate,
    source,
    reason,
    staticWorkerCount,
    candidates,
    sampleBatches,
    maxSampleJobs,
    minJobs,
    timeoutMs,
    cacheKey: normalized.cacheKey,
    hardwareConcurrency: normalized.hardwareConcurrency,
    totalJobs: normalized.totalJobs,
    rsK: normalized.rsK,
    rsM: normalized.rsM,
  }
}

function sampleScore(sample: ExpansionWorkerAutotuneSample): number {
  if (Number.isFinite(sample.scoreMs) && Number(sample.scoreMs) > 0) return Number(sample.scoreMs)
  const wallMs = Number(sample.wallMs)
  const sampleJobs = Number.isFinite(sample.sampleJobs) ? Math.max(1, Math.floor(Number(sample.sampleJobs))) : 1
  return wallMs / sampleJobs
}

export function selectExpansionWorkerCountFromSamples(
  samples: ExpansionWorkerAutotuneSample[],
  hardwareConcurrency?: number,
  totalJobs?: number,
): number {
  const candidates = buildExpansionWorkerAutotuneCandidates(hardwareConcurrency, totalJobs)
  const allowed = new Set(candidates)
  let bestWorkerCount = pickExpansionWorkerCount(hardwareConcurrency, totalJobs)
  let bestScore = Number.POSITIVE_INFINITY

  for (const sample of samples) {
    const workerCount = Math.floor(Number(sample.workerCount))
    const score = sampleScore(sample)
    if (!allowed.has(workerCount) || !Number.isFinite(score) || score <= 0) continue
    if (score < bestScore || (score === bestScore && workerCount < bestWorkerCount)) {
      bestScore = score
      bestWorkerCount = workerCount
    }
  }

  return bestWorkerCount
}

function cacheFromSelection(selection: ExpansionWorkerAutotuneSelection): ExpansionWorkerAutotuneCache {
  return {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    contract: selection.contract,
    cacheKey: selection.cacheKey,
    hardwareConcurrency: selection.hardwareConcurrency,
    totalJobs: selection.totalJobs,
    jobBucket: selection.jobBucket,
    rsK: selection.rsK,
    rsM: selection.rsM,
    backendKey: selection.backendKey,
    schedulerKey: selection.schedulerKey,
    selectedWorkerCount: selection.workerCount,
    staticWorkerCount: selection.staticWorkerCount,
    candidates: selection.candidates,
    sampledCandidates: selection.sampledCandidates,
    measuredAtMs: selection.measuredAtMs ?? Date.now(),
    scoreMs: selection.scoreMs ?? 1,
    sampleCount: selection.sampleCount,
    reason: selection.reason,
  }
}

export function finalizeExpansionWorkerAutotuneSelection(
  shape: ExpansionWorkerAutotuneShape,
  samples: ExpansionWorkerAutotuneSample[],
  options: {
    timedOut?: boolean
    error?: unknown
    calibrationComplete?: boolean
    nowMs?: number
    cacheStore?: ExpansionWorkerAutotuneCacheStore | null
  } = {},
): ExpansionWorkerAutotuneSelection {
  const normalized = normalizeExpansionWorkerAutotuneShape(shape)
  const staticWorkerCount = pickExpansionWorkerCount(normalized.hardwareConcurrency, normalized.totalJobs)
  const candidates = buildExpansionWorkerAutotuneCandidates(normalized.hardwareConcurrency, normalized.totalJobs)
  const allowed = new Set(candidates)
  const validSamples = samples.filter((sample) => {
    const workerCount = Math.floor(Number(sample.workerCount))
    const score = sampleScore(sample)
    return allowed.has(workerCount) && Number.isFinite(score) && score > 0
  })

  const base = staticExpansionWorkerAutotuneSelection(shape)
  const measuredAtMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()

  if (options.timedOut && validSamples.length === 0) {
    return {
      ...base,
      source: 'fallback-timeout',
      reason: 'worker calibration timed out before producing valid samples; using static hardware-concurrency worker count',
      timedOut: true,
      samples,
      sampledCandidates: [],
      sampleCount: 0,
    }
  }

  if (options.error) {
    const message = options.error instanceof Error ? options.error.message : String(options.error)
    return {
      ...base,
      source: 'fallback-error',
      reason: `worker calibration failed (${message}); using static hardware-concurrency worker count`,
      samples,
      sampledCandidates: uniqueSorted(validSamples.map((sample) => sample.workerCount)),
      sampleCount: validSamples.length,
    }
  }

  if (validSamples.length === 0) {
    return {
      ...base,
      source: 'fallback-no-samples',
      reason: 'worker calibration produced no valid samples; using static hardware-concurrency worker count',
      samples,
    }
  }

  let bestSample = validSamples[0]
  let bestScore = sampleScore(bestSample)
  for (const sample of validSamples.slice(1)) {
    const score = sampleScore(sample)
    const workerCount = Math.floor(Number(sample.workerCount))
    const bestWorkerCount = Math.floor(Number(bestSample.workerCount))
    if (score < bestScore || (score === bestScore && workerCount < bestWorkerCount)) {
      bestSample = sample
      bestScore = score
    }
  }

  const workerCount = Math.floor(Number(bestSample.workerCount))
  const calibrationComplete = options.calibrationComplete !== false && !options.timedOut
  const selection: ExpansionWorkerAutotuneSelection = {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    contract: normalized.contract,
    workerCount,
    selectedWorkerCount: workerCount,
    staticWorkerCount,
    candidates,
    sampledCandidates: uniqueSorted(validSamples.map((sample) => sample.workerCount)),
    source: 'calibrated',
    cacheHit: false,
    cacheKey: normalized.cacheKey,
    reason: calibrationComplete
      ? `selected ${workerCount} upload-prep workers from runtime calibration (${bestScore.toFixed(2)} ms/user MDU)`
      : options.timedOut
        ? `selected ${workerCount} upload-prep workers from partial timed-out runtime calibration (${bestScore.toFixed(2)} ms/user MDU); result not cached`
        : `selected ${workerCount} upload-prep workers from incomplete runtime calibration (${bestScore.toFixed(2)} ms/user MDU); result not cached`,
    scoreMs: bestScore,
    measuredAtMs,
    sampleCount: validSamples.length,
    hardwareConcurrency: normalized.hardwareConcurrency,
    totalJobs: normalized.totalJobs,
    rsK: normalized.rsK,
    rsM: normalized.rsM,
    jobBucket: normalized.jobBucket,
    backendKey: normalized.backendKey,
    schedulerKey: normalized.schedulerKey,
    timedOut: Boolean(options.timedOut),
    cacheWritable: calibrationComplete,
    samples,
  }

  if (selection.cacheWritable) {
    options.cacheStore?.set(shape, cacheFromSelection(selection))
  }

  return selection
}
