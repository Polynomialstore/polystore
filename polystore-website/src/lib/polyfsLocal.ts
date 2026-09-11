import type { PolyfsFileEntry } from '../domain/polyfs'
import {
  asNonNegativeInteger, POLYFS_FAT_LOGICAL_BYTES, POLYFS_FILE_RECORD_CAPACITY,
  POLYFS_ROOT_TABLE_CAPACITY
} from '../domain/polyfsLayout'
import { validatePolyfsRecordPath } from './polyfsPath'

export const MDU_SIZE_BYTES = 8 * 1024 * 1024
export const BLOB_SIZE_BYTES = 128 * 1024
const FILE_TABLE_START = 16 * BLOB_SIZE_BYTES
const FILE_TABLE_HEADER_SIZE = 128
const FILE_RECORD_SIZE = 256
const FR = Uint8Array.from('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001'.match(/../g)!, (v) => parseInt(v, 16))
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function requireMdu0(mdu0: Uint8Array): void {
  if (mdu0.byteLength !== MDU_SIZE_BYTES) throw new Error('invalid MDU0 size')
}

// A record can cross scalar boundaries; only its bounded logical range is copied.
export function readPolyfsFatRange(mdu0: Uint8Array, offset: number, length: number): Uint8Array {
  requireMdu0(mdu0)
  asNonNegativeInteger(offset, 'FAT offset')
  asNonNegativeInteger(length, 'FAT length')
  if (offset > POLYFS_FAT_LOGICAL_BYTES || length > POLYFS_FAT_LOGICAL_BYTES - offset) throw new Error('FAT range out of bounds')
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const logical = offset + i
    out[i] = mdu0[FILE_TABLE_START + Math.floor(logical / 31) * 32 + 1 + logical % 31]
  }
  return out
}

function validateRootCells(mdu0: Uint8Array): void {
  for (let off = 0; off < FILE_TABLE_START; off += 32) {
    let comparison = 0
    for (let i = 0; i < 32; i++) {
      comparison = mdu0[off + i] - FR[i]
      if (comparison) break
    }
    if (comparison >= 0) throw new Error('noncanonical root-table scalar')
  }
}

function validateAuthenticatedMdu0Structure(mdu0: Uint8Array, count: number): void {
  requireMdu0(mdu0)
  validateRootCells(mdu0)
  for (let off = FILE_TABLE_START; off < mdu0.length; off += 32) {
    if (mdu0[off] !== 0) throw new Error('nonzero FAT scalar reserved byte')
  }
  asNonNegativeInteger(count, 'FAT record count')
  if (count > POLYFS_FILE_RECORD_CAPACITY) throw new Error('FAT record count exceeds capacity')
  const end = FILE_TABLE_HEADER_SIZE + count * FILE_RECORD_SIZE
  const physicalEnd = FILE_TABLE_START + Math.floor(end / 31) * 32 + 1 + end % 31
  for (let i = physicalEnd; i < mdu0.length; i++) {
    if (mdu0[i] !== 0) throw new Error('nonzero FAT padding')
  }
}

function validatedRecordCount(mdu0: Uint8Array): number {
  requireMdu0(mdu0)
  const header = readPolyfsFatRange(mdu0, 0, FILE_TABLE_HEADER_SIZE)
  const view = new DataView(header.buffer)
  if (decoder.decode(header.subarray(0, 4)) !== 'NILF' || header[4] !== 2 || header[5] !== 0 || view.getUint16(6, true) !== FILE_RECORD_SIZE || header.subarray(12).some((v) => v !== 0)) {
    throw new Error('invalid or unsupported FAT v2 header; legacy recovery must be explicit')
  }
  const count = view.getUint32(8, true)
  return count
}

