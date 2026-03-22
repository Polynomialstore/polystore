// nil-website/src/lib/storage/OpfsAdapter.ts

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { expandSparseBytes, makeSparseArtifact, type SparseArtifactInput } from '../upload/sparseArtifacts'

const SLAB_METADATA_FILE = 'slab_meta.json'
const GENERATIONS_DIR = 'generations'
const ACTIVE_GENERATION_POINTER_FILE = 'active_generation.txt'
const GENERATION_COMPLETE_MARKER_FILE = '.generation_complete'
const GENERATION_DIR_PREFIX = 'gen-'
const ARTIFACT_META_SUFFIX = '.meta.json'

export interface GenerationMduWrite {
    index: number
    data: Uint8Array
    fullSize?: number
}

export interface GenerationShardWrite {
    mduIndex: number
    slot: number
    data: Uint8Array
    fullSize?: number
}

export interface AtomicSlabGenerationWriteInput {
    manifestRoot: string
    manifestBlob?: Uint8Array | null
    manifestBlobFullSize?: number
    mdus: GenerationMduWrite[]
    shards?: GenerationShardWrite[]
    metadata: SlabMetadata
}

export interface SlabMetadataFileRecord {
    path: string
    start_offset: number
    size_bytes: number
    flags: number
}

export interface SlabMetadataRedundancy {
    k?: number
    m?: number
    n?: number
}

export interface SlabMetadata {
    schema_version: number
    generation_id: string
    deal_id?: string | number
    manifest_root: string
    owner?: string
    redundancy?: SlabMetadataRedundancy
    source: string
    created_at: string
    last_validated_at: string | null
    witness_mdus: number
    user_mdus: number
    total_mdus: number
    file_records: SlabMetadataFileRecord[]
}

/**
 * Returns a handle to the root of the origin's private file system.
 * This handle is persistent across sessions for the same origin.
 */
async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
    return navigator.storage.getDirectory();
}

/**
 * Gets or creates a subdirectory for a specific deal ID within the OPFS root.
 * @param dealId The ID of the deal.
 * @returns A FileSystemDirectoryHandle for the deal's directory.
 */
async function getDealDirectory(dealId: string, create = true): Promise<FileSystemDirectoryHandle> {
    const root = await getOpfsRoot();
    return root.getDirectoryHandle(`deal-${dealId}`, { create });
}

async function writeBlobToDirectory(
    dir: FileSystemDirectoryHandle,
    name: string,
    data: BlobPart | Uint8Array<ArrayBufferLike>,
): Promise<void> {
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    // NOTE: Newer TS DOM lib defines `BlobPart` in a way that rejects `Uint8Array<ArrayBufferLike>`
    // (because it might be backed by `SharedArrayBuffer`). For OPFS writes, we accept it and rely
    // on runtime support; tests exercise the path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writable.write(data as any)
    await writable.close()
}

async function readBlobFromDirectory(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
    try {
        const fileHandle = await dir.getFileHandle(name)
        const file = await fileHandle.getFile()
        const buffer = await file.arrayBuffer()
        return new Uint8Array(buffer)
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') return null
        throw e
    }
}

async function removeEntryIfExists(dir: FileSystemDirectoryHandle, name: string, recursive = false): Promise<void> {
    try {
        await dir.removeEntry(name, recursive ? { recursive: true } : undefined)
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') return
        throw e
    }
}

async function getGenerationsDirectory(
    dealDir: FileSystemDirectoryHandle,
    create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
    try {
        return await dealDir.getDirectoryHandle(GENERATIONS_DIR, { create })
    } catch (e: unknown) {
        if (!create && e instanceof Error && e.name === 'NotFoundError') return null
        throw e
    }
}

function sanitizeGenerationName(raw: string): string {
    return String(raw || '').trim().replace(/[^a-zA-Z0-9._-]/g, '')
}

async function readActiveGenerationName(dealDir: FileSystemDirectoryHandle): Promise<string | null> {
    const raw = await readBlobFromDirectory(dealDir, ACTIVE_GENERATION_POINTER_FILE)
    if (!raw) return null
    const parsed = sanitizeGenerationName(new TextDecoder().decode(raw))
    return parsed || null
}

async function writeActiveGenerationName(dealDir: FileSystemDirectoryHandle, generationName: string): Promise<void> {
    const safe = sanitizeGenerationName(generationName)
    if (!safe) throw new Error('generation name is required')
    await writeBlobToDirectory(dealDir, ACTIVE_GENERATION_POINTER_FILE, new TextEncoder().encode(`${safe}\n`))
}

