// nil-website/src/workers/gateway.worker.ts

// This is a Web Worker script. It runs in its own global scope.

// Import the WASM module
// The `init` function loads the WASM binary.
// The `Mdu0Builder` and `NilWasm` classes are exposed by wasm-bindgen.
import init, { WasmMdu0Builder, NilWasm } from '../../public/wasm/nil_core.js';

let wasmInitialized = false;
let wasmInitPromise: Promise<void> | null = null;
let wasmInitError: unknown = null;
let mdu0BuilderInstance: WasmMdu0Builder | null = null;
let nilWasmInstance: NilWasm | null = null;

type CommitWorkerPending = {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
};

let commitWorkers: Worker[] = [];
let commitWorkersReady: Promise<void> | null = null;
const commitPending = new Map<number, CommitWorkerPending>();
let commitNextMessageId = 1;
let commitRoundRobin = 0;
const commitPendingByWorker = new Map<Worker, Set<number>>();

function initializeWasm(): Promise<void> {
    if (wasmInitialized) return Promise.resolve();
    if (wasmInitError) return Promise.reject(wasmInitError);
    if (wasmInitPromise) return wasmInitPromise;

    const wasmUrl = new URL('/wasm/nil_core_bg.wasm', self.location.origin);
    wasmInitPromise = (async () => {
        await init(wasmUrl);
        wasmInitialized = true;
    })().catch((err) => {
        wasmInitError = err;
        throw err;
    });

    return wasmInitPromise;
}

function initializeCommitPool(trustedSetupBytes: Uint8Array): Promise<void> {
    if (commitWorkersReady) return commitWorkersReady;

    const hc = (self as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
    const desired = Math.max(1, Math.min(4, Math.max(0, Number(hc) - 1) || 1));
    if (desired <= 1) {
        commitWorkers = [];
        commitWorkersReady = Promise.resolve();
        return commitWorkersReady;
    }

    commitWorkersReady = (async () => {
        const workers: Worker[] = [];
        try {
            for (let i = 0; i < desired; i++) {
                const w = new Worker(new URL('./commit.worker.ts', import.meta.url), { type: 'module' });
                commitPendingByWorker.set(w, new Set());
                w.onmessage = (event) => {
                    const { id, type, payload } = event.data;
                    commitPendingByWorker.get(w)?.delete(id);
                    const pending = commitPending.get(id);
                    if (!pending) return;
                    if (type === 'result') {
                        pending.resolve(payload as Uint8Array);
                    } else if (type === 'error') {
                        pending.reject(new Error(String(payload)));
                    } else {
                        pending.reject(new Error(`Unknown commit worker response: ${String(type)}`));
                    }
                    commitPending.delete(id);
                };
                w.onerror = (err) => {
                    console.warn('Commit worker error:', err);
                    const ids = commitPendingByWorker.get(w);
                    if (ids) {
                        for (const id of ids) {
                            commitPending.get(id)?.reject(new Error('Commit worker crashed'));
                            commitPending.delete(id);
                        }
                        commitPendingByWorker.delete(w);
                    }
                    commitWorkers = commitWorkers.filter((ww) => ww !== w);
                };
                workers.push(w);
            }
        } catch (e) {
            console.warn('Failed to spawn commit worker pool; continuing single-threaded.', e);
            commitWorkers = [];
            return;
        }

        const initPromises = workers.map((w) => {
            const id = commitNextMessageId++;
            const setupCopy = trustedSetupBytes.slice();
            return new Promise<void>((resolve, reject) => {
                commitPending.set(id, {
                    resolve: () => resolve(),
                    reject,
                });
                w.postMessage({ id, type: 'initNilWasm', payload: { trustedSetupBytes: setupCopy } }, [setupCopy.buffer]);
            });
        });

        await Promise.all(initPromises);
        commitWorkers = workers;
    })();

    return commitWorkersReady;
}

function commitBlobsWithPool(data: Uint8Array): Promise<Uint8Array> {
    if (!commitWorkers || commitWorkers.length === 0) {
        if (!nilWasmInstance) return Promise.reject(new Error('NilWasm not initialized'));
        const commitments = nilWasmInstance.commit_blobs(data) as unknown;
        const bytes = commitments instanceof Uint8Array ? commitments : new Uint8Array(commitments as ArrayBufferLike);
        return Promise.resolve(bytes);
    }

    const w = commitWorkers[commitRoundRobin % commitWorkers.length];
    commitRoundRobin += 1;

    const id = commitNextMessageId++;
    return new Promise<Uint8Array>((resolve, reject) => {
        commitPending.set(id, {
            resolve: (val) => resolve(val as Uint8Array),
            reject,
        });
        commitPendingByWorker.get(w)?.add(id);
        w.postMessage({ id, type: 'commitBlobs', payload: { data } }, [data.buffer]);
    });
}

// Start fetching + compiling the WASM as soon as the worker loads so the first
// request message doesn't pay the full initialization latency.
void initializeWasm();

// Listen for messages from the main thread
self.onmessage = async (event) => {
    const { type, payload, id } = event.data;

    try {
        // Ensure WASM is loaded before processing messages
        await initializeWasm();

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
                if (nilWasmInstance) {
                    result = 'NilWasm already initialized';
                    break;
                }
                if (!trustedSetupBytes) throw new Error('Trusted setup bytes required for NilWasm initialization');
                nilWasmInstance = new NilWasm(trustedSetupBytes);
                // Initialize the blob-commit compute pool (best-effort).
                try {
                    await initializeCommitPool(trustedSetupBytes);
                } catch (e) {
                    console.warn('Commit worker pool init failed; continuing single-threaded.', e);
                    commitWorkers = [];
                    commitWorkersReady = Promise.resolve();
                }
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
                const concurrency = Math.max(1, commitWorkers.length || 1);
                let completedBlobs = 0;

                const inFlight = new Set<Promise<void>>();
                const enqueue = (p: Promise<void>) => {
                    inFlight.add(p);
                    p.finally(() => inFlight.delete(p)).catch(() => {});
                };

                for (let blobIndex = 0; blobIndex < BLOBS_PER_MDU; blobIndex += batch) {
                    while (inFlight.size >= concurrency) {
                        await Promise.race(Array.from(inFlight));
                    }

                    const n = Math.min(batch, BLOBS_PER_MDU - blobIndex);
                    const start = blobIndex * BLOB_SIZE;
                    const end = (blobIndex + n) * BLOB_SIZE;

                    // Copy to a dedicated buffer so we can transfer it to a pool worker.
                    const blobBatch = data.slice(start, end);
                    const task = (async () => {
                        const commitmentsBytes = await commitBlobsWithPool(blobBatch);
                        witnessFlat.set(commitmentsBytes, blobIndex * 48);
                        completedBlobs += n;
                        self.postMessage({
                            id,
                            type: 'progress',
                            payload: { kind: 'blob', done: completedBlobs, total: BLOBS_PER_MDU },
                        });
                    })();

                    enqueue(task);
                }

                if (inFlight.size > 0) {
                    await Promise.all(Array.from(inFlight));
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