// Keep wire integers exact; existing UI consumers explicitly reject unsupported
// Number-sized ranges below instead of rounding a received file map.
export function decodePolyfsFileRecord(bytes: Uint8Array): {
  path: string; start_offset: bigint; size_bytes: bigint; timestamp: bigint; flags: number
} {
  if (bytes.length !== FILE_RECORD_SIZE) throw new Error('invalid file record size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = view.getBigUint64(0, true)
  const packed = view.getBigUint64(8, true)
  const size = packed & 0x00ff_ffff_ffff_ffffn
  if (start + size > 0xffff_ffff_ffff_ffffn) throw new Error('file extent overflow')
  const pathBytes = bytes.subarray(24)
  const terminator = pathBytes.indexOf(0)
  if (terminator >= 0 && pathBytes.subarray(terminator).some((v) => v !== 0)) throw new Error('nonzero file path suffix')
  const path = decoder.decode(terminator < 0 ? pathBytes : pathBytes.subarray(0, terminator))
  if (path) validatePolyfsRecordPath(path)
  return { path, start_offset: start, size_bytes: size, timestamp: view.getBigUint64(16, true), flags: Number(packed >> 56n) }
}

export function parsePolyfsRecordsFromAuthenticatedMdu0(mdu0: Uint8Array, count: number): ReturnType<typeof decodePolyfsFileRecord>[] {
  validateAuthenticatedMdu0Structure(mdu0, count)
  const records: ReturnType<typeof decodePolyfsFileRecord>[] = []
  const paths = new Set<string>()
  for (let i = 0; i < count; i++) {
    const record = decodePolyfsFileRecord(readPolyfsFatRange(mdu0, FILE_TABLE_HEADER_SIZE + i * FILE_RECORD_SIZE, FILE_RECORD_SIZE))
    if (record.path) {
      if (paths.has(record.path)) throw new Error('duplicate active file path')
      paths.add(record.path)
    }
    records.push(record)
  }
  return records
}

export function parsePolyfsRecordsFromMdu0(mdu0: Uint8Array): ReturnType<typeof decodePolyfsFileRecord>[] {
  return parsePolyfsRecordsFromAuthenticatedMdu0(mdu0, validatedRecordCount(mdu0))
}

export function parsePolyfsFilesFromMdu0(mdu0: Uint8Array): PolyfsFileEntry[] {
  const files: PolyfsFileEntry[] = []
  for (const record of parsePolyfsRecordsFromMdu0(mdu0)) {
    if (!record.path) continue
    const start = asNonNegativeInteger(Number(record.start_offset), 'start offset')
    const size = asNonNegativeInteger(Number(record.size_bytes), 'file size')
    asNonNegativeInteger(start + size, 'file end')
    files.push({ path: record.path, start_offset: start, size_bytes: size, flags: record.flags })
  }
  return files
}

// Count comes from the pinned deal layout, never from nonzero-cell filtering.
// A zero digest cell occupies its index just like every other canonical cell.
export function parsePolyfsRootTableFromMdu0(mdu0: Uint8Array, count: number): Uint8Array[] {
  requireMdu0(mdu0)
  asNonNegativeInteger(count, 'root count')
  if (count > POLYFS_ROOT_TABLE_CAPACITY) throw new Error('root count exceeds capacity')
  validateRootCells(mdu0)
  return Array.from({ length: count }, (_, i) => mdu0.slice(i * 32, (i + 1) * 32))
}

export function mode2RowsForK(k: number): number {
  const normalized = asNonNegativeInteger(k, 'k')
  if (normalized === 0 || 64 % normalized !== 0) {
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
    const slot = asNonNegativeInteger(slice.slot, 'slot')
    if (slot >= k || bySlot.has(slot)) throw new Error('invalid or duplicate data slot')
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

// Root-table cells store the public Merkle digest reduced once modulo BLS12-381
// Fr. Compare with that representation, never relabel a cell as the raw digest.
export function assertPolyfsRootCell(digest: Uint8Array, cell: Uint8Array): void {
  if (digest.length !== 32 || cell.length !== 32) throw new Error('invalid root identity')
  const integer = (bytes: Uint8Array) => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
  const modulus = integer(FR), expected = integer(cell)
  if (expected >= modulus || integer(digest) % modulus !== expected) throw new Error('MDU does not match authenticated root-table cell')
}
