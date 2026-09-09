import { bech32 } from 'bech32'

import type { PolyfsFileEntry } from '../domain/polyfs'
import { normalizeManifestRoot } from './cacheFreshness'
import { RAW_MDU_CAPACITY, readPolyfsFileFromVerifiedLayout } from './polyfsOpfsFetch'
import {
  openCompleteSlabGeneration,
  type CompleteSlabGeneration,
  type SlabMetadata,
} from './storage/OpfsAdapter'

const MDU_SIZE_BYTES = 8 * 1024 * 1024

export interface CachedDownloadInput {
  dealId: string
  manifestRoot: string
  owner: string
  viewerOwners: readonly string[]
  file: PolyfsFileEntry
  rangeStart?: number
  rangeLen?: number
}

export interface CachedDownloadStorage {
  openGeneration(dealId: string): Promise<CompleteSlabGeneration | null>
}

const browserStorage: CachedDownloadStorage = {
  openGeneration: openCompleteSlabGeneration,
}

function canonicalAccount(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(normalized)) return normalized.slice(2)
  try {
    const decoded = bech32.decode(normalized)
    const bytes = new Uint8Array(bech32.fromWords(decoded.words))
    if (bytes.byteLength === 20) return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // Non-address owner identifiers still require exact text equality.
  }
  return normalized
}

function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalAccount(a)
  return left !== '' && left === canonicalAccount(b)
}

function safeRecord(file: PolyfsFileEntry): boolean {
  return Boolean(file.path) &&
    Number.isSafeInteger(file.start_offset) && file.start_offset >= 0 &&
    Number.isSafeInteger(file.size_bytes) && file.size_bytes >= 0 &&
    Number.isSafeInteger(file.flags) && file.flags >= 0 && file.flags <= 0xff
}

function sameFile(a: PolyfsFileEntry, b: PolyfsFileEntry): boolean {
  return a.path === b.path && a.start_offset === b.start_offset && a.size_bytes === b.size_bytes && a.flags === b.flags
}

function validateMetadata(
  input: CachedDownloadInput,
  generation: CompleteSlabGeneration,
  metadata: SlabMetadata,
): Map<string, PolyfsFileEntry> | null {
  const root = normalizeManifestRoot(input.manifestRoot)
  if (!root || normalizeManifestRoot(generation.manifestRoot) !== root) return null
  if (metadata.schema_version !== 1) return null
  if (String(metadata.deal_id ?? '') !== input.dealId || normalizeManifestRoot(metadata.manifest_root) !== root) return null
  if (!sameAccount(metadata.owner, input.owner)) return null
  if (!input.viewerOwners.some((viewer) => sameAccount(viewer, input.owner))) return null
  if (
    !Number.isSafeInteger(metadata.witness_mdus) || metadata.witness_mdus < 0 ||
    !Number.isSafeInteger(metadata.user_mdus) || metadata.user_mdus < 0 ||
    !Number.isSafeInteger(metadata.total_mdus) || metadata.total_mdus !== 1 + metadata.witness_mdus + metadata.user_mdus
  ) return null

  const capacity = metadata.user_mdus * RAW_MDU_CAPACITY
  if (!Number.isSafeInteger(capacity)) return null
  const files = new Map<string, PolyfsFileEntry>()
  for (const candidate of metadata.file_records) {
    if (!safeRecord(candidate) || candidate.start_offset + candidate.size_bytes > capacity) return null
    if (files.has(candidate.path)) return null
    files.set(candidate.path, { ...candidate })
  }
  return files
}

function rangeFor(file: PolyfsFileEntry, startRaw?: number, lengthRaw?: number): { start: number; length: number } | null {
  const start = Number(startRaw || 0)
  const requested = Number(lengthRaw || 0)
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(requested) || requested < 0 || start > file.size_bytes) return null
  const length = requested > 0 ? requested : file.size_bytes - start
  if (!Number.isSafeInteger(length) || start + length > file.size_bytes) return null
  return { start, length }
}

async function openVerifiedGeneration(
  input: CachedDownloadInput,
  storage: CachedDownloadStorage,
): Promise<{ generation: CompleteSlabGeneration; metadata: SlabMetadata; files: Map<string, PolyfsFileEntry> } | null> {
  const root = normalizeManifestRoot(input.manifestRoot)
  if (!root || !input.owner) return null
  const generation = await storage.openGeneration(input.dealId)
  if (!generation) return null
  const [localRoot, metadata] = await Promise.all([generation.readManifestRoot(), generation.readMetadata()])
  if (!metadata || normalizeManifestRoot(localRoot) !== root) return null
  const files = validateMetadata(input, generation, metadata)
  return files ? { generation, metadata, files } : null
}

