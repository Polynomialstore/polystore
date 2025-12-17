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
        // If the result is a Uint8Array, transfer its buffer to avoid copying
        const transferList = result instanceof Uint8Array ? [result.buffer] : [];
        // @ts-expect-error - TS definition for postMessage in worker might be ambiguous
        self.postMessage({ id, type: 'result', payload: result }, transferList);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        self.postMessage({ id, type: 'error', payload: message || 'Unknown worker error' });
    }
};
