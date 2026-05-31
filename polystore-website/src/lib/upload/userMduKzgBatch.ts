import { KZG_BLOB_SIZE, KZG_COMMITMENT_SIZE } from '../kzgCommitBackend'
import type { UserMduUncommittedExpansion } from './userMduBrowserKzg'

export type UserMduKzgBatchConstraints = {
  maxBatchMdus?: number
  maxBatchBlobs?: number
  maxBatchBytes?: number
  maxEstimatedMemoryBytes?: number
}

export type NormalizedUserMduKzgBatchConstraints = Required<UserMduKzgBatchConstraints>

export type UserMduKzgExpansionShape = {
  k: number
  m: number
  shardLen: number
  shardCount: number
  blobCount: number
  byteLength: number
}

export type UserMduKzgBatchPlan = {
  count: number
  blobs: number
  bytes: number
  estimatedMemoryBytes: number
  reason: 'empty' | 'planned' | 'max_batch_mdus' | 'max_blobs' | 'max_bytes' | 'max_estimated_memory' | 'incompatible_shape'
  shape: UserMduKzgExpansionShape | null
}

export type UserMduKzgDemuxInput = Pick<UserMduUncommittedExpansion, 'shardsFlat' | 'shardLen'>

const DEFAULT_MAX_BATCH_MDUS = 4
const DEFAULT_MAX_BATCH_BLOBS = 384
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_ESTIMATED_MEMORY_BYTES = 128 * 1024 * 1024

export const DEFAULT_USER_MDU_KZG_BATCH_CONSTRAINTS: NormalizedUserMduKzgBatchConstraints = {
  maxBatchMdus: DEFAULT_MAX_BATCH_MDUS,
  maxBatchBlobs: DEFAULT_MAX_BATCH_BLOBS,
  maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
  maxEstimatedMemoryBytes: DEFAULT_MAX_ESTIMATED_MEMORY_BYTES,
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value ?? fallback))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function normalizeUserMduKzgBatchConstraints(
  constraints: UserMduKzgBatchConstraints = {},
): NormalizedUserMduKzgBatchConstraints {
  return {
    maxBatchMdus: positiveInteger(constraints.maxBatchMdus, DEFAULT_MAX_BATCH_MDUS),
    maxBatchBlobs: positiveInteger(constraints.maxBatchBlobs, DEFAULT_MAX_BATCH_BLOBS),
    maxBatchBytes: positiveInteger(constraints.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES),
    maxEstimatedMemoryBytes: positiveInteger(
      constraints.maxEstimatedMemoryBytes,
      DEFAULT_MAX_ESTIMATED_MEMORY_BYTES,
    ),
  }
}

