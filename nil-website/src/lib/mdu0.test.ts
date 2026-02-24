import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { sanitizeNilfsRecordPath } from './nilfsPath'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type WasmMdu0BuilderLike = {
    append_file: (path: string, sizeBytes: bigint, startOffset: bigint) => void
    bytes: () => Uint8Array
}

async function loadNilCoreWasm(): Promise<null | { init: (args: unknown) => Promise<unknown>; WasmMdu0Builder: new (maxUserMdus: bigint) => WasmMdu0BuilderLike; wasmPath: string }> {
    const jsPath = path.resolve(__dirname, '../../public/wasm/nil_core.js')
    const wasmPath = path.resolve(__dirname, '../../public/wasm/nil_core_bg.wasm')
    try {
        await fs.access(jsPath)
        await fs.access(wasmPath)
    } catch {
        return null
    }

    const mod = (await import(pathToFileURL(jsPath).href)) as {
        default: (args: unknown) => Promise<unknown>
        WasmMdu0Builder: new (maxUserMdus: bigint) => WasmMdu0BuilderLike
    }
    return { init: mod.default, WasmMdu0Builder: mod.WasmMdu0Builder, wasmPath }
}

test('Mdu0Builder WASM', async (t) => {
    const wasm = await loadNilCoreWasm()
    if (!wasm) {
        t.skip('WASM artifacts not present (nil-website/public/wasm).')
        return
    }
    const wasmBuffer = await fs.readFile(wasm.wasmPath);
    await wasm.init({ module_or_path: wasmBuffer });

    const maxUserMdus = 100n;
    const mdu = new wasm.WasmMdu0Builder(maxUserMdus);

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

test('Mdu0Builder WASM rejects paths > 40 bytes (NilFS V1)', async (t) => {
    const wasm = await loadNilCoreWasm()
    if (!wasm) {
        t.skip('WASM artifacts not present (nil-website/public/wasm).')
        return
    }
    const wasmBuffer = await fs.readFile(wasm.wasmPath);
    await wasm.init({ module_or_path: wasmBuffer });

    const mdu = new wasm.WasmMdu0Builder(10n);
    const longName = 'x'.repeat(41);
    assert.throws(() => {
        mdu.append_file(longName, 1n, 0n);
    }, /path too long/i);
});

test('sanitizeNilfsRecordPath produces a path acceptable to Mdu0Builder', async (t) => {
    const wasm = await loadNilCoreWasm()
    if (!wasm) {
        t.skip('WASM artifacts not present (nil-website/public/wasm).')
        return
    }
    const wasmBuffer = await fs.readFile(wasm.wasmPath);
    await wasm.init({ module_or_path: wasmBuffer });

    const mdu = new wasm.WasmMdu0Builder(10n);
    const sanitized = sanitizeNilfsRecordPath('a/b/' + 'x'.repeat(200) + '.txt');
    assert.doesNotThrow(() => {
        mdu.append_file(sanitized, 1n, 0n);
    });
});
