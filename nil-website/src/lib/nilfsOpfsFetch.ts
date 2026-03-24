import type { NilfsFileEntry } from '../domain/nilfs'
import { listDealFiles, readManifestRoot, readMdu, readSlabMetadata } from './storage/OpfsAdapter'

const MDU_SIZE_BYTES = 8 * 1024 * 1024
const NILFS_SCALAR_BYTES = 32
const NILFS_SCALAR_PAYLOAD_BYTES = 31
const NILFS_SCALARS_PER_MDU = Math.floor(MDU_SIZE_BYTES / NILFS_SCALAR_BYTES)

export const RAW_MDU_CAPACITY = NILFS_SCALARS_PER_MDU * NILFS_SCALAR_PAYLOAD_BYTES

function parseMduIndex(fileName: string): number | null {
  const match = /^mdu_(\d+)\.bin$/.exec(fileName)
  if (!match) return null
  const idx = Number(match[1])
  if (!Number.isFinite(idx) || idx < 0) return null
  return idx
}

function inferMaxEnd(files: NilfsFileEntry[]): number {
  let maxEnd = 0
  for (const f of files) {
    const start = Number(f.start_offset)
    const len = Number(f.size_bytes)
    if (!Number.isFinite(start) || start < 0) continue
    if (!Number.isFinite(len) || len <= 0) continue
    const end = start + len
    if (end > maxEnd) maxEnd = end
  }
  return maxEnd
}

function normalizeManifestRoot(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
}

function hasContiguousMduRange(indices: Set<number>, totalMdus: number): boolean {
  if (!Number.isFinite(totalMdus) || totalMdus <= 0) return false
  for (let i = 0; i < totalMdus; i++) {
    if (!indices.has(i)) return false
  }
  return true
}

export async function inferWitnessCountFromOpfs(dealId: string, files: NilfsFileEntry[]): Promise<{
  witnessCount: number
  slabStartIdx: number
  totalMdus: number
  userCount: number
  maxEnd: number
}> {
  const fileNames = await listDealFiles(dealId)
  const mduIndices = new Set<number>()
  for (const name of fileNames) {
    const idx = parseMduIndex(name)
    if (idx == null) continue
    mduIndices.add(idx)
  }

  const meta = await readSlabMetadata(dealId).catch(() => null)
  if (meta) {
    const persistedManifestRoot = normalizeManifestRoot(await readManifestRoot(dealId).catch(() => null))
    const metadataManifestRoot = normalizeManifestRoot(meta.manifest_root)
    const manifestMatches = persistedManifestRoot !== '' && persistedManifestRoot === metadataManifestRoot
    const metadataCountsSane = meta.total_mdus === 1 + meta.witness_mdus + meta.user_mdus
    const metadataMduLayoutSane = metadataCountsSane && hasContiguousMduRange(mduIndices, meta.total_mdus)

    if (manifestMatches && metadataMduLayoutSane) {
      const metadataFiles: NilfsFileEntry[] = meta.file_records.map((rec) => ({
        path: rec.path,
        size_bytes: rec.size_bytes,
        start_offset: rec.start_offset,
        flags: rec.flags,
      }))
      const maxEnd = Math.max(inferMaxEnd(files), inferMaxEnd(metadataFiles))
      return {
        witnessCount: meta.witness_mdus,
        slabStartIdx: 1 + meta.witness_mdus,
        totalMdus: meta.total_mdus,
        userCount: meta.user_mdus,
        maxEnd,
      }
    }
  }

  const totalMdus = mduIndices.size
  if (totalMdus === 0) throw new Error('no MDUs found in OPFS')

  const maxEnd = inferMaxEnd(files)
  const userCount = maxEnd > 0 ? Math.ceil(maxEnd / RAW_MDU_CAPACITY) : 0
  const witnessCount = (totalMdus - 1) - userCount
  if (witnessCount < 0) {
    throw new Error(`invalid slab layout: mdus=${totalMdus} userCount=${userCount}`)
  }

  return { witnessCount, slabStartIdx: 1 + witnessCount, totalMdus, userCount, maxEnd }
}

