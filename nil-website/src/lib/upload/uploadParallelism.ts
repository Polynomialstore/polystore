import type { UploadEngineParallelism } from './engine'

export const DEFAULT_UPLOAD_PARALLELISM: UploadEngineParallelism = {
  direct: 4,
  stripedMetadata: 6,
  stripedShards: 6,
}

export function pickUploadParallelism(hardwareConcurrency?: number): UploadEngineParallelism {
  if (!Number.isFinite(hardwareConcurrency)) {
    return DEFAULT_UPLOAD_PARALLELISM
  }

  const hc = Math.max(1, Math.floor(Number(hardwareConcurrency)))

  if (hc >= 12) {
    return {
      direct: 6,
      stripedMetadata: 8,
      stripedShards: 8,
    }
  }

  if (hc >= 10) {
    return {
      direct: 6,
      stripedMetadata: 7,
      stripedShards: 7,
    }
  }

  if (hc >= 8) {
    return {
      direct: 5,
      stripedMetadata: 7,
      stripedShards: 7,
    }
  }

  if (hc >= 6) {
    return DEFAULT_UPLOAD_PARALLELISM
  }

  if (hc >= 4) {
    return {
      direct: 3,
      stripedMetadata: 4,
      stripedShards: 4,
    }
  }

  if (hc >= 3) {
    return {
      direct: 2,
      stripedMetadata: 3,
      stripedShards: 3,
    }
  }

  return {
    direct: 1,
    stripedMetadata: 2,
    stripedShards: 2,
  }
}
