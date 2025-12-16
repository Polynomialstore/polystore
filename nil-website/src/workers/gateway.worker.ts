// nil-website/src/workers/gateway.worker.ts

// This is a Web Worker script. It runs in its own global scope.

// Import the WASM module
// The `init` function loads the WASM binary.
// The `Mdu0Builder` and `NilWasm` classes are exposed by wasm-bindgen.
import init, { WasmMdu0Builder, NilWasm } from '../../public/wasm/nil_core.js';

let wasmInitialized = false;
let mdu0BuilderInstance: WasmMdu0Builder | null = null;
let nilWasmInstance: NilWasm | null = null;

// Unique ID counter for messages
let nextMessageId = 0;
const pendingMessages = new Map<number, { resolve: (value: any) => void, reject: (reason?: any) => void }>();

// Function to send messages to the worker and await a response
function postWorkerMessage(worker: Worker, type: string, payload: any, transferables?: Transferable[]): Promise<any> {
    const id = nextMessageId++;
    return new Promise((resolve, reject) => {
        pendingMessages.set(id, { resolve, reject });
        worker.postMessage({ id, type, payload }, transferables || []);
    });
}


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
                const shardResult = nilWasmInstance.expand_file(data); // This returns JsValue (JSON)
                result = JSON.parse(shardResult); // Parse JsValue to JS object
                break;
            }
            default:
                throw new Error(`Unknown message type: ${type}`);
        }
        // If the result is a Uint8Array, transfer its buffer to avoid copying
        self.postMessage({ id, type: 'result', payload: result }, result instanceof Uint8Array ? [result.buffer] : undefined);
    } catch (error: any) {
        self.postMessage({ id, type: 'error', payload: error.message || 'Unknown worker error' });
    }
};
