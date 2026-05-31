// polystore-website/src/workers/gateway.worker.ts

// This is a Web Worker script. It runs in its own global scope.

// Import the WASM module
// The `init` function loads the WASM binary.
// The `Mdu0Builder` and `PolyStoreWasm` classes are exposed by wasm-bindgen.
import init, { WasmMdu0Builder, PolyStoreWasm } from '../lib/polystoreCoreRuntime.js';
import { createBrowserKzgCommitBackend, type KzgCommitBackend } from '../lib/kzgCommitBackend';
import {
    committedExpansionToUserMduBrowserKzgResult,
    commitUserMduBatchUncommittedWithBrowserKzg,
    commitUserMduUncommittedWithBrowserKzg,
    expandUserMduRsWithBrowserKzg,
    kzgCommitDiagnosticsForBackend,
    parseCommittedExpansion,
    parseUserMduUncommittedExpansion,
    type UserMduBrowserKzgResult,
    type UserMduUncommittedExpansion,
} from '../lib/upload/userMduBrowserKzg';

let wasmInitialized = false;
let wasmInitPromise: Promise<void> | null = null;
let wasmInitError: unknown = null;
let mdu0BuilderInstance: WasmMdu0Builder | null = null;
let polyStoreWasmInstance: PolyStoreWasm | null = null;
let kzgCommitBackend: KzgCommitBackend | null = null;

// User MDU batches are large (default Mode 2 RS 8+4 commits 96 blobs), so
// do not let a one-blob probe reject WebGPU for the dominant upload stage.
// Validation failures still fall back through expandUserMduRsWithBrowserKzg.
const USER_UPLOAD_KZG_OPTIONS = {
    preferWebGpu: true,
    webGpuMode: 'force' as const,
    webGpuProbeTimeoutMs: 15_000,
    webGpuCommitTimeoutMs: 60_000,
};

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

    const wasmUrl = new URL('/wasm/polystore_core_bg.wasm', self.location.origin);
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
                w.postMessage({ id, type: 'initPolyStoreWasm', payload: { trustedSetupBytes: setupCopy } }, [setupCopy.buffer]);
            });
        });

        await Promise.all(initPromises);
        commitWorkers = workers;
    })();

    return commitWorkersReady;
}

