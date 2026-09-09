import { bech32 } from 'bech32'

import type { PolyfsFileEntry } from '../domain/polyfs'
import { normalizeManifestRoot } from './cacheFreshness'
import { RAW_MDU_CAPACITY, readPolyfsFileFromVerifiedLayout } from './polyfsOpfsFetch'
import { createRecoveryCommitmentReader, type RecoveryGeometry } from './retrievalRecovery'
import type { RetrievalFile } from './retrieval'
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
  authority: CachedDownloadAuthority | null
  rangeStart?: number
  rangeLen?: number
}

export interface CachedDownloadAuthority extends RecoveryGeometry {
  root: `0x${string}`
  totalMdus: bigint
}

export interface CachedDownloadVerifier {
  verifyMetadata(bytes: Uint8Array, authority: CachedDownloadAuthority): Promise<readonly RetrievalFile[]>
  verifyWitness(bytes: Uint8Array, cell: Uint8Array): Promise<Uint8Array>
  readCommitments(authority: CachedDownloadAuthority, ordinal: bigint, witness: { index: bigint; bytes: Uint8Array }[], cell: Uint8Array): Promise<Uint8Array>
  verifyMdu(authority: CachedDownloadAuthority, bytes: Uint8Array, commitments: Uint8Array): Promise<Uint8Array>
}

export interface CachedDownloadStorage {
  openGeneration(dealId: string): Promise<CompleteSlabGeneration | null>
}

const browserStorage: CachedDownloadStorage = {
  openGeneration: openCompleteSlabGeneration,
}

const browserVerifier: CachedDownloadVerifier = {
  verifyMetadata: async (bytes, authority) => (await import('./worker-client')).workerClient.verifyRetrievalMetadata(bytes, authority),
  verifyWitness: async (bytes, cell) => (await import('./worker-client')).workerClient.verifyRetrievalWitness(bytes, cell),
  readCommitments: async (authority, ordinal, witness, cell) => (await import('./worker-client')).workerClient.readRetrievalCommitments(authority, ordinal, witness, cell),
  verifyMdu: async (authority, bytes, commitments) => (await import('./worker-client')).workerClient.verifyRetrievalMdu(authority, bytes, commitments),
}

export function cachedDownloadAuthority(input: {
  cid?: string
  total_mdus?: string
  witness_mdus?: string
  redundancy_mode?: number
  mode2_profile?: { k?: number; m?: number }
}): CachedDownloadAuthority | null {
  const root = normalizeManifestRoot(input.cid)
  const total = input.total_mdus
  const witness = input.witness_mdus
  const k = input.mode2_profile?.k
  const m = input.mode2_profile?.m
  if (
    !/^0x[0-9a-f]{64}$/.test(root) || input.redundancy_mode !== 2 ||
    typeof total !== 'string' || !/^[1-9][0-9]{0,4}$/.test(total) ||
    typeof witness !== 'string' || !/^(0|[1-9][0-9]{0,4})$/.test(witness) ||
    !Number.isSafeInteger(k) || !k || k < 1 || k > 64 || 64 % k !== 0 ||
    !Number.isSafeInteger(m) || !m || m < 1 || k + m > 256
  ) return null
  const totalMdus = BigInt(total)
  const metadataMdus = 1n + BigInt(witness)
  const userMdus = totalMdus - metadataMdus
  const rows = 64 / k
  const leafCount = rows * (k + m)
  if (userMdus < 0n || totalMdus > 65537n || userMdus * BigInt(leafCount * 48) > BigInt(witness) * BigInt(RAW_MDU_CAPACITY)) return null
  return { root: root as `0x${string}`, layout: 2, k, m, rows, leafCount, metadataMdus, userMdus, totalMdus }
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
  if (!root || !validAuthority(input) || normalizeManifestRoot(generation.manifestRoot) !== root) return null
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

function validAuthority(input: CachedDownloadInput): input is CachedDownloadInput & { authority: CachedDownloadAuthority } {
  const authority = input.authority
  return Boolean(
    authority && authority.layout === 2 &&
    normalizeManifestRoot(authority.root) === normalizeManifestRoot(input.manifestRoot) &&
    Number.isSafeInteger(authority.k) && authority.k > 0 && authority.k <= 64 && 64 % authority.k === 0 &&
    Number.isSafeInteger(authority.m) && authority.m > 0 && authority.k + authority.m <= 256 &&
    authority.rows === 64 / authority.k && authority.leafCount === authority.rows * (authority.k + authority.m) &&
    authority.metadataMdus >= 1n && authority.userMdus >= 0n &&
    authority.totalMdus === authority.metadataMdus + authority.userMdus && authority.totalMdus <= 65537n &&
    authority.userMdus * BigInt(authority.leafCount * 48) <= (authority.metadataMdus - 1n) * BigInt(RAW_MDU_CAPACITY),
  )
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
  verifier: CachedDownloadVerifier = browserVerifier,
): Promise<Uint8Array | null> {
  try {
    if (!validAuthority(input) || !input.viewerOwners.some((viewer) => sameAccount(viewer, input.owner))) return null
    const root = normalizeManifestRoot(input.manifestRoot)
    const generation = await storage.openGeneration(input.dealId)
    if (!generation || normalizeManifestRoot(generation.manifestRoot) !== root || normalizeManifestRoot(await generation.readManifestRoot()) !== root) return null

    const mdu0 = await generation.readMdu(0)
    if (!mdu0 || mdu0.byteLength !== MDU_SIZE_BYTES) return null
    const authenticatedRecords = await verifier.verifyMetadata(mdu0, input.authority)
    const allFiles: PolyfsFileEntry[] = authenticatedRecords.filter((record) => record.path).map((record) => ({
      path: record.path,
      start_offset: Number(record.start_offset),
      size_bytes: Number(record.size_bytes),
      flags: record.flags,
    }))
    if (allFiles.some((record) => !safeRecord(record))) return null
    const file = allFiles.find((record) => record.path === input.file.path)
    if (!file || file.flags !== 0 || !sameFile(file, input.file)) return null
    const range = rangeFor(file, input.rangeStart, input.rangeLen)
    if (!range) return null

    const readCommitments = createRecoveryCommitmentReader(input.authority, mdu0, {
      fetch: async (index) => {
        const bytes = await generation.readMdu(Number(index))
        if (!bytes || bytes.byteLength !== MDU_SIZE_BYTES) throw new Error('cached witness MDU is incomplete')
        return bytes
      },
      verifyWitness: verifier.verifyWitness,
      readCommitments: verifier.readCommitments,
    })
    const bytes = await readPolyfsFileFromVerifiedLayout({
      dealId: input.dealId,
      file,
      allFiles,
      witnessMdus: Number(input.authority.metadataMdus - 1n),
      userMdus: Number(input.authority.userMdus),
      totalMdus: Number(input.authority.totalMdus),
      rangeStart: range.start,
      rangeLen: range.length,
    }, async (_dealId, mduIndex) => {
      const ordinal = BigInt(mduIndex) - input.authority.metadataMdus
      const encoded = await generation.readMdu(mduIndex)
      if (!encoded || encoded.byteLength !== MDU_SIZE_BYTES) return null
      const commitments = await readCommitments(ordinal)
      const verified = await verifier.verifyMdu(input.authority, encoded, commitments)
      return verified.byteLength === MDU_SIZE_BYTES ? verified : null
    })
    return bytes.byteLength === range.length ? bytes : null
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
