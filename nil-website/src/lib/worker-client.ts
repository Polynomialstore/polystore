// nil-website/src/lib/worker-client.ts

// This file provides a simple client API to interact with the gateway.worker.ts
// It abstracts the message passing and Promise-based communication.

// Instantiate the worker
const worker = new Worker(new URL('../workers/gateway.worker.ts', import.meta.url), {
  type: 'module'
});

// Map to store pending worker messages (promises)
const pendingWorkerMessages = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; onProgress?: (payload: unknown) => void }
>();
let nextWorkerMessageId = 0;

type ExpansionWorkerPending = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

let expansionWorkers: Worker[] = []
let expansionWorkersReady: Promise<void> | null = null
const expansionPending = new Map<number, ExpansionWorkerPending>()
const expansionPendingByWorker = new Map<Worker, Set<number>>()
let expansionNextMessageId = 1
let expansionRoundRobin = 0

const DEFAULT_EXPANSION_HARDWARE_CONCURRENCY = 4
const MAX_EXPANSION_WORKERS = 4

export function pickExpansionWorkerCount(hardwareConcurrency?: number, totalJobs?: number): number {
  const hc = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(Number(hardwareConcurrency)))
    : DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
  const jobCap = Number.isFinite(totalJobs) ? Math.max(1, Math.floor(Number(totalJobs))) : Number.POSITIVE_INFINITY

  let desired = 1
  if (hc >= 6) desired = MAX_EXPANSION_WORKERS
  else if (hc >= 4) desired = 3
  else if (hc >= 3) desired = 2

  return Math.max(1, Math.min(desired, jobCap))
}

// Handle messages coming back from the worker
worker.onmessage = (event) => {
  const { id, type, payload } = event.data;

  const pending = pendingWorkerMessages.get(id);
  if (pending) {
    if (type === 'result') {
      pending.resolve(payload);
    } else if (type === 'error') {
      pending.reject(new Error(payload));
    } else if (type === 'progress') {
      pending.onProgress?.(payload);
      return;
    }
    pendingWorkerMessages.delete(id);
  }
};

// Handle errors from the worker
worker.onerror = (error) => {
  console.error("Worker error:", error);
  // Reject all pending messages
  for (const [id, { reject }] of pendingWorkerMessages) {
    reject(new Error(`Worker encountered an error: ${error.message}`));
    pendingWorkerMessages.delete(id);
  }
};

function initializeExpansionPool(trustedSetupBytes: Uint8Array): Promise<void> {
  if (expansionWorkersReady) return expansionWorkersReady

  const hc = navigator.hardwareConcurrency ?? DEFAULT_EXPANSION_HARDWARE_CONCURRENCY
  const desired = pickExpansionWorkerCount(hc)
  if (desired <= 1) {
    expansionWorkers = []
    expansionWorkersReady = Promise.resolve()
    return expansionWorkersReady
  }

  expansionWorkersReady = (async () => {
    const workers: Worker[] = []
    try {
      for (let i = 0; i < desired; i += 1) {
        const w = new Worker(new URL('../workers/expand.worker.ts', import.meta.url), { type: 'module' })
        expansionPendingByWorker.set(w, new Set())
        w.onmessage = (event) => {
          const { id, type, payload } = event.data
          expansionPendingByWorker.get(w)?.delete(id)
          const pending = expansionPending.get(id)
          if (!pending) return
          if (type === 'result') pending.resolve(payload)
          else pending.reject(new Error(String(payload)))
          expansionPending.delete(id)
        }
        w.onerror = (error) => {
          console.warn('Expansion worker error:', error)
          const ids = expansionPendingByWorker.get(w)
          if (ids) {
            for (const id of ids) {
              expansionPending.get(id)?.reject(new Error('Expansion worker crashed'))
              expansionPending.delete(id)
            }
            expansionPendingByWorker.delete(w)
          }
          expansionWorkers = expansionWorkers.filter((ww) => ww !== w)
        }
        workers.push(w)
      }
    } catch (error) {
      console.warn('Failed to spawn expansion worker pool; continuing single-threaded.', error)
      expansionWorkers = []
      return
    }

    const initPromises = workers.map((w) => {
      const id = expansionNextMessageId++
      const setupCopy = trustedSetupBytes.slice()
      return new Promise<void>((resolve, reject) => {
        expansionPending.set(id, {
          resolve: () => resolve(),
          reject,
        })
        expansionPendingByWorker.get(w)?.add(id)
        w.postMessage({ id, type: 'initNilWasm', payload: { trustedSetupBytes: setupCopy } }, [setupCopy.buffer])
      })
    })

    await Promise.all(initPromises)
    expansionWorkers = workers
  })()

  return expansionWorkersReady
}

// Function to send messages to the worker and await a response
function sendMessageToWorker(
  type: string,
  payload: unknown,
  transferables?: Transferable[],
  onProgress?: (payload: unknown) => void,
): Promise<unknown> {
  const id = nextWorkerMessageId++;
  return new Promise((resolve, reject) => {
    pendingWorkerMessages.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload }, transferables || []);
  });
}

function sendExpansionMessageToWorker(
  type: 'expandMduRs' | 'expandPayloadRs',
  payload: unknown,
  transferables?: Transferable[],
): Promise<unknown> {
  if (!expansionWorkers || expansionWorkers.length === 0) {
    return sendMessageToWorker(type, payload, transferables)
  }

  const w = expansionWorkers[expansionRoundRobin % expansionWorkers.length]
  expansionRoundRobin += 1
  const id = expansionNextMessageId++
  return new Promise((resolve, reject) => {
    expansionPending.set(id, { resolve, reject })
    expansionPendingByWorker.get(w)?.add(id)
    w.postMessage({ id, type, payload }, transferables || [])
  })
}

