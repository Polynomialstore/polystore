// nil-website/src/lib/storage/OpfsAdapter.ts

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

/**
 * Writes MDU data to a file within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @param mduIndex The index of the MDU (e.g., 0 for MDU #0).
 * @param data The Uint8Array containing the MDU's binary data.
 */
export async function writeMdu(dealId: string, mduIndex: number, data: Uint8Array): Promise<void> {
    const dealDir = await getDealDirectory(dealId);
    const fileName = `mdu_${mduIndex}.bin`;
    const fileHandle = await dealDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data as any);
    await writable.close();
}

/**
 * Reads MDU data from a file within a specific deal's OPFS directory.
 * @param dealId The ID of the deal.
 * @param mduIndex The index of the MDU to read.
 * @returns A Promise that resolves to the MDU data as Uint8Array, or null if not found.
 */
export async function readMdu(dealId: string, mduIndex: number): Promise<Uint8Array | null> {
    const dealDir = await getDealDirectory(dealId);
    const fileName = `mdu_${mduIndex}.bin`;
    try {
        const fileHandle = await dealDir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        return new Uint8Array(buffer);
    } catch (e: any) {
        // Return null if the file is not found, otherwise re-throw.
        if (e.name === 'NotFoundError') {
            return null;
        }
        throw e;
    }
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
    } catch (e: any) {
        // If the directory doesn't exist, it's already "deleted", so just ignore the error.
        if (e.name === 'NotFoundError') {
            return;
        }
        throw e;
    }
}
