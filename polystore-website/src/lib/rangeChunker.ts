const NILFS_SCALAR_BYTES = 32
const NILFS_SCALAR_PAYLOAD_BYTES = 31

export interface FileRangeChunk {
  rangeStart: number
  rangeLen: number
}

export function rawMduCapacityFromMduSize(mduSizeBytes: number): number {
  if (!Number.isFinite(mduSizeBytes) || mduSizeBytes <= 0) return 0
  const scalars = Math.floor(mduSizeBytes / NILFS_SCALAR_BYTES)
  return scalars * NILFS_SCALAR_PAYLOAD_BYTES
}

function encodedPosFromRawOffset(rawOffsetInMdu: number): number {
  const scalarIdx = Math.floor(rawOffsetInMdu / NILFS_SCALAR_PAYLOAD_BYTES)
  return rawOffsetInMdu + scalarIdx + 1
}

export function rawOffsetToEncodedBlobIndex(rawOffsetInMdu: number, blobSizeBytes: number): number {
  if (blobSizeBytes <= 0) throw new Error('invalid blobSizeBytes')
  if (rawOffsetInMdu < 0) throw new Error('rawOffsetInMdu must be >= 0')
  return Math.floor(encodedPosFromRawOffset(rawOffsetInMdu) / blobSizeBytes)
}

function nextBlobBoundaryRawOffsetInMdu(rawOffsetInMdu: number, rawMduCapacity: number, blobSizeBytes: number): number {
  const start = rawOffsetInMdu
  if (start >= rawMduCapacity) return rawMduCapacity
  const blobIdx = rawOffsetToEncodedBlobIndex(start, blobSizeBytes)

  // Find the first raw offset where the blob index changes (monotone in rawOffset).
  let lo = start
  let hi = rawMduCapacity
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const midBlob = rawOffsetToEncodedBlobIndex(mid, blobSizeBytes)
    if (midBlob === blobIdx) lo = mid
    else hi = mid
  }
  if (rawOffsetToEncodedBlobIndex(hi, blobSizeBytes) === blobIdx) return rawMduCapacity
  return hi
}

export function planNilfsFileRangeChunks(opts: {
  fileStartOffset: number
  fileSizeBytes: number
  rangeStart: number
  rangeLen: number
  mduSizeBytes: number
  blobSizeBytes: number
}): FileRangeChunk[] {
  const { fileStartOffset, fileSizeBytes, rangeStart, rangeLen, mduSizeBytes, blobSizeBytes } = opts

  if (!Number.isFinite(fileStartOffset) || fileStartOffset < 0) throw new Error('fileStartOffset must be >= 0')
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) throw new Error('fileSizeBytes must be > 0')
  if (!Number.isFinite(rangeStart) || rangeStart < 0) throw new Error('rangeStart must be >= 0')
  if (!Number.isFinite(rangeLen) || rangeLen <= 0) throw new Error('rangeLen must be > 0')
  if (rangeStart >= fileSizeBytes) throw new Error('rangeStart beyond EOF')

  const rawMduCapacity = rawMduCapacityFromMduSize(mduSizeBytes)
  if (rawMduCapacity <= 0) throw new Error('invalid mduSizeBytes')

  const maxLen = Math.min(rangeLen, fileSizeBytes - rangeStart)
  let remaining = maxLen
  let cursor = rangeStart
  const chunks: FileRangeChunk[] = []

  while (remaining > 0) {
    const absOffset = fileStartOffset + cursor
    const offsetInMdu = absOffset % rawMduCapacity
    const mduRemaining = rawMduCapacity - offsetInMdu
    const blobBoundary = nextBlobBoundaryRawOffsetInMdu(offsetInMdu, rawMduCapacity, blobSizeBytes)
    const blobRemaining = blobBoundary - offsetInMdu
    const chunkLen = Math.min(remaining, mduRemaining, blobRemaining, blobSizeBytes)
    if (chunkLen <= 0) throw new Error('failed to derive a positive chunk length')

    chunks.push({ rangeStart: cursor, rangeLen: chunkLen })
    cursor += chunkLen
    remaining -= chunkLen
  }

  return chunks
}

