import type { PolyfsFileEntry } from '../domain/polyfs'

export const MDU_SIZE_BYTES = 8 * 1024 * 1024
export const BLOB_SIZE_BYTES = 128 * 1024
const FILE_TABLE_START = 16 * BLOB_SIZE_BYTES
const ROOT_TABLE_END = FILE_TABLE_START
const FILE_TABLE_HEADER_SIZE = 128
const FILE_RECORD_SIZE = 256

function unpackLengthAndFlags(lengthAndFlags: bigint): { length: number; flags: number } {
  const length = Number(lengthAndFlags & 0x00ff_ffff_ffff_ffffn)
  const flags = Number((lengthAndFlags >> 56n) & 0xffn)
  return { length, flags }
}

function parseNullTerminatedUtf8(bytes: Uint8Array): string {
  const idx = bytes.indexOf(0)
  const slice = idx >= 0 ? bytes.slice(0, idx) : bytes
  return new TextDecoder().decode(slice)
}

export function parsePolyfsFilesFromMdu0(mdu0: Uint8Array): PolyfsFileEntry[] {
  if (mdu0.length !== MDU_SIZE_BYTES) return []

  const view = new DataView(mdu0.buffer, mdu0.byteOffset, mdu0.byteLength)
  const magicOffset = FILE_TABLE_START
  const magic = parseNullTerminatedUtf8(mdu0.slice(magicOffset, magicOffset + 4))
  if (magic !== 'NILF') return []
  const recordSize = view.getUint16(magicOffset + 6, true)
  if (recordSize !== FILE_RECORD_SIZE) return []

  const recordCount = view.getUint32(magicOffset + 8, true)
  const recordsOffset = magicOffset + FILE_TABLE_HEADER_SIZE

  const files: PolyfsFileEntry[] = []
  for (let i = 0; i < recordCount; i++) {
    const off = recordsOffset + i * FILE_RECORD_SIZE
    if (off + FILE_RECORD_SIZE > mdu0.length) break

    const startOffset = Number(view.getBigUint64(off, true))
    const lengthAndFlags = view.getBigUint64(off + 8, true)
    const { length, flags } = unpackLengthAndFlags(lengthAndFlags)
    const pathBytes = mdu0.slice(off + 24, off + FILE_RECORD_SIZE)
    const path = parseNullTerminatedUtf8(pathBytes).trim()

    if (!path) continue // tombstone
    if (!Number.isFinite(length) || length <= 0) continue

    files.push({
      path,
      size_bytes: length,
      start_offset: startOffset,
      flags,
    })
  }

  return files
}

export function parsePolyfsRootTableFromMdu0(mdu0: Uint8Array): Uint8Array[] {
  if (mdu0.length !== MDU_SIZE_BYTES) return []

  const roots: Uint8Array[] = []
  for (let off = 0; off + 32 <= ROOT_TABLE_END; off += 32) {
    const chunk = mdu0.slice(off, off + 32)
    let allZero = true
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 0) {
        allZero = false
        break
      }
    }
    if (!allZero) roots.push(chunk)
  }
  return roots
}

export function mode2RowsForK(k: number): number {
  const normalized = Math.max(1, Math.floor(Number(k) || 0))
  if (64 % normalized !== 0) {
    throw new Error(`invalid Mode 2 K: ${k}`)
  }
  return 64 / normalized
}

export function reconstructMduFromMode2SlotSlices(
  slotSlices: ReadonlyArray<{ slot: number; data: Uint8Array }>,
  k: number,
): Uint8Array {
  const rows = mode2RowsForK(k)
  const expectedSliceBytes = rows * BLOB_SIZE_BYTES
  const bySlot = new Map<number, Uint8Array>()
  for (const slice of slotSlices) {
    const slot = Math.max(0, Math.floor(Number(slice.slot) || 0))
    if (slot >= k) continue
    if (!(slice.data instanceof Uint8Array) || slice.data.byteLength !== expectedSliceBytes) {
      throw new Error(`invalid Mode 2 slot slice for slot ${slot}: expected ${expectedSliceBytes} bytes`)
    }
    bySlot.set(slot, slice.data)
  }
  for (let slot = 0; slot < k; slot += 1) {
    if (!bySlot.has(slot)) {
      throw new Error(`missing Mode 2 slot slice for slot ${slot}`)
    }
  }

  const mdu = new Uint8Array(MDU_SIZE_BYTES)
  for (let row = 0; row < rows; row += 1) {
    for (let slot = 0; slot < k; slot += 1) {
      const shard = bySlot.get(slot)!
      const shardOff = row * BLOB_SIZE_BYTES
      const blobIndex = row * k + slot
      const mduOff = blobIndex * BLOB_SIZE_BYTES
      mdu.set(shard.subarray(shardOff, shardOff + BLOB_SIZE_BYTES), mduOff)
    }
  }
  return mdu
}