async function generationLooksComplete(dir: FileSystemDirectoryHandle): Promise<boolean> {
    const marker = await readBlobFromDirectory(dir, GENERATION_COMPLETE_MARKER_FILE)
    if (!marker) return false
    const meta = await readBlobFromDirectory(dir, SLAB_METADATA_FILE)
    const mdu0 = await readBlobFromDirectory(dir, 'mdu_0.bin')
    const manifest = await readBlobFromDirectory(dir, 'manifest.bin')
    return !!meta && !!mdu0 && !!manifest
}

async function removeIncompleteGenerationIfAny(
    generationsDir: FileSystemDirectoryHandle,
    generationName: string,
): Promise<void> {
    try {
        const handle = await generationsDir.getDirectoryHandle(generationName)
        const complete = await generationLooksComplete(handle)
        if (!complete) {
            await removeEntryIfExists(generationsDir, generationName, true)
        }
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') return
        throw e
    }
}

async function cleanupInactiveGenerations(
    dealDir: FileSystemDirectoryHandle,
    activeGenerationName: string,
): Promise<void> {
    const generationsDir = await getGenerationsDirectory(dealDir, false)
    if (!generationsDir) return
    const keep = sanitizeGenerationName(activeGenerationName)
    // @ts-expect-error - FileSystemDirectoryHandle is iterable
    for await (const entry of generationsDir.values()) {
        if (entry.kind !== 'directory') continue
        const name = sanitizeGenerationName(entry.name)
        if (!name || name === keep) continue
        await removeEntryIfExists(generationsDir, name, true)
    }
}

async function resolveActiveStorageDirectory(dealId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const dealDir = await getDealDirectory(dealId, create)
    const activeGenerationName = await readActiveGenerationName(dealDir)
    if (!activeGenerationName) return dealDir

    const generationsDir = await getGenerationsDirectory(dealDir, false)
    if (!generationsDir) {
        await removeEntryIfExists(dealDir, ACTIVE_GENERATION_POINTER_FILE)
        return dealDir
    }

    await removeIncompleteGenerationIfAny(generationsDir, activeGenerationName)
    try {
        const activeDir = await generationsDir.getDirectoryHandle(activeGenerationName)
        if (!(await generationLooksComplete(activeDir))) {
            await removeEntryIfExists(generationsDir, activeGenerationName, true)
            await removeEntryIfExists(dealDir, ACTIVE_GENERATION_POINTER_FILE)
            return dealDir
        }
        return activeDir
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') {
            await removeEntryIfExists(dealDir, ACTIVE_GENERATION_POINTER_FILE)
            return dealDir
        }
        throw e
    }
}

async function writeBlob(dealId: string, name: string, data: BlobPart | Uint8Array<ArrayBufferLike>): Promise<void> {
    const dir = await resolveActiveStorageDirectory(dealId, true)
    await writeBlobToDirectory(dir, name, data)
}

async function readBlob(dealId: string, name: string): Promise<Uint8Array | null> {
    const dir = await resolveActiveStorageDirectory(dealId, true)
    return readBlobFromDirectory(dir, name)
}

async function deleteDealFile(dealId: string, name: string): Promise<void> {
    const dir = await resolveActiveStorageDirectory(dealId, true)
    await removeEntryIfExists(dir, name)
    await removeEntryIfExists(dir, artifactMetaFileName(name))
}

function artifactMetaFileName(name: string): string {
    return `${name}${ARTIFACT_META_SUFFIX}`
}

function isArtifactMetaFileName(name: string): boolean {
    return name.endsWith(ARTIFACT_META_SUFFIX)
}

async function writeArtifactToDirectory(
    dir: FileSystemDirectoryHandle,
    name: string,
    artifact: SparseArtifactInput,
): Promise<void> {
    const sparseArtifact = makeSparseArtifact(artifact)
    await writeBlobToDirectory(dir, name, sparseArtifact.bytes)
    if (sparseArtifact.bytes.byteLength < sparseArtifact.fullSize) {
        const meta = JSON.stringify({ full_size: sparseArtifact.fullSize })
        await writeBlobToDirectory(dir, artifactMetaFileName(name), new TextEncoder().encode(meta))
        return
    }
    await removeEntryIfExists(dir, artifactMetaFileName(name))
}

