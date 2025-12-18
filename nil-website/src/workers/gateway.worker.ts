// nil-website/src/workers/gateway.worker.ts

// This is a Web Worker script. It runs in its own global scope.

// Import the WASM module
// The `init` function loads the WASM binary.
// The `Mdu0Builder` and `NilWasm` classes are exposed by wasm-bindgen.
import init, { WasmMdu0Builder, NilWasm } from '../../public/wasm/nil_core.js';

let wasmInitialized = false;
let mdu0BuilderInstance: WasmMdu0Builder | null = null;
let nilWasmInstance: NilWasm | null = null;

async function initializeWasm() {
    if (!wasmInitialized) {
        // Assume nil_core_bg.wasm is in the same directory as nil_core.js
        await init(); 
        wasmInitialized = true;
    }
}

// Listen for messages from the main thread
self.onmessage = async (event) => {
    const { type, payload, id } = event.data;

    // Ensure WASM is loaded before processing messages
    await initializeWasm();

    try {
        let result;
        const collectTransferables = (val: unknown): Transferable[] => {
            const out: Transferable[] = [];
            const visit = (v: unknown) => {
                if (!v) return;
                if (v instanceof Uint8Array) {
                    out.push(v.buffer);
                    return;
                }
                if (Array.isArray(v)) {
                    for (const item of v) visit(item);
                    return;
                }
                if (typeof v === 'object') {
                    for (const vv of Object.values(v as Record<string, unknown>)) visit(vv);
                }
            };
            visit(val);
            return out;
        };

        switch (type) {
            case 'initNilWasm': {
                const { trustedSetupBytes } = payload;
                if (!trustedSetupBytes) throw new Error('Trusted setup bytes required for NilWasm initialization');
                nilWasmInstance = new NilWasm(trustedSetupBytes);
                result = 'NilWasm initialized';
                break;
            }
            case 'initMdu0Builder': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { maxUserMdus } = payload;
                mdu0BuilderInstance = new WasmMdu0Builder(BigInt(maxUserMdus)); 
                result = 'Mdu0Builder initialized';
                break;
            }
            case 'appendFileToMdu0': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                const { path, size, startOffset } = payload;
                mdu0BuilderInstance.append_file(path, BigInt(size), BigInt(startOffset));
                result = 'File appended to Mdu0';
                break;
            }
            case 'getMdu0Bytes': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                const bytes = mdu0BuilderInstance.bytes(); // This returns Uint8Array
                result = bytes;
                break;
            }
            case 'setMdu0Root': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                const { index, root } = payload; // root is Uint8Array (32 bytes)
                mdu0BuilderInstance.set_root(BigInt(index), root);
                result = 'Root set in Mdu0';
                break;
            }
            case 'getMdu0WitnessCount': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                result = mdu0BuilderInstance.get_witness_count();
                break;
            }
            case 'shardFile': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { data } = payload; // data is Uint8Array
                const commitResult = nilWasmInstance.commit_mdu(data);
                result = typeof commitResult === 'string' ? JSON.parse(commitResult) : commitResult;
                break;
            }
            case 'shardFileProgressive': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { data, batchBlobs } = payload as { data: Uint8Array; batchBlobs?: number };

                const BLOB_SIZE = 128 * 1024;
                const BLOBS_PER_MDU = 64;
                if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array');
                if (data.byteLength !== 8 * 1024 * 1024) throw new Error('MDU bytes must be exactly 8 MiB');

                const batch = Math.max(1, Math.min(16, Number(batchBlobs || 4)));
                const witnessFlat = new Uint8Array(BLOBS_PER_MDU * 48);
                let writeOffset = 0;

                for (let blobIndex = 0; blobIndex < BLOBS_PER_MDU; blobIndex += batch) {
                    const n = Math.min(batch, BLOBS_PER_MDU - blobIndex);
                    const start = blobIndex * BLOB_SIZE;
                    const end = (blobIndex + n) * BLOB_SIZE;

                    const blobBatch = data.subarray(start, end);
                    const commitmentsFlat = nilWasmInstance.commit_blobs(blobBatch) as unknown;
                    const commitmentsBytes =
                        commitmentsFlat instanceof Uint8Array ? commitmentsFlat : new Uint8Array(commitmentsFlat as ArrayBufferLike);

                    witnessFlat.set(commitmentsBytes, writeOffset);
                    writeOffset += commitmentsBytes.byteLength;

                    self.postMessage({
                        id,
                        type: 'progress',
                        payload: { kind: 'blob', done: blobIndex + n, total: BLOBS_PER_MDU },
                    });
                }

                const root = nilWasmInstance.compute_mdu_root(witnessFlat) as unknown;
                const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike);
                result = { witness_flat: witnessFlat, mdu_root: rootBytes };
                break;
            }
            case 'computeManifest': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { roots } = payload; // roots is Uint8Array (concatenated 32-byte roots)
                result = nilWasmInstance.compute_manifest(roots);
                break;
            }
            case 'computeMduRoot': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { witness } = payload; // witness is Uint8Array
                result = nilWasmInstance.compute_mdu_root(witness);
                break;
            }
            default:
                throw new Error(`Unknown message type: ${type}`);
        }
        const transferList = collectTransferables(result);
        // @ts-expect-error - TS definition for postMessage in worker might be ambiguous
        self.postMessage({ id, type: 'result', payload: result }, transferList);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        self.postMessage({ id, type: 'error', payload: message || 'Unknown worker error' });
    }
};