function assertUint8Array(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be a Uint8Array`)
}

export function describeUserMduKzgExpansionShape(expansion: UserMduKzgDemuxInput & Partial<UserMduUncommittedExpansion>): UserMduKzgExpansionShape {
  assertUint8Array(expansion.shardsFlat, 'shardsFlat')
  const shardLen = Math.floor(Number(expansion.shardLen))
  if (!Number.isFinite(shardLen) || shardLen <= 0) throw new Error('shardLen must be a positive integer')
  if (expansion.shardsFlat.byteLength === 0) throw new Error('shardsFlat must not be empty')
  if (expansion.shardsFlat.byteLength % shardLen !== 0) {
    throw new Error('shardsFlat length must be a multiple of shardLen')
  }
  if (expansion.shardsFlat.byteLength % KZG_BLOB_SIZE !== 0) {
    throw new Error('shardsFlat length must be a multiple of the KZG blob size')
  }
  const shardCount = expansion.shardsFlat.byteLength / shardLen
  const blobCount = expansion.shardsFlat.byteLength / KZG_BLOB_SIZE
  const k = Number(expansion.k ?? 0)
  const m = Number(expansion.m ?? 0)
  if ((k || m) && shardCount !== k + m) {
    throw new Error(`shard count ${shardCount} does not match RS profile ${k}+${m}`)
  }
  return {
    k,
    m,
    shardLen,
    shardCount,
    blobCount,
    byteLength: expansion.shardsFlat.byteLength,
  }
}

export function areUserMduKzgShapesCompatible(
  left: UserMduKzgExpansionShape,
  right: UserMduKzgExpansionShape,
): boolean {
  return left.k === right.k && left.m === right.m && left.shardLen === right.shardLen && left.shardCount === right.shardCount
}

export function validateHomogeneousUserMduKzgBatch(
  expansions: Array<UserMduKzgDemuxInput & Partial<UserMduUncommittedExpansion>>,
): UserMduKzgExpansionShape {
  if (expansions.length === 0) throw new Error('KZG batch must contain at least one user MDU')
  const first = describeUserMduKzgExpansionShape(expansions[0])
  for (let i = 1; i < expansions.length; i += 1) {
    const current = describeUserMduKzgExpansionShape(expansions[i])
    if (!areUserMduKzgShapesCompatible(first, current)) {
      throw new Error(
        `incompatible user MDU shard shape at index ${i}: expected k=${first.k}, m=${first.m}, shardLen=${first.shardLen}, shardCount=${first.shardCount}; got k=${current.k}, m=${current.m}, shardLen=${current.shardLen}, shardCount=${current.shardCount}`,
      )
    }
  }
  return first
}

export function estimateUserMduKzgBatchMemoryBytes(bytes: number, blobs: number): number {
  // During a browser-owner KZG call the worker keeps the per-MDU shard views,
  // builds one concatenated blob buffer, and receives one 48-byte commitment per
  // blob. This estimate intentionally excludes backend/GPU private memory and is
  // used only as a deterministic guardrail before attempting a batch.
  return bytes * 2 + blobs * KZG_COMMITMENT_SIZE
}

export function planUserMduKzgBatch(
  candidates: Array<UserMduKzgDemuxInput & Partial<UserMduUncommittedExpansion>>,
  constraints: UserMduKzgBatchConstraints = {},
): UserMduKzgBatchPlan {
  const normalized = normalizeUserMduKzgBatchConstraints(constraints)
  if (candidates.length === 0) {
    return { count: 0, blobs: 0, bytes: 0, estimatedMemoryBytes: 0, reason: 'empty', shape: null }
  }

  let count = 0
  let blobs = 0
  let bytes = 0
  let shape: UserMduKzgExpansionShape | null = null
  let reason: UserMduKzgBatchPlan['reason'] = 'planned'

  for (const candidate of candidates) {
    const current = describeUserMduKzgExpansionShape(candidate)
    if (shape && !areUserMduKzgShapesCompatible(shape, current)) {
      reason = 'incompatible_shape'
      break
    }
    const nextCount = count + 1
    const nextBlobs = blobs + current.blobCount
    const nextBytes = bytes + current.byteLength
    const nextEstimated = estimateUserMduKzgBatchMemoryBytes(nextBytes, nextBlobs)
    if (nextCount > normalized.maxBatchMdus) {
      reason = 'max_batch_mdus'
      break
    }
    if (nextBlobs > normalized.maxBatchBlobs) {
      reason = 'max_blobs'
      break
    }
    if (nextBytes > normalized.maxBatchBytes) {
      reason = 'max_bytes'
      break
    }
    if (nextEstimated > normalized.maxEstimatedMemoryBytes) {
      reason = 'max_estimated_memory'
      break
    }
    shape = shape ?? current
    count = nextCount
    blobs = nextBlobs
    bytes = nextBytes
  }

  return {
    count,
    blobs,
    bytes,
    estimatedMemoryBytes: estimateUserMduKzgBatchMemoryBytes(bytes, blobs),
    reason,
    shape,
  }
}

export function concatenateUserMduKzgBatch(
  expansions: Array<UserMduKzgDemuxInput & Partial<UserMduUncommittedExpansion>>,
): Uint8Array {
  validateHomogeneousUserMduKzgBatch(expansions)
  const totalBytes = expansions.reduce((sum, expansion) => sum + expansion.shardsFlat.byteLength, 0)
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const expansion of expansions) {
    out.set(expansion.shardsFlat, offset)
    offset += expansion.shardsFlat.byteLength
  }
  return out
}

export function demuxUserMduKzgCommitments(
  witnessFlat: Uint8Array,
  expansions: Array<UserMduKzgDemuxInput & Partial<UserMduUncommittedExpansion>>,
): Uint8Array[] {
  assertUint8Array(witnessFlat, 'witnessFlat')
  validateHomogeneousUserMduKzgBatch(expansions)
  const expectedBytes = expansions.reduce(
    (sum, expansion) => sum + (expansion.shardsFlat.byteLength / KZG_BLOB_SIZE) * KZG_COMMITMENT_SIZE,
    0,
  )
  if (witnessFlat.byteLength !== expectedBytes) {
    throw new Error(`KZG batch returned ${witnessFlat.byteLength} witness bytes, expected ${expectedBytes}`)
  }

  const groups: Uint8Array[] = []
  let offset = 0
  for (const expansion of expansions) {
    const bytes = (expansion.shardsFlat.byteLength / KZG_BLOB_SIZE) * KZG_COMMITMENT_SIZE
    groups.push(witnessFlat.slice(offset, offset + bytes))
    offset += bytes
  }
  return groups
}

export function splitUserMduKzgBatch(count: number): [number, number] {
  const normalized = Math.floor(Number(count))
  if (!Number.isFinite(normalized) || normalized <= 1) return [normalized, 0]
  const left = Math.ceil(normalized / 2)
  return [left, normalized - left]
}
