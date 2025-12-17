import type { NilfsFileEntry } from '../domain/nilfs'

const MDU_SIZE_BYTES = 8 * 1024 * 1024
const BLOB_SIZE_BYTES = 128 * 1024
const FILE_TABLE_START = 16 * BLOB_SIZE_BYTES
const FILE_TABLE_HEADER_SIZE = 128
const FILE_RECORD_SIZE = 64

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

export function parseNilfsFilesFromMdu0(mdu0: Uint8Array): NilfsFileEntry[] {
  if (mdu0.length !== MDU_SIZE_BYTES) return []

  const view = new DataView(mdu0.buffer, mdu0.byteOffset, mdu0.byteLength)
  const magicOffset = FILE_TABLE_START
  const magic = parseNullTerminatedUtf8(mdu0.slice(magicOffset, magicOffset + 4))
  if (magic !== 'NILF') return []

  const recordCount = view.getUint32(magicOffset + 8, true)
  const recordsOffset = magicOffset + FILE_TABLE_HEADER_SIZE

  const files: NilfsFileEntry[] = []
  for (let i = 0; i < recordCount; i++) {
    const off = recordsOffset + i * FILE_RECORD_SIZE
    if (off + FILE_RECORD_SIZE > mdu0.length) break

    const startOffset = Number(view.getBigUint64(off, true))
    const lengthAndFlags = view.getBigUint64(off + 8, true)
    const { length, flags } = unpackLengthAndFlags(lengthAndFlags)
    const pathBytes = mdu0.slice(off + 24, off + 64)
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