function decodeRawSliceFromMdu(opts: {
  mdu: Uint8Array
  rawStart: number
  rawLen: number
  rawValidLen: number
}): Uint8Array {
  const { mdu, rawStart, rawLen, rawValidLen } = opts
  if (rawLen <= 0) return new Uint8Array()
  if (rawStart < 0 || rawLen < 0) throw new Error('invalid raw range')
  if (rawStart + rawLen > rawValidLen) throw new Error('raw range exceeds valid data length')

  const out = new Uint8Array(rawLen)
  const rem = rawValidLen % NILFS_SCALAR_PAYLOAD_BYTES
  const fullScalars = rem === 0 ? rawValidLen / NILFS_SCALAR_PAYLOAD_BYTES : Math.floor(rawValidLen / NILFS_SCALAR_PAYLOAD_BYTES)
  const lastPartialLen = rem === 0 ? NILFS_SCALAR_PAYLOAD_BYTES : rem

  let cursor = rawStart
  let remaining = rawLen
  let outOffset = 0

  while (remaining > 0) {
    const scalarIdx = Math.floor(cursor / NILFS_SCALAR_PAYLOAD_BYTES)
    const offsetInScalar = cursor % NILFS_SCALAR_PAYLOAD_BYTES
    const isPartialScalar = rem !== 0 && scalarIdx === fullScalars
    const scalarLen = isPartialScalar ? lastPartialLen : NILFS_SCALAR_PAYLOAD_BYTES

    const available = scalarLen - offsetInScalar
    const take = Math.min(remaining, available)

    const scalarBase = scalarIdx * NILFS_SCALAR_BYTES
    const payloadStart = scalarBase + (isPartialScalar ? (NILFS_SCALAR_BYTES - lastPartialLen) : 1)
    const encStart = payloadStart + offsetInScalar

    out.set(mdu.slice(encStart, encStart + take), outOffset)
    outOffset += take
    remaining -= take
    cursor += take
  }

  return out
}

export function decodeRawPrefixFromMdu(mdu: Uint8Array, rawValidLen: number): Uint8Array {
  const safeLen = Math.max(0, Math.min(RAW_MDU_CAPACITY, Math.floor(Number(rawValidLen) || 0)))
  if (safeLen === 0) return new Uint8Array()
  return decodeRawSliceFromMdu({ mdu, rawStart: 0, rawLen: safeLen, rawValidLen: safeLen })
}

export async function readNilfsFileFromOpfs(opts: {
  dealId: string
  file: NilfsFileEntry
  allFiles: NilfsFileEntry[]
  rangeStart?: number
  rangeLen?: number
}): Promise<Uint8Array> {
  const { dealId, file, allFiles } = opts
  const safeRangeStart = Math.max(0, Number(opts.rangeStart || 0) || 0)
  const safeRangeLen = Math.max(0, Number(opts.rangeLen || 0) || 0)

  if (safeRangeStart >= file.size_bytes) throw new Error('rangeStart beyond EOF')
  const maxLen = file.size_bytes - safeRangeStart
  const length = safeRangeLen > 0 ? Math.min(maxLen, safeRangeLen) : maxLen

  const { slabStartIdx, maxEnd } = await inferWitnessCountFromOpfs(dealId, allFiles)

  const absStart = file.start_offset + safeRangeStart
  let remaining = length
  let cursor = absStart
  let outOffset = 0
  const out = new Uint8Array(length)

  while (remaining > 0) {
    const userMduIdx = Math.floor(cursor / RAW_MDU_CAPACITY)
    const offsetInMdu = cursor % RAW_MDU_CAPACITY
    const mduBase = userMduIdx * RAW_MDU_CAPACITY

    const rawValidLen = Math.max(0, Math.min(RAW_MDU_CAPACITY, maxEnd - mduBase))
    if (rawValidLen === 0) throw new Error('slab has no data for requested offset')

    const available = rawValidLen - offsetInMdu
    if (available <= 0) throw new Error('requested offset beyond valid slab data')

    const take = Math.min(remaining, available)
    const slabMduIndex = slabStartIdx + userMduIdx
    const mdu = await readMdu(dealId, slabMduIndex)
    if (!mdu) throw new Error(`missing local MDU: mdu_${slabMduIndex}.bin`)

    const decoded = decodeRawSliceFromMdu({ mdu, rawStart: offsetInMdu, rawLen: take, rawValidLen })
    out.set(decoded, outOffset)

    outOffset += take
    cursor += take
    remaining -= take
  }

  return out
}