function selectVerifiedFile(
  opened: Awaited<ReturnType<typeof openVerifiedGeneration>>,
  input: CachedDownloadInput,
): { generation: CompleteSlabGeneration; metadata: SlabMetadata; file: PolyfsFileEntry; start: number; length: number } | null {
  if (!opened) return null
  const candidate = opened.files.get(input.file.path)
  // The current bounded decoder supports raw PolyFS records only.
  const file = candidate && candidate.flags === 0 && sameFile(candidate, input.file) ? candidate : null
  const range = file ? rangeFor(file, input.rangeStart, input.rangeLen) : null
  return file && range ? { generation: opened.generation, metadata: opened.metadata, file, ...range } : null
}

async function openVerifiedFile(
  input: CachedDownloadInput,
  storage: CachedDownloadStorage,
): Promise<ReturnType<typeof selectVerifiedFile>> {
  return selectVerifiedFile(await openVerifiedGeneration(input, storage), input)
}

async function hasRequiredMduSizes(
  generation: CompleteSlabGeneration,
  metadata: SlabMetadata,
  file: PolyfsFileEntry,
  start: number,
  length: number,
  knownSizes?: Map<number, boolean>,
): Promise<boolean> {
  if (length === 0) return true
  const first = Math.floor((file.start_offset + start) / RAW_MDU_CAPACITY)
  const last = Math.floor((file.start_offset + start + length - 1) / RAW_MDU_CAPACITY)
  if (first < 0 || last >= metadata.user_mdus) return false
  for (let ordinal = first; ordinal <= last; ordinal += 1) {
    const index = 1 + metadata.witness_mdus + ordinal
    let complete = knownSizes?.get(index)
    if (complete == null) {
      complete = await generation.mduSize(index) === MDU_SIZE_BYTES
      knownSizes?.set(index, complete)
    }
    if (!complete) return false
  }
  return true
}

/** Checks cache completeness without reading or allocating the file payload. */
export async function hasVerifiedCachedDownload(
  input: CachedDownloadInput,
  storage: CachedDownloadStorage = browserStorage,
): Promise<boolean> {
  try {
    const opened = await openVerifiedFile(input, storage)
    if (!opened) return false
    return hasRequiredMduSizes(opened.generation, opened.metadata, opened.file, opened.start, opened.length)
  } catch {
    return false
  }
}

/** Checks a file listing through one metadata snapshot and one pinned generation. */
export async function verifiedCachedDownloadAvailability(
  inputs: readonly CachedDownloadInput[],
  storage: CachedDownloadStorage = browserStorage,
): Promise<Record<string, boolean>> {
  const available: Record<string, boolean> = {}
  for (const input of inputs) available[input.file.path] = false
  if (inputs.length === 0) return available
  try {
    const opened = await openVerifiedGeneration(inputs[0], storage)
    if (!opened) return available
    const knownSizes = new Map<number, boolean>()
    for (const input of inputs) {
      if (
        input.dealId !== inputs[0].dealId ||
        normalizeManifestRoot(input.manifestRoot) !== normalizeManifestRoot(inputs[0].manifestRoot) ||
        !sameAccount(input.owner, inputs[0].owner) ||
        !input.viewerOwners.some((viewer) => sameAccount(viewer, input.owner))
      ) continue
      const selected = selectVerifiedFile(opened, input)
      if (!selected) continue
      available[selected.file.path] = await hasRequiredMduSizes(
        opened.generation,
        opened.metadata,
        selected.file,
        selected.start,
        selected.length,
        knownSizes,
      )
    }
  } catch {
    // A removed or incomplete generation remains unavailable.
  }
  return available
}

export async function readVerifiedCachedDownload(
  input: CachedDownloadInput,
  storage: CachedDownloadStorage = browserStorage,
): Promise<Uint8Array | null> {
  try {
    const opened = await openVerifiedFile(input, storage)
    if (!opened) return null
    const { generation, metadata, file, start, length } = opened
    if (!(await hasRequiredMduSizes(generation, metadata, file, start, length))) return null

    const bytes = await readPolyfsFileFromVerifiedLayout({
      dealId: input.dealId,
      file,
      allFiles: metadata.file_records,
      witnessMdus: metadata.witness_mdus,
      userMdus: metadata.user_mdus,
      totalMdus: metadata.total_mdus,
      rangeStart: start,
      rangeLen: length,
    }, (_dealId, mduIndex) => generation.readMdu(mduIndex))
    return bytes.byteLength === length ? bytes : null
  } catch {
    return null
  }
}

export async function preferVerifiedCache<T>(
  readCache: () => Promise<Uint8Array | null>,
  networkUnavailableReason: string | undefined,
  fetchNetwork: () => Promise<T>,
): Promise<{ source: 'cache'; bytes: Uint8Array } | { source: 'network'; result: T }> {
  const bytes = await readCache()
  if (bytes) return { source: 'cache', bytes }
  if (networkUnavailableReason) throw new Error(networkUnavailableReason)
  return { source: 'network', result: await fetchNetwork() }
}
