// nil-website/src/workers/gateway.worker.ts

// This is a Web Worker script. It runs in its own global scope.

// Import the WASM module
// The `init` function loads the WASM binary.
// The `Mdu0Builder` and `NilWasm` classes are exposed by wasm-bindgen.
import init, { WasmMdu0Builder, NilWasm } from '../lib/nilCoreRuntime.js';

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
        await init({ module_or_path: wasmUrl });
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
            const seen = new Set<Transferable>();
            const visit = (v: unknown) => {
                if (!v) return;
                if (v instanceof Uint8Array) {
                    if (!seen.has(v.buffer)) {
                        seen.add(v.buffer);
                        out.push(v.buffer);
                    }
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
                const { maxUserMdus, commitmentsPerMdu } = payload as { maxUserMdus: number; commitmentsPerMdu?: number };
                if (commitmentsPerMdu && Number(commitmentsPerMdu) > 0) {
                    mdu0BuilderInstance = WasmMdu0Builder.new_with_commitments(
                        BigInt(maxUserMdus),
                        BigInt(commitmentsPerMdu),
                    );
                } else {
                    mdu0BuilderInstance = new WasmMdu0Builder(BigInt(maxUserMdus));
                }
                result = 'Mdu0Builder initialized';
                break;
            }
            case 'loadMdu0Builder': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { data, maxUserMdus, commitmentsPerMdu } = payload as {
                    data: Uint8Array;
                    maxUserMdus: number;
                    commitmentsPerMdu?: number;
                };
                if (!(data instanceof Uint8Array)) throw new Error('MDU0 data must be a Uint8Array');
                const commitments = commitmentsPerMdu && Number(commitmentsPerMdu) > 0 ? commitmentsPerMdu : 0;
                mdu0BuilderInstance = WasmMdu0Builder.load(data, BigInt(maxUserMdus), BigInt(commitments));
                result = 'Mdu0Builder loaded';
                break;
            }
            case 'appendFileToMdu0': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                const { path, size, startOffset, flags } = payload as {
                    path: string;
                    size: number;
                    startOffset: number;
                    flags?: number;
                };
                const flagValue = typeof flags === 'number' ? flags : 0;
                if (typeof (mdu0BuilderInstance as WasmMdu0Builder).append_file_with_flags === 'function') {
                    mdu0BuilderInstance.append_file_with_flags(path, BigInt(size), BigInt(startOffset), flagValue);
                } else {
                    mdu0BuilderInstance.append_file(path, BigInt(size), BigInt(startOffset));
                }
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
            case 'setMdu0RootsBatch': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                const { startIndex, rootsFlat } = payload as { startIndex: number; rootsFlat: Uint8Array };
                if (!(rootsFlat instanceof Uint8Array)) throw new Error('rootsFlat must be a Uint8Array');
                if (rootsFlat.byteLength % 32 !== 0) throw new Error('rootsFlat must be a multiple of 32 bytes');
                let rootIndex = Number(startIndex);
                for (let offset = 0; offset < rootsFlat.byteLength; offset += 32, rootIndex += 1) {
                    mdu0BuilderInstance.set_root(BigInt(rootIndex), rootsFlat.subarray(offset, offset + 32));
                }
                result = 'Roots set in Mdu0';
                break;
            }
            case 'prepareMdu0Bytes': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                const {
                    witnessRootsFlat,
                    userRootStartIndex,
                    userRootsFlat,
                    path,
                    size,
                    startOffset,
                    flags,
                } = payload as {
                    witnessRootsFlat?: Uint8Array;
                    userRootStartIndex: number;
                    userRootsFlat?: Uint8Array;
                    path: string;
                    size: number;
                    startOffset: number;
                    flags?: number;
                };
                const perf = {
                    witnessRootSetMs: 0,
                    userRootSetMs: 0,
                    appendMs: 0,
                    bytesMs: 0,
                    totalMs: 0,
                };
                const totalStart = performance.now();

                if (witnessRootsFlat) {
                    if (!(witnessRootsFlat instanceof Uint8Array)) throw new Error('witnessRootsFlat must be a Uint8Array');
                    if (witnessRootsFlat.byteLength % 32 !== 0) throw new Error('witnessRootsFlat must be a multiple of 32 bytes');
                    const start = performance.now();
                    let rootIndex = 0;
                    for (let offset = 0; offset < witnessRootsFlat.byteLength; offset += 32, rootIndex += 1) {
                        mdu0BuilderInstance.set_root(BigInt(rootIndex), witnessRootsFlat.subarray(offset, offset + 32));
                    }
                    perf.witnessRootSetMs = performance.now() - start;
                }

                if (userRootsFlat) {
                    if (!(userRootsFlat instanceof Uint8Array)) throw new Error('userRootsFlat must be a Uint8Array');
                    if (userRootsFlat.byteLength % 32 !== 0) throw new Error('userRootsFlat must be a multiple of 32 bytes');
                    const start = performance.now();
                    let rootIndex = Number(userRootStartIndex);
                    for (let offset = 0; offset < userRootsFlat.byteLength; offset += 32, rootIndex += 1) {
                        mdu0BuilderInstance.set_root(BigInt(rootIndex), userRootsFlat.subarray(offset, offset + 32));
                    }
                    perf.userRootSetMs = performance.now() - start;
                }

                const appendStart = performance.now();
                const flagValue = typeof flags === 'number' ? flags : 0;
                if (typeof (mdu0BuilderInstance as WasmMdu0Builder).append_file_with_flags === 'function') {
                    mdu0BuilderInstance.append_file_with_flags(path, BigInt(size), BigInt(startOffset), flagValue);
                } else {
                    mdu0BuilderInstance.append_file(path, BigInt(size), BigInt(startOffset));
                }
                perf.appendMs = performance.now() - appendStart;

                const bytesStart = performance.now();
                const mdu0Bytes = mdu0BuilderInstance.bytes();
                perf.bytesMs = performance.now() - bytesStart;
                perf.totalMs = performance.now() - totalStart;

                result = {
                    mdu0_bytes: mdu0Bytes,
                    perf,
                };
                break;
            }
            case 'prepareAndCommitMdu0': {
                if (!mdu0BuilderInstance) throw new Error('Mdu0Builder not initialized');
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const {
                    witnessRootsFlat,
                    userRootStartIndex,
                    userRootsFlat,
                    path,
                    size,
                    startOffset,
                    flags,
                } = payload as {
                    witnessRootsFlat?: Uint8Array;
                    userRootStartIndex: number;
                    userRootsFlat?: Uint8Array;
                    path: string;
                    size: number;
                    startOffset: number;
                    flags?: number;
                };
                const perf = {
                    witnessRootSetMs: 0,
                    userRootSetMs: 0,
                    appendMs: 0,
                    bytesMs: 0,
                    prepareBuilderMs: 0,
                    commitMs: 0,
                    rootMs: 0,
                    totalMs: 0,
                    rustCommitDecodeMs: 0,
                    rustCommitTransformMs: 0,
                    rustCommitMsmScalarPrepMs: 0,
                    rustCommitMsmBucketFillMs: 0,
                    rustCommitMsmReduceMs: 0,
                    rustCommitMsmDoubleMs: 0,
                    rustCommitMsmMs: 0,
                    rustCommitCompressMs: 0,
                    rustCommitMs: 0,
                    rustCommitBackend: 'blst',
                    rustCommitMsmSubphasesAvailable: false,
                };
                const totalStart = performance.now();

                if (witnessRootsFlat) {
                    if (!(witnessRootsFlat instanceof Uint8Array)) throw new Error('witnessRootsFlat must be a Uint8Array');
                    if (witnessRootsFlat.byteLength % 32 !== 0) throw new Error('witnessRootsFlat must be a multiple of 32 bytes');
                    const start = performance.now();
                    let rootIndex = 0;
                    for (let offset = 0; offset < witnessRootsFlat.byteLength; offset += 32, rootIndex += 1) {
                        mdu0BuilderInstance.set_root(BigInt(rootIndex), witnessRootsFlat.subarray(offset, offset + 32));
                    }
                    perf.witnessRootSetMs = performance.now() - start;
                }

                if (userRootsFlat) {
                    if (!(userRootsFlat instanceof Uint8Array)) throw new Error('userRootsFlat must be a Uint8Array');
                    if (userRootsFlat.byteLength % 32 !== 0) throw new Error('userRootsFlat must be a multiple of 32 bytes');
                    const start = performance.now();
                    let rootIndex = Number(userRootStartIndex);
                    for (let offset = 0; offset < userRootsFlat.byteLength; offset += 32, rootIndex += 1) {
                        mdu0BuilderInstance.set_root(BigInt(rootIndex), userRootsFlat.subarray(offset, offset + 32));
                    }
                    perf.userRootSetMs = performance.now() - start;
                }

                const appendStart = performance.now();
                const flagValue = typeof flags === 'number' ? flags : 0;
                if (typeof (mdu0BuilderInstance as WasmMdu0Builder).append_file_with_flags === 'function') {
                    mdu0BuilderInstance.append_file_with_flags(path, BigInt(size), BigInt(startOffset), flagValue);
                } else {
                    mdu0BuilderInstance.append_file(path, BigInt(size), BigInt(startOffset));
                }
                perf.appendMs = performance.now() - appendStart;

                const bytesStart = performance.now();
                const mdu0Bytes = mdu0BuilderInstance.bytes();
                perf.bytesMs = performance.now() - bytesStart;
                perf.prepareBuilderMs =
                    perf.witnessRootSetMs + perf.userRootSetMs + perf.appendMs + perf.bytesMs;

                const commitStart = performance.now();
                const committedRaw = nilWasmInstance.commit_blobs_profiled(mdu0Bytes) as {
                    witness_flat?: Uint8Array | ArrayBufferLike;
                    perf?: {
                        decode_ms?: unknown;
                        transform_ms?: unknown;
                        msm_scalar_prep_ms?: unknown;
                        msm_bucket_fill_ms?: unknown;
                        msm_reduce_ms?: unknown;
                        msm_double_ms?: unknown;
                        msm_ms?: unknown;
                        compress_ms?: unknown;
                        total_ms?: unknown;
                    };
                };
                perf.commitMs = performance.now() - commitStart;
                const witnessRaw = committedRaw?.witness_flat;
                if (!witnessRaw) {
                    throw new Error('commit_blobs_profiled returned no witness bytes');
                }
                const witnessFlat =
                    witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike);
                const commitPerf = committedRaw?.perf;
                perf.rustCommitDecodeMs = Number(commitPerf?.decode_ms ?? 0);
                perf.rustCommitTransformMs = Number(commitPerf?.transform_ms ?? 0);
                perf.rustCommitMsmScalarPrepMs = Number(commitPerf?.msm_scalar_prep_ms ?? 0);
                perf.rustCommitMsmBucketFillMs = Number(commitPerf?.msm_bucket_fill_ms ?? 0);
                perf.rustCommitMsmReduceMs = Number(commitPerf?.msm_reduce_ms ?? 0);
                perf.rustCommitMsmDoubleMs = Number(commitPerf?.msm_double_ms ?? 0);
                perf.rustCommitMsmMs = Number(commitPerf?.msm_ms ?? 0);
                perf.rustCommitCompressMs = Number(commitPerf?.compress_ms ?? 0);
                perf.rustCommitMs = Number(commitPerf?.total_ms ?? perf.commitMs);

                const rootStart = performance.now();
                const root = nilWasmInstance.compute_mdu_root(witnessFlat) as unknown;
                perf.rootMs = performance.now() - rootStart;
                const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike);
                perf.totalMs = performance.now() - totalStart;

                result = {
                    mdu0_bytes: mdu0Bytes,
                    mdu_root: rootBytes,
                    perf,
                };
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
                let commitMs = 0;
                const opStart = performance.now();

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
                        const commitStart = performance.now();
                        const commitmentsBytes = await commitBlobsWithPool(blobBatch);
                        commitMs += performance.now() - commitStart;
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

                const rootStart = performance.now();
                const root = nilWasmInstance.compute_mdu_root(witnessFlat) as unknown;
                const rootMs = performance.now() - rootStart;
                const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike);
                result = {
                    witness_flat: witnessFlat,
                    mdu_root: rootBytes,
                    perf: {
                        commitMs,
                        rootMs,
                        totalMs: performance.now() - opStart,
                        batchCount: Math.ceil(BLOBS_PER_MDU / batch),
                        batchSize: batch,
                        blobCount: BLOBS_PER_MDU,
                    },
                };
                break;
            }
            case 'commitMduProfiled': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { data } = payload as { data: Uint8Array };
                const BLOBS_PER_MDU = 64;
                if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array');
                if (data.byteLength !== 8 * 1024 * 1024) throw new Error('MDU bytes must be exactly 8 MiB');

                const opStart = performance.now();
                const commitStart = performance.now();
                const committedRaw = nilWasmInstance.commit_blobs_profiled(data) as {
                    witness_flat?: Uint8Array | ArrayBufferLike;
                    perf?: {
                        decode_ms?: unknown;
                        transform_ms?: unknown;
                        msm_scalar_prep_ms?: unknown;
                        msm_bucket_fill_ms?: unknown;
                        msm_reduce_ms?: unknown;
                        msm_double_ms?: unknown;
                        msm_ms?: unknown;
                        compress_ms?: unknown;
                        total_ms?: unknown;
                        blobs?: unknown;
                    };
                };
                const commitMs = performance.now() - commitStart;
                const witnessRaw = committedRaw?.witness_flat;
                if (!witnessRaw) {
                    throw new Error('commit_blobs_profiled returned no witness bytes');
                }
                const witnessFlat =
                    witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike);
                const commitPerf = committedRaw?.perf;

                const rootStart = performance.now();
                const root = nilWasmInstance.compute_mdu_root(witnessFlat) as unknown;
                const rootMs = performance.now() - rootStart;
                const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike);
                result = {
                    witness_flat: witnessFlat,
                    mdu_root: rootBytes,
                    perf: {
                        commitMs,
                        rootMs,
                        totalMs: performance.now() - opStart,
                        blobCount: BLOBS_PER_MDU,
                        batchCount: 1,
                        batchSize: BLOBS_PER_MDU,
                        rustCommitDecodeMs: Number(commitPerf?.decode_ms ?? 0),
                        rustCommitTransformMs: Number(commitPerf?.transform_ms ?? 0),
                        rustCommitMsmScalarPrepMs: Number(commitPerf?.msm_scalar_prep_ms ?? 0),
                        rustCommitMsmBucketFillMs: Number(commitPerf?.msm_bucket_fill_ms ?? 0),
                        rustCommitMsmReduceMs: Number(commitPerf?.msm_reduce_ms ?? 0),
                        rustCommitMsmDoubleMs: Number(commitPerf?.msm_double_ms ?? 0),
                        rustCommitMsmMs: Number(commitPerf?.msm_ms ?? 0),
                        rustCommitCompressMs: Number(commitPerf?.compress_ms ?? 0),
                        rustCommitMs: Number(commitPerf?.total_ms ?? commitMs),
                        rustCommitBackend: 'blst',
                        rustCommitMsmSubphasesAvailable: false,
                    },
                };
                break;
            }
            case 'expandMduRs': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { data, k, m, profile = true } = payload as {
                    data: Uint8Array;
                    k: number;
                    m: number;
                    profile?: boolean;
                };
                if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array');
                const expanded = (
                    profile
                        ? nilWasmInstance.expand_mdu_rs_flat_committed_profiled(data, Number(k), Number(m))
                        : nilWasmInstance.expand_mdu_rs_flat_committed(data, Number(k), Number(m))
                ) as unknown;
                const parsed = typeof expanded === 'string' ? JSON.parse(expanded) : expanded;
                const witnessRaw = (parsed as { witness_flat?: unknown }).witness_flat;
                const rootRaw = (parsed as { mdu_root?: unknown }).mdu_root;
                const shardsRaw = (parsed as { shards_flat?: unknown }).shards_flat;
                const shardLen = Number((parsed as { shard_len?: unknown }).shard_len ?? 0);
                const rustPerf = (parsed as {
                    perf?: {
                        encode_ms?: unknown;
                        rs_ms?: unknown;
                        commit_decode_ms?: unknown;
                        commit_transform_ms?: unknown;
                        commit_msm_scalar_prep_ms?: unknown;
                        commit_msm_bucket_fill_ms?: unknown;
                        commit_msm_reduce_ms?: unknown;
                        commit_msm_double_ms?: unknown;
                        commit_msm_ms?: unknown;
                        commit_compress_ms?: unknown;
                        commit_ms?: unknown;
                        total_ms?: unknown;
                        rows?: unknown;
                        shards_total?: unknown;
                    };
                }).perf;
                if (!Number.isInteger(shardLen) || shardLen <= 0) {
                    throw new Error('expandMduRs returned an invalid shard length');
                }

                const witnessFlat =
                    witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike);
                const rootBytes =
                    rootRaw instanceof Uint8Array ? rootRaw : new Uint8Array(rootRaw as ArrayBufferLike);
                const shardsFlat =
                    shardsRaw instanceof Uint8Array ? shardsRaw : new Uint8Array(shardsRaw as ArrayBufferLike);

                result = {
                    witness_flat: witnessFlat,
                    mdu_root: rootBytes,
                    shards_flat: shardsFlat,
                    shard_len: shardLen,
                    perf: {
                        expandMs: Number(rustPerf?.encode_ms ?? 0) + Number(rustPerf?.rs_ms ?? 0),
                        rootMs: 0,
                        totalMs: Number(rustPerf?.total_ms ?? 0),
                        shardCount: Math.floor(shardsFlat.byteLength / shardLen),
                        shardLen,
                        rustEncodeMs: Number(rustPerf?.encode_ms ?? 0),
                        rustRsMs: Number(rustPerf?.rs_ms ?? 0),
                        rustCommitDecodeMs: Number(rustPerf?.commit_decode_ms ?? 0),
                        rustCommitTransformMs: Number(rustPerf?.commit_transform_ms ?? 0),
                        rustCommitMsmScalarPrepMs: Number(rustPerf?.commit_msm_scalar_prep_ms ?? 0),
                        rustCommitMsmBucketFillMs: Number(rustPerf?.commit_msm_bucket_fill_ms ?? 0),
                        rustCommitMsmReduceMs: Number(rustPerf?.commit_msm_reduce_ms ?? 0),
                        rustCommitMsmDoubleMs: Number(rustPerf?.commit_msm_double_ms ?? 0),
                        rustCommitMsmMs: Number(rustPerf?.commit_msm_ms ?? 0),
                        rustCommitCompressMs: Number(rustPerf?.commit_compress_ms ?? 0),
                        rustCommitMs: Number(rustPerf?.commit_ms ?? 0),
                        rustTotalMs: Number(rustPerf?.total_ms ?? 0),
                        rustCommitBackend: 'blst',
                        rustCommitMsmSubphasesAvailable: false,
                        rows: Number(rustPerf?.rows ?? 0),
                        shardsTotal: Number(rustPerf?.shards_total ?? 0),
                    },
                };
                break;
            }
            case 'expandPayloadRs': {
                if (!nilWasmInstance) throw new Error('NilWasm not initialized. Call initNilWasm first.');
                const { data, k, m, profile = true } = payload as {
                    data: Uint8Array;
                    k: number;
                    m: number;
                    profile?: boolean;
                };
                if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array');

                const expanded = (
                    profile
                        ? nilWasmInstance.expand_payload_rs_flat_committed_profiled(data, Number(k), Number(m))
                        : nilWasmInstance.expand_payload_rs_flat_committed(data, Number(k), Number(m))
                ) as unknown;
                const parsed = typeof expanded === 'string' ? JSON.parse(expanded) : expanded;
                const shardsRaw = (parsed as { shards_flat?: unknown }).shards_flat;
                const witnessRaw = (parsed as { witness_flat?: unknown }).witness_flat;
                const rootRaw = (parsed as { mdu_root?: unknown }).mdu_root;
                const shardLen = Number((parsed as { shard_len?: unknown }).shard_len ?? 0);
                const rustPerf = (parsed as {
                    perf?: {
                        encode_ms?: unknown;
                        rs_ms?: unknown;
                        commit_decode_ms?: unknown;
                        commit_transform_ms?: unknown;
                        commit_msm_scalar_prep_ms?: unknown;
                        commit_msm_bucket_fill_ms?: unknown;
                        commit_msm_reduce_ms?: unknown;
                        commit_msm_double_ms?: unknown;
                        commit_msm_ms?: unknown;
                        commit_compress_ms?: unknown;
                        commit_ms?: unknown;
                        total_ms?: unknown;
                        rows?: unknown;
                        shards_total?: unknown;
                    };
                }).perf;
                if (!Number.isInteger(shardLen) || shardLen <= 0) {
                    throw new Error('expandPayloadRs returned an invalid shard length');
                }

                const shardsFlat = shardsRaw instanceof Uint8Array ? shardsRaw : new Uint8Array(shardsRaw as ArrayBufferLike);
                if (shardsFlat.byteLength % shardLen !== 0) {
                    throw new Error('expandPayloadRs returned misaligned shard bytes');
                }
                const witnessFlat =
                    witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike);
                const rootBytes =
                    rootRaw instanceof Uint8Array ? rootRaw : new Uint8Array(rootRaw as ArrayBufferLike);

                result = {
                    witness_flat: witnessFlat,
                    mdu_root: rootBytes,
                    shards_flat: shardsFlat,
                    shard_len: shardLen,
                    perf: {
                        expandMs: Number(rustPerf?.encode_ms ?? 0) + Number(rustPerf?.rs_ms ?? 0),
                        commitMs: Number(rustPerf?.commit_ms ?? 0),
                        rootMs: 0,
                        totalMs: Number(rustPerf?.total_ms ?? 0),
                        shardCount: shardsFlat.byteLength / shardLen,
                        shardLen,
                        rustEncodeMs: Number(rustPerf?.encode_ms ?? 0),
                        rustRsMs: Number(rustPerf?.rs_ms ?? 0),
                        rustCommitDecodeMs: Number(rustPerf?.commit_decode_ms ?? 0),
                        rustCommitTransformMs: Number(rustPerf?.commit_transform_ms ?? 0),
                        rustCommitMsmScalarPrepMs: Number(rustPerf?.commit_msm_scalar_prep_ms ?? 0),
                        rustCommitMsmBucketFillMs: Number(rustPerf?.commit_msm_bucket_fill_ms ?? 0),
                        rustCommitMsmReduceMs: Number(rustPerf?.commit_msm_reduce_ms ?? 0),
                        rustCommitMsmDoubleMs: Number(rustPerf?.commit_msm_double_ms ?? 0),
                        rustCommitMsmMs: Number(rustPerf?.commit_msm_ms ?? 0),
                        rustCommitCompressMs: Number(rustPerf?.commit_compress_ms ?? 0),
                        rustCommitMs: Number(rustPerf?.commit_ms ?? 0),
                        rustTotalMs: Number(rustPerf?.total_ms ?? 0),
                        rustCommitBackend: 'blst',
                        rustCommitMsmSubphasesAvailable: false,
                        rows: Number(rustPerf?.rows ?? 0),
                        shardsTotal: Number(rustPerf?.shards_total ?? 0),
                    },
                };
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
