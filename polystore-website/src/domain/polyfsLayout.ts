export const BLOB_SIZE_BYTES = 128 * 1024
export const BLOBS_PER_MDU = 64
export const MDU_SIZE_BYTES = BLOB_SIZE_BYTES * BLOBS_PER_MDU
export const KZG_COMMITMENT_BYTES = 48

export const POLYFS_SCALAR_BYTES = 32
export const POLYFS_SCALAR_PAYLOAD_BYTES = 31
export const POLYFS_SCALARS_PER_MDU = Math.floor(MDU_SIZE_BYTES / POLYFS_SCALAR_BYTES)
export const RAW_MDU_CAPACITY_BYTES = POLYFS_SCALARS_PER_MDU * POLYFS_SCALAR_PAYLOAD_BYTES

export const POLYFS_ROOT_TABLE_BLOBS = 16
export const POLYFS_FILE_TABLE_BLOBS = BLOBS_PER_MDU - POLYFS_ROOT_TABLE_BLOBS
export const POLYFS_ROOT_SIZE_BYTES = 32
export const POLYFS_FILE_TABLE_HEADER_BYTES = 128
export const POLYFS_FILE_RECORD_BYTES = 256
export const POLYFS_RECORD_PATH_BYTES = POLYFS_FILE_RECORD_BYTES - 24
export const POLYFS_FILE_TABLE_START_BLOB = POLYFS_ROOT_TABLE_BLOBS
export const POLYFS_FILE_TABLE_END_BLOB = BLOBS_PER_MDU - 1

export const POLYFS_ROOT_TABLE_CAPACITY =
  (POLYFS_ROOT_TABLE_BLOBS * BLOB_SIZE_BYTES) / POLYFS_ROOT_SIZE_BYTES
export const POLYFS_FILE_RECORD_CAPACITY = Math.floor(
  (POLYFS_FILE_TABLE_BLOBS * BLOB_SIZE_BYTES - POLYFS_FILE_TABLE_HEADER_BYTES) /
    POLYFS_FILE_RECORD_BYTES,
)

export interface PolyfsRangeInput {
  witnessMdus: number
  startOffsetBytes: number
  sizeBytes: number
  rawMduCapacityBytes?: number
}

export interface PolyfsResolvedRange {
  metaMdus: number
  userMduStart: number
  userMduEnd: number
  slabMduStart: number
  slabMduEnd: number
  rawOffsetInFirstMdu: number
  rawOffsetInLastMdu: number
  encodedBlobStart: number
  encodedBlobEnd: number
  globalBlobStart: bigint
  globalBlobEnd: bigint
}

export interface StripeProfile {
  k: number
  m: number
  n: number
  rows: number
  leafCount: number
}

export interface WitnessLayout {
  profile: StripeProfile
  witnessBytesPerUserMdu: number
  totalWitnessBytes: number
  witnessMduCount: number
  rawMduCapacityBytes: number
}

