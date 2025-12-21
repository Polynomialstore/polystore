// nil-website/src/lib/storage/OpfsAdapter.ts

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

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
    await writeBlob(dealId, 'manifest_root.txt', normalized);
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
