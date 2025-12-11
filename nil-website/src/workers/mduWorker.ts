// Web Worker for nil_core WASM operations
// Assumes wasm-pack output is located at /public/wasm/nil_core.js

// We declare globals for the WASM module since it's loaded dynamically
let wasmModule: any;
let nilWasm: any;

self.onmessage = async (e: MessageEvent) => {
    const { type, payload } = e.data;

    try {
        if (type === 'INIT') {
            // payload: trusted_setup_bytes (Uint8Array)
            
            // 1. Import the WASM JS wrapper
            // Note: In Vite dev, direct import from /public might need special handling
            // But standard dynamic import works for static assets usually.
            const wasmUrl = new URL('/wasm/nil_core.js', import.meta.url).toString();
            // Vite keeps /public assets at root, so we explicitly ignore bundler resolution here.
            // @ts-ignore - module typing is provided in src/types/wasm.d.ts
            wasmModule = await import(/* @vite-ignore */ wasmUrl);
            
            // 2. Initialize WASM memory
            await wasmModule.default(); 
            
            // 3. Create Context
            nilWasm = new wasmModule.NilWasm(payload);
            
            self.postMessage({ type: 'INIT_SUCCESS' });
            
        } else if (type === 'EXPAND') {
            // payload: file chunk bytes (Uint8Array, 8MB)
            if (!nilWasm) throw new Error('WASM not initialized');
            
            const result = nilWasm.expand_file(payload);
            self.postMessage({ type: 'EXPAND_SUCCESS', payload: result });
        }
    } catch (err: any) {
        console.error("Worker Error:", err);
        self.postMessage({ type: 'ERROR', payload: err.message || String(err) });
    }
};