async function readArtifactMetaFullSize(dir: FileSystemDirectoryHandle, name: string): Promise<number | null> {
    const bytes = await readBlobFromDirectory(dir, artifactMetaFileName(name))
    if (!bytes) return null
    const text = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(text) as { full_size?: unknown }
    const fullSize = parsed.full_size
    if (!Number.isInteger(fullSize) || Number(fullSize) < 0) {
        throw new Error(`invalid sparse artifact metadata for ${name}`)
    }
    return Number(fullSize)
}

async function readArtifactFromDirectory(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
    const bytes = await readBlobFromDirectory(dir, name)
    if (!bytes) return null
    const fullSize = await readArtifactMetaFullSize(dir, name)
    if (fullSize == null) return bytes
    return expandSparseBytes(bytes, fullSize)
}

async function writeArtifact(dealId: string, name: string, artifact: SparseArtifactInput): Promise<void> {
    const dir = await resolveActiveStorageDirectory(dealId, true)
    await writeArtifactToDirectory(dir, name, artifact)
}

async function readArtifact(dealId: string, name: string): Promise<Uint8Array | null> {
    const dir = await resolveActiveStorageDirectory(dealId, true)
    return readArtifactFromDirectory(dir, name)
}

/**
 * Writes MDU data to a file within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @param mduIndex The index of the MDU (e.g., 0 for MDU #0).
 * @param data The Uint8Array containing the MDU's binary data.
 */
export async function writeMdu(
    dealId: string,
    mduIndex: number,
    data: Uint8Array,
    fullSize?: number,
): Promise<void> {
    const fileName = `mdu_${mduIndex}.bin`;
    await writeArtifact(dealId, fileName, { kind: 'mdu', index: mduIndex, bytes: data, fullSize });
}

export async function writeShard(
    dealId: string,
    mduIndex: number,
    slot: number,
    data: Uint8Array,
    fullSize?: number,
): Promise<void> {
    const fileName = `mdu_${mduIndex}_slot_${slot}.bin`;
    await writeArtifact(dealId, fileName, { kind: 'shard', index: mduIndex, slot, bytes: data, fullSize });
}

/**
 * Reads MDU data from a file within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @param mduIndex The index of the MDU to read.
 * @returns A Promise that resolves to the MDU data as Uint8Array, or null if not found.
 */
export async function readMdu(dealId: string, mduIndex: number): Promise<Uint8Array | null> {
    const fileName = `mdu_${mduIndex}.bin`;
    return await readArtifact(dealId, fileName);
}

export async function readShard(dealId: string, mduIndex: number, slot: number): Promise<Uint8Array | null> {
    const fileName = `mdu_${mduIndex}_slot_${slot}.bin`;
    return await readArtifact(dealId, fileName);
}

/**
 * Lists the names of files stored within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @returns A Promise that resolves to an array of file names.
 */
export async function listDealFiles(dealId: string): Promise<string[]> {
    const dealDir = await resolveActiveStorageDirectory(dealId, true)
    const fileNames: string[] = [];
    // @ts-expect-error - FileSystemDirectoryHandle is iterable
    for await (const entry of dealDir.values()) {
        if (entry.kind === 'file') {
            if (isArtifactMetaFileName(entry.name)) continue
            fileNames.push(entry.name);
        }
    }
    return fileNames;
}

/**
 * Deletes a specific deal's directory and all its contents from OPFS.
 * @param dealId The ID of the deal to delete.
 */
export async function deleteDealDirectory(dealId: string): Promise<void> {
    const root = await getOpfsRoot();
    try {
        await root.removeEntry(`deal-${dealId}`, { recursive: true })
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') return
        throw e
    }
}

function normalizeManifestRootString(value: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''
    return trimmed.startsWith('0x') ? trimmed.toLowerCase() : `0x${trimmed.toLowerCase()}`
}

function ensureContiguousMduSet(mdus: GenerationMduWrite[], expectedTotalMdus: number): void {
    const present = new Set<number>()
    for (const mdu of mdus) {
        const index = Math.floor(Number(mdu.index))
        if (!Number.isFinite(index) || index < 0) continue
        present.add(index)
    }
    for (let i = 0; i < expectedTotalMdus; i++) {
        if (!present.has(i)) {
            throw new Error(`generation payload is incomplete: missing mdu_${i}.bin`)
        }
    }
}

