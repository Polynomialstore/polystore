import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// @ts-expect-error
import init, { Mdu0 } from '../../public/wasm/nil_core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Mdu0Builder WASM', async () => {
    const wasmPath = path.resolve(__dirname, '../../public/wasm/nil_core_bg.wasm');
    const wasmBuffer = await fs.readFile(wasmPath);
    
    // Initialize WASM with the buffer
    await init(wasmBuffer);

    const maxUserMdus = 100n;
    const mdu = new Mdu0(maxUserMdus);

    // Test append
    const fileName = "test.txt";
    const fileSize = 1024n;
    const startOffset = 0n;
    
    mdu.append_file(fileName, fileSize, startOffset);

    // Get bytes
    const bytes = mdu.bytes();
    assert.strictEqual(bytes.length, 8 * 1024 * 1024, "MDU size should be 8MB");

    // Verify magic "NILF" at start of File Table (16 * 128KB = 2097152)
    const magicOffset = 16 * 128 * 1024;
    const magic = new TextDecoder().decode(bytes.slice(magicOffset, magicOffset + 4));
    assert.strictEqual(magic, "NILF", "Magic mismatch");

    // Verify Record Count (at magicOffset + 8)
    // record_count is u32 little endian
    const recordCountOffset = magicOffset + 8;
    const recordCount = new DataView(bytes.buffer).getUint32(recordCountOffset, true);
    assert.strictEqual(recordCount, 1, "Record count mismatch");
    
    // Verify File Record (at magicOffset + 128)
    const recordOffset = magicOffset + 128;
    // StartOffset (u64)
    const readStartOffset = new DataView(bytes.buffer).getBigUint64(recordOffset, true);
    assert.strictEqual(readStartOffset, startOffset, "Start offset mismatch");
    
    // Path (at recordOffset + 24)
    // Path is 40 bytes null terminated
    const pathBytes = bytes.slice(recordOffset + 24, recordOffset + 64);
    // find null terminator
    let nullIdx = pathBytes.indexOf(0);
    if (nullIdx === -1) nullIdx = pathBytes.length;
    const readPath = new TextDecoder().decode(pathBytes.slice(0, nullIdx));
    assert.strictEqual(readPath, fileName, "Path mismatch");
});
