export const DEFAULT_EXPANSION_HARDWARE_CONCURRENCY = 4
const MAX_EXPANSION_WORKERS = 6
export const EXPANSION_WORKER_AUTOTUNE_VERSION = 1
export const MAX_AUTOTUNE_EXPANSION_WORKERS = 8

export type ExpansionWorkerAutotuneCache = {
  version: number
  hardwareConcurrency: number
  selectedWorkerCount: number
  measuredAtMs: number
  scoreMs: number
}

export type ExpansionWorkerAutotuneSample = {
  workerCount: number
  wallMs: number
}

export function pickExpansionWorkerCount(hardwareConcurrency?: number, totalJobs?: number): number {
  const hc = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(Number(hardwareConcurrency)))
    : DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
  const jobCap = Number.isFinite(totalJobs) ? Math.max(1, Math.floor(Number(totalJobs))) : Number.POSITIVE_INFINITY

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
  const jobCap = Number.isFinite(totalJobs) ? Math.max(1, Math.floor(Number(totalJobs))) : Number.POSITIVE_INFINITY
  if (jobCap < 4 || staticCount <= 1) return [staticCount]

  const hc = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(Number(hardwareConcurrency)))
    : DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
  const upper = Math.max(staticCount, Math.min(MAX_AUTOTUNE_EXPANSION_WORKERS, jobCap, hc))
  const lower = Math.max(1, staticCount - 2)
  const preferred = [staticCount - 1, staticCount, staticCount + 1, staticCount + 2]

  const candidates = new Set<number>()
  for (const candidate of preferred) {
    const normalized = Math.floor(candidate)
    if (normalized >= lower && normalized <= upper) candidates.add(normalized)
  }
  candidates.add(staticCount)

  return [...candidates].sort((a, b) => a - b)
}

export function isUsableExpansionWorkerAutotuneCache(
  cache: ExpansionWorkerAutotuneCache | null | undefined,
  hardwareConcurrency?: number,
  totalJobs?: number,
): cache is ExpansionWorkerAutotuneCache {
  if (!cache || cache.version !== EXPANSION_WORKER_AUTOTUNE_VERSION) return false
  const hc = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(Number(hardwareConcurrency)))
    : DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
  if (cache.hardwareConcurrency !== hc) return false
  if (!Number.isInteger(cache.selectedWorkerCount) || cache.selectedWorkerCount < 1) return false
  if (!Number.isFinite(cache.measuredAtMs) || cache.measuredAtMs <= 0) return false
  if (!Number.isFinite(cache.scoreMs) || cache.scoreMs <= 0) return false
  const candidates = buildExpansionWorkerAutotuneCandidates(hardwareConcurrency, totalJobs)
  return candidates.includes(cache.selectedWorkerCount)
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
    const wallMs = Number(sample.wallMs)
    if (!allowed.has(workerCount) || !Number.isFinite(wallMs) || wallMs <= 0) continue
    if (wallMs < bestScore || (wallMs === bestScore && workerCount < bestWorkerCount)) {
      bestScore = wallMs
      bestWorkerCount = workerCount
    }
  }

  return bestWorkerCount
}
