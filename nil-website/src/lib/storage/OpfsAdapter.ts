// nil-website/src/lib/storage/OpfsAdapter.ts

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const SLAB_METADATA_FILE = 'slab_meta.json'

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
async function getDealDirectory(dealId: string): Promise<FileSystemDirectoryHandle> {
    const root = await getOpfsRoot();
    return root.getDirectoryHandle(`deal-${dealId}`, { create: true });
}

async function writeBlob(dealId: string, name: string, data: BlobPart | Uint8Array<ArrayBufferLike>): Promise<void> {
    const dealDir = await getDealDirectory(dealId);
    const fileHandle = await dealDir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    // NOTE: Newer TS DOM lib defines `BlobPart` in a way that rejects `Uint8Array<ArrayBufferLike>`
    // (because it might be backed by `SharedArrayBuffer`). For OPFS writes, we accept it and rely
    // on runtime support; tests exercise the path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writable.write(data as any);
    await writable.close();
}

async function readBlob(dealId: string, name: string): Promise<Uint8Array | null> {
    const dealDir = await getDealDirectory(dealId);
    try {
        const fileHandle = await dealDir.getFileHandle(name);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        return new Uint8Array(buffer);
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') {
            return null;
        }
        throw e;
    }
}

async function deleteDealFile(dealId: string, name: string): Promise<void> {
    const dealDir = await getDealDirectory(dealId);
    try {
        await dealDir.removeEntry(name);
    } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotFoundError') return;
        throw e;
    }
}

/**
 * Writes MDU data to a file within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @param mduIndex The index of the MDU (e.g., 0 for MDU #0).
 * @param data The Uint8Array containing the MDU's binary data.
 */
export async function writeMdu(dealId: string, mduIndex: number, data: Uint8Array): Promise<void> {
    const fileName = `mdu_${mduIndex}.bin`;
    await writeBlob(dealId, fileName, data);
}

export async function writeShard(dealId: string, mduIndex: number, slot: number, data: Uint8Array): Promise<void> {
    const fileName = `mdu_${mduIndex}_slot_${slot}.bin`;
    await writeBlob(dealId, fileName, data);
}

/**
 * Reads MDU data from a file within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @param mduIndex The index of the MDU to read.
 * @returns A Promise that resolves to the MDU data as Uint8Array, or null if not found.
 */
export async function readMdu(dealId: string, mduIndex: number): Promise<Uint8Array | null> {
    const fileName = `mdu_${mduIndex}.bin`;
    return await readBlob(dealId, fileName);
}

export async function readShard(dealId: string, mduIndex: number, slot: number): Promise<Uint8Array | null> {
    const fileName = `mdu_${mduIndex}_slot_${slot}.bin`;
    return await readBlob(dealId, fileName);
}

/**
 * Lists the names of files stored within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @returns A Promise that resolves to an array of file names.
 */
export async function listDealFiles(dealId: string): Promise<string[]> {
    const dealDir = await getDealDirectory(dealId);
    const fileNames: string[] = [];
    // @ts-expect-error - FileSystemDirectoryHandle is iterable
    for await (const entry of dealDir.values()) {
        if (entry.kind === 'file') {
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
        await root.removeEntry(`deal-${dealId}`, { recursive: true });
    } catch (e: unknown) {
        // If the directory doesn't exist, it's already "deleted", so just ignore the error.
        if (e instanceof Error && e.name === 'NotFoundError') {
            return;
        }
        throw e;
    }
}

export async function writeManifestRoot(dealId: string, manifestRoot: string): Promise<void> {
    const normalized = String(manifestRoot || '').trim();
    await writeBlob(dealId, 'manifest_root.txt', new TextEncoder().encode(normalized));
}

export async function writeManifestBlob(dealId: string, manifestBlob: Uint8Array): Promise<void> {
    await writeBlob(dealId, 'manifest.bin', manifestBlob);
}

export async function readManifestBlob(dealId: string): Promise<Uint8Array | null> {
    return await readBlob(dealId, 'manifest.bin');
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
