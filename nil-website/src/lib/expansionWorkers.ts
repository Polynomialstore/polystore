export const DEFAULT_EXPANSION_HARDWARE_CONCURRENCY = 4
const MAX_EXPANSION_WORKERS = 5

export function pickExpansionWorkerCount(hardwareConcurrency?: number, totalJobs?: number): number {
  const hc = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(Number(hardwareConcurrency)))
    : DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
  const jobCap = Number.isFinite(totalJobs) ? Math.max(1, Math.floor(Number(totalJobs))) : Number.POSITIVE_INFINITY

  let desired = 1
  if (hc >= 10) desired = MAX_EXPANSION_WORKERS
  else if (hc >= 6) desired = 4
  else if (hc >= 4) desired = 3
  else if (hc >= 3) desired = 2

  return Math.max(1, Math.min(desired, jobCap))
}
