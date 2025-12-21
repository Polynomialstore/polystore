// nil-website/src/lib/storage/OpfsAdapter.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as OpfsAdapter from './OpfsAdapter';

// Mock the FileSystem API for Node.js environment
// This mock simulates the behavior of FileSystemDirectoryHandle and FileSystemFileHandle
// and stores content in a simple in-memory map.

class MockFileSystemFileHandle {
    name: string;
    readonly kind = 'file' as const;
    private content: Uint8Array | null = null;

    constructor(name: string, initialContent: Uint8Array | null = null) {
        this.name = name;
        this.content = initialContent;
    }

    async getFile() {
        return {
            name: this.name,
            arrayBuffer: async () => this.content?.buffer || new ArrayBuffer(0),
            size: this.content?.length || 0,
            type: 'application/octet-stream',
            lastModified: Date.now(),
            text: async () => new TextDecoder().decode(this.content || new Uint8Array()),
        };
    }

    async createWritable() {
        // Return a mock WritableStream object
        return {
            write: async (data: Uint8Array) => {
                this.content = data;
            },
            close: async () => {},
        };
    }
}

class MockFileSystemDirectoryHandle {
    name: string;
    readonly kind = 'directory' as const;
    entries: Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>;

    constructor(name: string) {
        this.name = name;
        this.entries = new Map();
    }

    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockFileSystemDirectoryHandle> {
        if (!this.entries.has(name)) {
            if (options?.create) {
                this.entries.set(name, new MockFileSystemDirectoryHandle(name));
            } else {
                const err = new Error('Directory not found');
                err.name = 'NotFoundError';
                throw err;
            }
        }
        const handle = this.entries.get(name);
        if (handle && handle.kind === 'directory') {
            return handle as MockFileSystemDirectoryHandle;
        }
        const err = new Error('Entry is not a directory');
        err.name = 'TypeMismatchError';
        throw err;
    }

    async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileSystemFileHandle> {
        if (!this.entries.has(name)) {
            if (options?.create) {
                this.entries.set(name, new MockFileSystemFileHandle(name));
            } else {
                const err = new Error('File not found');
                err.name = 'NotFoundError';
                throw err;
            }
        }
        const handle = this.entries.get(name);
        if (handle && handle.kind === 'file') {
            return handle as MockFileSystemFileHandle;
        }
        const err = new Error('Entry is not a file');
        err.name = 'TypeMismatchError';
        throw err;
    }

    async *values(): AsyncIterableIterator<MockFileSystemDirectoryHandle | MockFileSystemFileHandle> {
        for (const entry of this.entries.values()) {
            yield entry;
        }
    }

    async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
        if (!this.entries.has(name)) {
            const err = new Error('Entry not found');
            err.name = 'NotFoundError';
            throw err;
        }
        const entry = this.entries.get(name);
        if (entry && entry.kind === 'directory' && entry.entries.size > 0 && !options?.recursive) {
            const err = new Error('Directory not empty');
            err.name = 'InvalidModificationError'; // Standard DOMException for this case
            throw err;
        }
        this.entries.delete(name);
    }
}

const mockRootDirectoryHandle = new MockFileSystemDirectoryHandle('root-opfs');

// Mock navigator.storage.getDirectory
Object.defineProperty(global, 'navigator', {
    value: {
        storage: {
            getDirectory: async () => mockRootDirectoryHandle,
        },
    },
    configurable: true,
    writable: true,
});

// Reset mock before each test
test.beforeEach(() => {
    mockRootDirectoryHandle.entries.clear();
});

test('OpfsAdapter: writeMdu and readMdu', async () => {
    const dealId = 'test-deal-write-read';
    const mduIndex = 0;
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    await OpfsAdapter.writeMdu(dealId, mduIndex, data);

    const readData = await OpfsAdapter.readMdu(dealId, mduIndex);
    assert.deepStrictEqual(readData, data, 'Read data should match written data');
});

test('OpfsAdapter: writeShard and readShard', async () => {
    const dealId = 'test-deal-write-read-shard';
    const mduIndex = 42;
    const slot = 7;
    const data = new Uint8Array([9, 8, 7, 6]);

    await OpfsAdapter.writeShard(dealId, mduIndex, slot, data);

    const readData = await OpfsAdapter.readShard(dealId, mduIndex, slot);
    assert.deepStrictEqual(readData, data, 'Read shard should match written shard');
});