export function asNonNegativeInteger(value: number, label: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative finite number`)
  }
  return Math.floor(n)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-"
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  const precision = idx === 0 ? 0 : idx >= 3 ? 2 : 1
  return `${value.toFixed(precision)} ${units[idx]}`
}

export function computeUserMduCount(
  sizeBytes: number,
  rawMduCapacityBytes = RAW_MDU_CAPACITY_BYTES,
): number {
  const size = asNonNegativeInteger(sizeBytes, 'sizeBytes')
  const capacity = asNonNegativeInteger(rawMduCapacityBytes, 'rawMduCapacityBytes')
  if (size === 0) return 0
  if (capacity <= 0) throw new Error('rawMduCapacityBytes must be positive')
  return Math.ceil(size / capacity)
}

export function rawOffsetToEncodedPosition(rawOffsetInMdu: number): {
  scalarIndex: number
  payloadOffset: number
  encodedByteOffset: number
  encodedBlobIndex: number
} {
  const rawOffset = asNonNegativeInteger(rawOffsetInMdu, 'rawOffsetInMdu')
  if (rawOffset >= RAW_MDU_CAPACITY_BYTES) {
    throw new Error(`rawOffsetInMdu must be < ${RAW_MDU_CAPACITY_BYTES}`)
  }
  const scalarIndex = Math.floor(rawOffset / POLYFS_SCALAR_PAYLOAD_BYTES)
  const payloadOffset = rawOffset % POLYFS_SCALAR_PAYLOAD_BYTES
  const encodedByteOffset = scalarIndex * POLYFS_SCALAR_BYTES + 1 + payloadOffset
  const encodedBlobIndex = Math.floor(encodedByteOffset / BLOB_SIZE_BYTES)
  return { scalarIndex, payloadOffset, encodedByteOffset, encodedBlobIndex }
}

export function computePolyfsResolvedRange(input: PolyfsRangeInput): PolyfsResolvedRange | null {
  const witnessMdus = asNonNegativeInteger(input.witnessMdus, 'witnessMdus')
  const startOffset = asNonNegativeInteger(input.startOffsetBytes, 'startOffsetBytes')
  const sizeBytes = asNonNegativeInteger(input.sizeBytes, 'sizeBytes')
  const rawMduCapacityBytes = asNonNegativeInteger(
    input.rawMduCapacityBytes ?? RAW_MDU_CAPACITY_BYTES,
    'rawMduCapacityBytes',
  )
  if (rawMduCapacityBytes <= 0) throw new Error('rawMduCapacityBytes must be positive')
  if (sizeBytes === 0) return null

  const metaMdus = 1 + witnessMdus
  const endOffset = startOffset + sizeBytes - 1
  const userMduStart = Math.floor(startOffset / rawMduCapacityBytes)
  const userMduEnd = Math.floor(endOffset / rawMduCapacityBytes)
  const slabMduStart = metaMdus + userMduStart
  const slabMduEnd = metaMdus + userMduEnd
  const rawOffsetInFirstMdu = startOffset % rawMduCapacityBytes
  const rawOffsetInLastMdu = endOffset % rawMduCapacityBytes
  const encodedBlobStart = rawOffsetToEncodedPosition(rawOffsetInFirstMdu).encodedBlobIndex
  const encodedBlobEnd = rawOffsetToEncodedPosition(rawOffsetInLastMdu).encodedBlobIndex
  const globalBlobStart = BigInt(slabMduStart) * BigInt(BLOBS_PER_MDU) + BigInt(encodedBlobStart)
  const globalBlobEnd = BigInt(slabMduEnd) * BigInt(BLOBS_PER_MDU) + BigInt(encodedBlobEnd)

  return {
    metaMdus,
    userMduStart,
    userMduEnd,
    slabMduStart,
    slabMduEnd,
    rawOffsetInFirstMdu,
    rawOffsetInLastMdu,
    encodedBlobStart,
    encodedBlobEnd,
    globalBlobStart,
    globalBlobEnd,
  }
}

export function computeStripeProfile(k: number, m: number): StripeProfile {
  const safeK = asNonNegativeInteger(k, 'k')
  const safeM = asNonNegativeInteger(m, 'm')
  if (safeK <= 0) throw new Error('k must be positive')
  if (BLOBS_PER_MDU % safeK !== 0) {
    throw new Error(`k must divide ${BLOBS_PER_MDU}`)
  }
  const n = safeK + safeM
  const rows = BLOBS_PER_MDU / safeK
  return {
    k: safeK,
    m: safeM,
    n,
    rows,
    leafCount: n * rows,
  }
}

export function leafIndexForSlotRow(profile: StripeProfile, slot: number, row: number): number {
  const safeSlot = asNonNegativeInteger(slot, 'slot')
  const safeRow = asNonNegativeInteger(row, 'row')
  if (safeSlot >= profile.n) throw new Error(`slot must be < ${profile.n}`)
  if (safeRow >= profile.rows) throw new Error(`row must be < ${profile.rows}`)
  return safeSlot * profile.rows + safeRow
}

export function slotRowForLeafIndex(profile: StripeProfile, leafIndex: number): {
  slot: number
  row: number
} {
  const safeLeaf = asNonNegativeInteger(leafIndex, 'leafIndex')
  if (safeLeaf >= profile.leafCount) throw new Error(`leafIndex must be < ${profile.leafCount}`)
  return {
    slot: Math.floor(safeLeaf / profile.rows),
    row: safeLeaf % profile.rows,
  }
}

export function computeWitnessLayout(input: {
  totalUserMdus: number
  k: number
  m: number
  rawMduCapacityBytes?: number
}): WitnessLayout {
  const totalUserMdus = asNonNegativeInteger(input.totalUserMdus, 'totalUserMdus')
  const rawMduCapacityBytes = asNonNegativeInteger(
    input.rawMduCapacityBytes ?? RAW_MDU_CAPACITY_BYTES,
    'rawMduCapacityBytes',
  )
  if (rawMduCapacityBytes <= 0) throw new Error('rawMduCapacityBytes must be positive')
  const profile = computeStripeProfile(input.k, input.m)
  const witnessBytesPerUserMdu = profile.leafCount * KZG_COMMITMENT_BYTES
  const totalWitnessBytes = totalUserMdus * witnessBytesPerUserMdu
  const witnessMduCount = Math.max(1, Math.ceil(totalWitnessBytes / rawMduCapacityBytes))
  return {
    profile,
    witnessBytesPerUserMdu,
    totalWitnessBytes,
    witnessMduCount,
    rawMduCapacityBytes,
  }
}

export function packLengthAndFlags(length: number, flags: number): bigint {
  const safeLength = BigInt(asNonNegativeInteger(length, 'length')) & 0x00ff_ffff_ffff_ffffn
  const safeFlags = BigInt(asNonNegativeInteger(flags, 'flags') & 0xff)
  return (safeFlags << 56n) | safeLength
}

export function unpackLengthAndFlags(value: bigint): { length: number; flags: number } {
  return {
    length: Number(value & 0x00ff_ffff_ffff_ffffn),
    flags: Number((value >> 56n) & 0xffn),
  }
}