export interface ExpandedMdu {
    witness_flat: Uint8Array | number[]; // 96 * 48 bytes
    mdu_root: Uint8Array | number[]; // 32 bytes
    perf?: {
      commitMs?: number;
      rootMs?: number;
      totalMs?: number;
      batchCount?: number;
      batchSize?: number;
      blobCount?: number;
    };
}

export interface ExpandedStripe {
    witness_flat: Uint8Array | number[];
    mdu_root: Uint8Array | number[];
    shards?: Array<Uint8Array | number[]>;
    shards_flat?: Uint8Array | number[];
    shard_len?: number;
    perf?: {
      expandMs?: number;
      rootMs?: number;
      totalMs?: number;
      shardCount?: number;
      shardLen?: number;
      rustEncodeMs?: number;
      rustRsMs?: number;
      rustCommitDecodeMs?: number;
      rustCommitTransformMs?: number;
      rustCommitMsmScalarPrepMs?: number;
      rustCommitMsmBucketFillMs?: number;
      rustCommitMsmReduceMs?: number;
      rustCommitMsmDoubleMs?: number;
      rustCommitMsmMs?: number;
      rustCommitCompressMs?: number;
      rustCommitMs?: number;
      rustTotalMs?: number;
      rows?: number;
      shardsTotal?: number;
    };
}

// --- Public API for interacting with the Worker ---

export const workerClient = {
  // Initialize the WASM module inside the worker, including KzgContext
  async initNilWasm(trustedSetupBytes: Uint8Array): Promise<string> {
    const setupCopy = trustedSetupBytes.slice()
    const result = await sendMessageToWorker('initNilWasm', { trustedSetupBytes }, [trustedSetupBytes.buffer]) as string
    await initializeExpansionPool(setupCopy)
    return result
  },

  // Initialize Mdu0Builder within the worker
  async initMdu0Builder(maxUserMdus: number, commitmentsPerMdu?: number): Promise<string> {
    return sendMessageToWorker('initMdu0Builder', { maxUserMdus, commitmentsPerMdu }) as Promise<string>;
  },

  // Load an existing MDU #0 builder from bytes
  async loadMdu0Builder(data: Uint8Array, maxUserMdus: number, commitmentsPerMdu?: number): Promise<string> {
    return sendMessageToWorker(
      'loadMdu0Builder',
      { data, maxUserMdus, commitmentsPerMdu },
      [data.buffer],
    ) as Promise<string>;
  },

  // Append a file entry to the MDU #0 builder in the worker
  async appendFileToMdu0(path: string, size: number, startOffset: number, flags?: number): Promise<string> {
    return sendMessageToWorker('appendFileToMdu0', { path, size, startOffset, flags }) as Promise<string>;
  },

  // Get the complete 8MB MDU #0 bytes from the worker
  async getMdu0Bytes(): Promise<Uint8Array> {
    return sendMessageToWorker('getMdu0Bytes', {}) as Promise<Uint8Array>;
  },

  // Set a root in the MDU #0 builder
  async setMdu0Root(index: number, root: Uint8Array): Promise<string> {
    return sendMessageToWorker('setMdu0Root', { index, root }) as Promise<string>;
  },

  // Get witness count from MDU #0 builder
  async getMdu0WitnessCount(): Promise<number> {
    return sendMessageToWorker('getMdu0WitnessCount', {}) as Promise<number>;
  },

  // Shard a file (or part of it) using NilWasm
  // This will likely need to handle streaming of data in the future for large files.
  async shardFile(data: Uint8Array): Promise<ExpandedMdu> {
    return sendMessageToWorker('shardFile', { data }, [data.buffer]) as Promise<ExpandedMdu>;
  },

  async shardFileProgressive(
    data: Uint8Array,
    opts?: { batchBlobs?: number; onProgress?: (payload: unknown) => void },
  ): Promise<ExpandedMdu> {
    return sendMessageToWorker(
      'shardFileProgressive',
      { data, batchBlobs: opts?.batchBlobs },
      [data.buffer],
      opts?.onProgress,
    ) as Promise<ExpandedMdu>;
  },

  async expandMduRs(data: Uint8Array, k: number, m: number): Promise<ExpandedStripe> {
    return sendExpansionMessageToWorker('expandMduRs', { data, k, m }, [data.buffer]) as Promise<ExpandedStripe>;
  },

  async expandPayloadRs(data: Uint8Array, k: number, m: number): Promise<ExpandedStripe> {
    return sendExpansionMessageToWorker('expandPayloadRs', { data, k, m }, [data.buffer]) as Promise<ExpandedStripe>;
  },

  // Compute Manifest Root from a list of MDU roots (concatenated 32-byte roots)
  async computeManifest(roots: Uint8Array): Promise<{ root: Uint8Array; blob: Uint8Array }> {
    return sendMessageToWorker('computeManifest', { roots }, [roots.buffer]) as Promise<{ root: Uint8Array; blob: Uint8Array }>;
  },

  async computeMduRoot(witness: Uint8Array): Promise<Uint8Array> {
    return sendMessageToWorker('computeMduRoot', { witness }) as Promise<Uint8Array>;
  },
};