export async function writeSlabGenerationAtomically(
    dealId: string,
    input: AtomicSlabGenerationWriteInput,
): Promise<void> {
    const manifestRoot = normalizeManifestRootString(input.manifestRoot)
    if (!manifestRoot) {
        throw new Error('manifestRoot is required')
    }
    const mdus = Array.isArray(input.mdus) ? input.mdus.slice() : []
    const shards = Array.isArray(input.shards) ? input.shards.slice() : []
    const metadata = { ...input.metadata }
    if (!mdus.length) {
        throw new Error('at least one MDU is required for atomic generation write')
    }
    if (metadata.total_mdus !== 1 + metadata.witness_mdus + metadata.user_mdus) {
        throw new Error('slab metadata counts are inconsistent')
    }
    ensureContiguousMduSet(mdus, metadata.total_mdus)

    const dealDir = await getDealDirectory(dealId, true)
    const generationsDir = await getGenerationsDirectory(dealDir, true)
    if (!generationsDir) {
        throw new Error('failed to create generations directory')
    }

    const generationName = `${GENERATION_DIR_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const generationDir = await generationsDir.getDirectoryHandle(generationName, { create: true })
    const generationIdFallback = manifestRoot.replace(/^0x/i, '')

    try {
        await writeBlobToDirectory(generationDir, 'manifest_root.txt', new TextEncoder().encode(`${manifestRoot}\n`))
        if (input.manifestBlob && input.manifestBlob.byteLength > 0) {
            await writeArtifactToDirectory(generationDir, 'manifest.bin', {
                kind: 'manifest',
                bytes: input.manifestBlob,
                fullSize: input.manifestBlobFullSize,
            })
        } else {
            throw new Error('manifest blob is required for atomic generation write')
        }

        for (const mdu of mdus) {
            const index = Math.floor(mdu.index)
            await writeArtifactToDirectory(generationDir, `mdu_${index}.bin`, {
                kind: 'mdu',
                index,
                bytes: mdu.data,
                fullSize: mdu.fullSize,
            })
        }
        for (const shard of shards) {
            const mduIndex = Math.floor(shard.mduIndex)
            const slot = Math.floor(shard.slot)
            await writeArtifactToDirectory(generationDir, `mdu_${mduIndex}_slot_${slot}.bin`, {
                kind: 'shard',
                index: mduIndex,
                slot,
                bytes: shard.data,
                fullSize: shard.fullSize,
            })
        }

        metadata.generation_id = String(metadata.generation_id || generationIdFallback).trim() || generationIdFallback
        metadata.manifest_root = manifestRoot
        if (metadata.source.trim() === '') {
            metadata.source = 'browser_generation_swap'
        }
        if (metadata.created_at.trim() === '') {
            metadata.created_at = new Date().toISOString()
        }
        const payload = JSON.stringify(metadata, null, 2)
        await writeBlobToDirectory(generationDir, SLAB_METADATA_FILE, new TextEncoder().encode(payload))
        await writeBlobToDirectory(generationDir, GENERATION_COMPLETE_MARKER_FILE, new TextEncoder().encode('ok\n'))

        await writeActiveGenerationName(dealDir, generationName)
        await cleanupInactiveGenerations(dealDir, generationName)
    } catch (e) {
        await removeEntryIfExists(generationsDir, generationName, true)
        throw e
    }
}

export async function writeManifestRoot(dealId: string, manifestRoot: string): Promise<void> {
    const normalized = String(manifestRoot || '').trim();
    await writeBlob(dealId, 'manifest_root.txt', new TextEncoder().encode(normalized));
}

export async function writeManifestBlob(
    dealId: string,
    manifestBlob: Uint8Array,
    fullSize?: number,
): Promise<void> {
    await writeArtifact(dealId, 'manifest.bin', { kind: 'manifest', bytes: manifestBlob, fullSize });
}

export async function readManifestBlob(dealId: string): Promise<Uint8Array | null> {
    return await readArtifact(dealId, 'manifest.bin');
}

export async function readManifestRoot(dealId: string): Promise<string | null> {
    const bytes = await readBlob(dealId, 'manifest_root.txt');
    if (!bytes) return null;
    const txt = new TextDecoder().decode(bytes);
    const trimmed = txt.trim();
    return trimmed ? trimmed : null;
}

function coerceNumber(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.floor(n)
}

function normalizeSlabMetadata(value: unknown): SlabMetadata | null {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>

    const schemaVersion = coerceNumber(raw.schema_version)
    const generationId = typeof raw.generation_id === 'string' ? raw.generation_id.trim() : ''
    const manifestRoot = typeof raw.manifest_root === 'string' ? raw.manifest_root.trim() : ''
    const source = typeof raw.source === 'string' ? raw.source.trim() : ''
    const createdAt = typeof raw.created_at === 'string' ? raw.created_at.trim() : ''
    const witnessMdus = coerceNumber(raw.witness_mdus)
    const userMdus = coerceNumber(raw.user_mdus)
    const totalMdus = coerceNumber(raw.total_mdus)
    const lastValidatedAt =
        raw.last_validated_at == null
            ? null
            : typeof raw.last_validated_at === 'string'
                ? raw.last_validated_at.trim()
                : null

    if (
        schemaVersion == null ||
        generationId === '' ||
        manifestRoot === '' ||
        source === '' ||
        createdAt === '' ||
        witnessMdus == null ||
        userMdus == null ||
        totalMdus == null
    ) {
        return null
    }
    if (totalMdus !== 1 + witnessMdus + userMdus) return null

    const fileRecords: SlabMetadataFileRecord[] = []
    if (Array.isArray(raw.file_records)) {
        for (const item of raw.file_records) {
            if (!item || typeof item !== 'object') continue
            const rec = item as Record<string, unknown>
            const path = typeof rec.path === 'string' ? rec.path.trim() : ''
            const startOffset = coerceNumber(rec.start_offset)
            const sizeBytes = coerceNumber(rec.size_bytes)
            const flags = coerceNumber(rec.flags)
            if (!path || startOffset == null || sizeBytes == null || flags == null) continue
            fileRecords.push({
                path,
                start_offset: startOffset,
                size_bytes: sizeBytes,
                flags,
            })
        }
    }

    let redundancy: SlabMetadataRedundancy | undefined
    if (raw.redundancy && typeof raw.redundancy === 'object') {
        const r = raw.redundancy as Record<string, unknown>
        const k = coerceNumber(r.k) ?? undefined
        const m = coerceNumber(r.m) ?? undefined
        const n = coerceNumber(r.n) ?? undefined
        if (k != null || m != null || n != null) {
            redundancy = { k, m, n }
        }
    }

    const dealIdRaw = raw.deal_id
    const dealId =
        typeof dealIdRaw === 'string'
            ? dealIdRaw.trim() || undefined
            : typeof dealIdRaw === 'number'
                ? Math.floor(dealIdRaw)
                : undefined

    const owner = typeof raw.owner === 'string' ? raw.owner.trim() : undefined

    return {
        schema_version: schemaVersion,
        generation_id: generationId,
        deal_id: dealId,
        manifest_root: manifestRoot,
        owner: owner || undefined,
        redundancy,
        source,
        created_at: createdAt,
        last_validated_at: lastValidatedAt,
        witness_mdus: witnessMdus,
        user_mdus: userMdus,
        total_mdus: totalMdus,
        file_records: fileRecords,
    }
}

export async function writeSlabMetadata(dealId: string, metadata: SlabMetadata): Promise<void> {
    const payload = JSON.stringify(metadata, null, 2)
    await writeBlob(dealId, SLAB_METADATA_FILE, new TextEncoder().encode(payload))
}

export async function readSlabMetadata(dealId: string): Promise<SlabMetadata | null> {
    const bytes = await readBlob(dealId, SLAB_METADATA_FILE)
    if (!bytes) return null
    try {
        const decoded = new TextDecoder().decode(bytes)
        const parsed = JSON.parse(decoded) as unknown
        return normalizeSlabMetadata(parsed)
    } catch {
        return null
    }
}

export async function deleteSlabMetadata(dealId: string): Promise<void> {
    await deleteDealFile(dealId, SLAB_METADATA_FILE)
}

export function cachedFileNameForPath(filePath: string): string {
    const normalized = String(filePath ?? '')
    const bytes = new TextEncoder().encode(normalized)
    const digest = sha256(bytes)
    return `filecache_${bytesToHex(digest)}.bin`
}

export async function writeCachedFile(dealId: string, filePath: string, data: Uint8Array): Promise<void> {
    await writeBlob(dealId, cachedFileNameForPath(filePath), data)
}

export async function readCachedFile(dealId: string, filePath: string): Promise<Uint8Array | null> {
    return await readBlob(dealId, cachedFileNameForPath(filePath))
}

export async function hasCachedFile(dealId: string, filePath: string): Promise<boolean> {
    const bytes = await readCachedFile(dealId, filePath)
    return !!bytes && bytes.byteLength > 0
}

export async function deleteCachedFile(dealId: string, filePath: string): Promise<void> {
    await deleteDealFile(dealId, cachedFileNameForPath(filePath))
}

export async function clearCachedFiles(dealId: string): Promise<void> {
    const files = await listDealFiles(dealId)
    const targets = files.filter((f) => f.startsWith('filecache_') && f.endsWith('.bin'))
    for (const name of targets) {
        await deleteDealFile(dealId, name)
    }
}