test('OpfsAdapter: writeManifestBlob and readManifestBlob', async () => {
    const dealId = 'test-deal-manifest-blob';
    const blob = new Uint8Array([0xaa, 0xbb, 0xcc]);

    await OpfsAdapter.writeManifestBlob(dealId, blob);

    const readBlob = await OpfsAdapter.readManifestBlob(dealId);
    assert.deepStrictEqual(readBlob, blob, 'Read manifest blob should match written manifest blob');
});

test('OpfsAdapter: readMdu returns null for non-existent file', async () => {
    const dealId = 'test-deal-non-existent';
    const mduIndex = 1;

    const readData = await OpfsAdapter.readMdu(dealId, mduIndex);
    assert.strictEqual(readData, null, 'Reading non-existent file should return null');
});

test('OpfsAdapter: listDealFiles', async () => {
    const dealId = 'test-deal-list-files';
    await OpfsAdapter.writeMdu(dealId, 0, new Uint8Array([10]));
    await OpfsAdapter.writeMdu(dealId, 1, new Uint8Array([20]));
    // Also create a nested directory to ensure it's not listed as a file
    const dealDir = await mockRootDirectoryHandle.getDirectoryHandle(`deal-${dealId}`);
    await dealDir.getDirectoryHandle('subdir', { create: true });

    const files = await OpfsAdapter.listDealFiles(dealId);
    assert.deepStrictEqual(files.sort(), ['mdu_0.bin', 'mdu_1.bin'].sort(), 'Should list all files in deal directory');
});

    test('OpfsAdapter: deleteDealDirectory', async () => {
    const dealId = 'test-deal-delete';
    await OpfsAdapter.writeMdu(dealId, 0, new Uint8Array([100]));
    await OpfsAdapter.writeMdu(dealId, 1, new Uint8Array([200]));

    const filesBeforeDelete = await OpfsAdapter.listDealFiles(dealId);    assert.strictEqual(filesBeforeDelete.length > 0, true, 'Directory should have files before deletion');

    await OpfsAdapter.deleteDealDirectory(dealId);

    const readData = await OpfsAdapter.readMdu(dealId, 0);
    assert.strictEqual(readData, null, 'Files should not exist after directory deletion');

    const filesAfterDelete = await OpfsAdapter.listDealFiles(dealId);
    assert.deepStrictEqual(filesAfterDelete, [], 'Directory should be empty after deletion');
});

test('OpfsAdapter: delete non-existent directory', async () => {
    const dealId = 'test-deal-delete-non-existent';
    // Should not throw an error
    await OpfsAdapter.deleteDealDirectory(dealId);
    assert.ok(true, 'Deleting a non-existent directory should not throw an error');
});

test('OpfsAdapter: cached file write/read/clear', async () => {
    const dealId = 'test-deal-cache';
    const filePathA = 'a.txt';
    const filePathB = 'b.txt';
    const dataA = new Uint8Array([1, 2, 3]);
    const dataB = new Uint8Array([4, 5, 6, 7]);

    assert.strictEqual(await OpfsAdapter.hasCachedFile(dealId, filePathA), false);

    await OpfsAdapter.writeCachedFile(dealId, filePathA, dataA);
    await OpfsAdapter.writeCachedFile(dealId, filePathB, dataB);

    assert.deepStrictEqual(await OpfsAdapter.readCachedFile(dealId, filePathA), dataA);
    assert.deepStrictEqual(await OpfsAdapter.readCachedFile(dealId, filePathB), dataB);
    assert.strictEqual(await OpfsAdapter.hasCachedFile(dealId, filePathA), true);

    await OpfsAdapter.deleteCachedFile(dealId, filePathA);
    assert.strictEqual(await OpfsAdapter.hasCachedFile(dealId, filePathA), false);
    assert.deepStrictEqual(await OpfsAdapter.readCachedFile(dealId, filePathA), null);
    assert.strictEqual(await OpfsAdapter.hasCachedFile(dealId, filePathB), true);

    // Cached file clearing should not delete MDUs.
    await OpfsAdapter.writeMdu(dealId, 0, new Uint8Array([9]));
    await OpfsAdapter.clearCachedFiles(dealId);
    assert.strictEqual(await OpfsAdapter.hasCachedFile(dealId, filePathB), false);
    assert.deepStrictEqual(await OpfsAdapter.readMdu(dealId, 0), new Uint8Array([9]));
});