function commitBlobsWithPool(data: Uint8Array): Promise<Uint8Array> {
    if (kzgCommitBackend) {
        const status = kzgCommitBackend.getStatus();
        const scheduler = status.webgpu?.scheduler;
        const shouldUseDirectScheduler =
            status.kind === 'webgpu-scheduler' &&
            scheduler &&
            !scheduler.circuitOpen &&
            scheduler.probeStatus !== 'failed' &&
            scheduler.probeStatus !== 'timeout' &&
            scheduler.probeStatus !== 'disabled';
        if (shouldUseDirectScheduler) {
            return Promise.resolve(kzgCommitBackend.commitBlobs(data));
        }
    }

    if (!commitWorkers || commitWorkers.length === 0) {
        if (!kzgCommitBackend) return Promise.reject(new Error('PolyStoreWasm not initialized'));
        return Promise.resolve(kzgCommitBackend.commitBlobs(data));
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

function kzgCommitDiagnostics() {
    return kzgCommitDiagnosticsForBackend(kzgCommitBackend);
}

function committedFallbackReason(fallbackReason: unknown): string | undefined {
    return typeof fallbackReason === 'string' && fallbackReason.trim()
        ? `scheduler owner failed; used committed WASM fallback: ${fallbackReason}`
        : undefined;
}

async function commitUserMduBatchWithSplitting(
    expansions: UserMduUncommittedExpansion[],
    splitCount = { value: 0 },
): Promise<UserMduBrowserKzgResult[]> {
    if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
    if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
    try {
        const results = await commitUserMduBatchUncommittedWithBrowserKzg({
            expansions,
            wasm: polyStoreWasmInstance,
            kzgCommitBackend,
        });
        return results.map((result) => ({
            ...result,
            perf: {
                ...result.perf,
                browserKzgBatchSplitCount: splitCount.value,
            },
        }));
    } catch (error) {
        if (expansions.length <= 1) throw error;
        splitCount.value += 1;
        const mid = Math.ceil(expansions.length / 2);
        const left = await commitUserMduBatchWithSplitting(expansions.slice(0, mid), splitCount);
        const right = await commitUserMduBatchWithSplitting(expansions.slice(mid), splitCount);
        return [...left, ...right];
    }
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
            case 'initPolyStoreWasm': {
                const { trustedSetupBytes } = payload;
                if (polyStoreWasmInstance) {
                    result = 'PolyStoreWasm already initialized';
                    break;
                }
                if (!trustedSetupBytes) throw new Error('Trusted setup bytes required for PolyStoreWasm initialization');
                polyStoreWasmInstance = new PolyStoreWasm(trustedSetupBytes);
                kzgCommitBackend = await createBrowserKzgCommitBackend(polyStoreWasmInstance, trustedSetupBytes, USER_UPLOAD_KZG_OPTIONS);
                // Initialize the blob-commit compute pool (best-effort).
                try {
                    await initializeCommitPool(trustedSetupBytes);
                } catch (e) {
                    console.warn('Commit worker pool init failed; continuing single-threaded.', e);
                    commitWorkers = [];
                    commitWorkersReady = Promise.resolve();
                }
                result = 'PolyStoreWasm initialized';
                break;
            }
            case 'getKzgCommitDiagnostics': {
                result = kzgCommitDiagnostics();
                break;
            }
            case 'initMdu0Builder': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
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
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
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
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
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
                if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const committedRaw = await kzgCommitBackend.commitBlobsProfiled(mdu0Bytes);
                perf.commitMs = performance.now() - commitStart;
                const witnessFlat = committedRaw.witnessFlat;
                const commitPerf = committedRaw.perf;
                perf.rustCommitDecodeMs = commitPerf.decodeMs;
                perf.rustCommitTransformMs = commitPerf.transformMs;
                perf.rustCommitMsmScalarPrepMs = commitPerf.msmScalarPrepMs;
                perf.rustCommitMsmBucketFillMs = commitPerf.msmBucketFillMs;
                perf.rustCommitMsmReduceMs = commitPerf.msmReduceMs;
                perf.rustCommitMsmDoubleMs = commitPerf.msmDoubleMs;
                perf.rustCommitMsmMs = commitPerf.msmMs;
                perf.rustCommitCompressMs = commitPerf.compressMs;
                perf.rustCommitMs = commitPerf.totalMs || perf.commitMs;
                Object.assign(perf, kzgCommitDiagnostics());

                const rootStart = performance.now();
                const root = polyStoreWasmInstance.compute_mdu_root(witnessFlat) as unknown;
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
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { data } = payload; // data is Uint8Array
                const commitResult = polyStoreWasmInstance.commit_mdu(data);
                result = typeof commitResult === 'string' ? JSON.parse(commitResult) : commitResult;
                break;
            }
            case 'shardFileProgressive': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
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
                const root = polyStoreWasmInstance.compute_mdu_root(witnessFlat) as unknown;
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
                        commitWorkerCount: commitWorkers.length,
                        ...kzgCommitDiagnostics(),
                    },
                };
                break;
            }
            case 'commitMduProfiled': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { data } = payload as { data: Uint8Array };
                const BLOBS_PER_MDU = 64;
                if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array');
                if (data.byteLength !== 8 * 1024 * 1024) throw new Error('MDU bytes must be exactly 8 MiB');

                const opStart = performance.now();
                const commitStart = performance.now();
                if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const committedRaw = await kzgCommitBackend.commitBlobsProfiled(data);
                const commitMs = performance.now() - commitStart;
                const witnessFlat = committedRaw.witnessFlat;
                const commitPerf = committedRaw.perf;

                const rootStart = performance.now();
                const root = polyStoreWasmInstance.compute_mdu_root(witnessFlat) as unknown;
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
                        rustCommitDecodeMs: commitPerf.decodeMs,
                        rustCommitTransformMs: commitPerf.transformMs,
                        rustCommitMsmScalarPrepMs: commitPerf.msmScalarPrepMs,
                        rustCommitMsmBucketFillMs: commitPerf.msmBucketFillMs,
                        rustCommitMsmReduceMs: commitPerf.msmReduceMs,
                        rustCommitMsmDoubleMs: commitPerf.msmDoubleMs,
                        rustCommitMsmMs: commitPerf.msmMs,
                        rustCommitCompressMs: commitPerf.compressMs,
                        rustCommitMs: commitPerf.totalMs || commitMs,
                        rustCommitMsmSubphasesAvailable: false,
                        ...kzgCommitDiagnostics(),
                    },
                };
                break;
            }
            case 'expandMduRsUncommitted':
            case 'expandPayloadRsUncommitted': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { data, k, m, profile = true, payloadId, sequence, mduIndex } = payload as {
                    data: Uint8Array;
                    k: number;
                    m: number;
                    profile?: boolean;
                    payloadId?: string;
                    sequence?: number;
                    mduIndex?: number;
                };
                if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array');
                const kind = type === 'expandMduRsUncommitted' ? 'mdu' : 'payload';
                const raw = kind === 'mdu'
                    ? polyStoreWasmInstance.expand_mdu_rs_flat_uncommitted(data, Number(k), Number(m))
                    : polyStoreWasmInstance.expand_payload_rs_flat_uncommitted(data, Number(k), Number(m));
                result = parseUserMduUncommittedExpansion(raw, {
                    kind,
                    k: Number(k),
                    m: Number(m),
                    profile,
                    payloadId,
                    sequence,
                    mduIndex,
                    label: kind === 'mdu' ? 'expandMduRsUncommitted' : 'expandPayloadRsUncommitted',
                });
                break;
            }
            case 'expandMduRsCommitted':
            case 'expandPayloadRsCommitted': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { data, k, m, profile = true, fallbackReason } = payload as {
                    data: Uint8Array;
                    k: number;
                    m: number;
                    profile?: boolean;
                    fallbackReason?: string;
                };
                if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array');
                const isMdu = type === 'expandMduRsCommitted';
                const raw = isMdu
                    ? profile
                        ? polyStoreWasmInstance.expand_mdu_rs_flat_committed_profiled(data, Number(k), Number(m))
                        : polyStoreWasmInstance.expand_mdu_rs_flat_committed(data, Number(k), Number(m))
                    : profile
                        ? polyStoreWasmInstance.expand_payload_rs_flat_committed_profiled(data, Number(k), Number(m))
                        : polyStoreWasmInstance.expand_payload_rs_flat_committed(data, Number(k), Number(m));
                result = committedExpansionToUserMduBrowserKzgResult(
                    parseCommittedExpansion(raw, isMdu ? 'expandMduRsCommitted' : 'expandPayloadRsCommitted'),
                    committedFallbackReason(fallbackReason),
                );
                break;
            }
            case 'commitExpandedUserMdu': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { expansion } = payload as {
                    expansion: {
                        shardsFlat: Uint8Array;
                        shardLen: number;
                        perf?: Record<string, unknown>;
                    };
                };
                if (!expansion || !(expansion.shardsFlat instanceof Uint8Array)) {
                    throw new Error('commitExpandedUserMdu requires uncommitted shards');
                }
                result = await commitUserMduUncommittedWithBrowserKzg({
                    expansion: {
                        shardsFlat: expansion.shardsFlat,
                        shardLen: Number(expansion.shardLen),
                        perf: expansion.perf ?? {},
                    },
                    wasm: polyStoreWasmInstance,
                    kzgCommitBackend,
                });
                break;
            }
            case 'commitExpandedUserMduBatch': {
                const { expansions } = payload as { expansions: UserMduUncommittedExpansion[] };
                if (!Array.isArray(expansions) || expansions.length === 0) {
                    throw new Error('commitExpandedUserMduBatch requires at least one uncommitted user MDU');
                }
                for (const [index, expansion] of expansions.entries()) {
                    if (!expansion || !(expansion.shardsFlat instanceof Uint8Array)) {
                        throw new Error(`commitExpandedUserMduBatch item ${index} requires uncommitted shards`);
                    }
                }
                result = await commitUserMduBatchWithSplitting(expansions);
                break;
            }
            case 'expandMduRs': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { data, k, m, profile = true } = payload as {
                    data: Uint8Array;
                    k: number;
                    m: number;
                    profile?: boolean;
                };
                result = await expandUserMduRsWithBrowserKzg({
                    kind: 'mdu',
                    data,
                    k: Number(k),
                    m: Number(m),
                    profile,
                    wasm: polyStoreWasmInstance,
                    kzgCommitBackend,
                });
                break;
            }
            case 'expandPayloadRs': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { data, k, m, profile = true } = payload as {
                    data: Uint8Array;
                    k: number;
                    m: number;
                    profile?: boolean;
                };
                result = await expandUserMduRsWithBrowserKzg({
                    kind: 'payload',
                    data,
                    k: Number(k),
                    m: Number(m),
                    profile,
                    wasm: polyStoreWasmInstance,
                    kzgCommitBackend,
                });
                break;
            }
            case 'computeManifest': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { roots } = payload; // roots is Uint8Array (concatenated 32-byte roots)
                result = polyStoreWasmInstance.compute_manifest(roots);
                break;
            }
            case 'computeMduRoot': {
                if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized. Call initPolyStoreWasm first.');
                const { witness } = payload; // witness is Uint8Array
                result = polyStoreWasmInstance.compute_mdu_root(witness);
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
