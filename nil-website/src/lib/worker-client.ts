// nil-website/src/lib/worker-client.ts

// This file provides a simple client API to interact with the gateway.worker.ts
// It abstracts the message passing and Promise-based communication.

// Instantiate the worker
const worker = new Worker(new URL('../workers/gateway.worker.ts', import.meta.url), {
  type: 'module'
});

// Map to store pending worker messages (promises)
const pendingWorkerMessages = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
let nextWorkerMessageId = 0;

// Handle messages coming back from the worker
worker.onmessage = (event) => {
  const { id, type, payload } = event.data;

  const pending = pendingWorkerMessages.get(id);
  if (pending) {
    if (type === 'result') {
      pending.resolve(payload);
    } else if (type === 'error') {
      pending.reject(new Error(payload));
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

// Function to send messages to the worker and await a response
function sendMessageToWorker(type: string, payload: any, transferables?: Transferable[]): Promise<any> {
  const id = nextWorkerMessageId++;
  return new Promise((resolve, reject) => {
    pendingWorkerMessages.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transferables || []);
  });
}

// --- Public API for interacting with the Worker ---

export const workerClient = {
  // Initialize the WASM module inside the worker, including KzgContext
  async initNilWasm(trustedSetupBytes: Uint8Array): Promise<string> {
    return sendMessageToWorker('initNilWasm', { trustedSetupBytes }, [trustedSetupBytes.buffer]);
  },

  // Initialize Mdu0Builder within the worker
  async initMdu0Builder(maxUserMdus: number): Promise<string> {
    return sendMessageToWorker('initMdu0Builder', { maxUserMdus });
  },

  // Append a file entry to the MDU #0 builder in the worker
  async appendFileToMdu0(path: string, size: number, startOffset: number): Promise<string> {
    return sendMessageToWorker('appendFileToMdu0', { path, size, startOffset });
  },

  // Get the complete 8MB MDU #0 bytes from the worker
  async getMdu0Bytes(): Promise<Uint8Array> {
    return sendMessageToWorker('getMdu0Bytes', {});
  },

  // Set a root in the MDU #0 builder
  async setMdu0Root(index: number, root: Uint8Array): Promise<string> {
    return sendMessageToWorker('setMdu0Root', { index, root }, [root.buffer]);
  },

  // Get witness count from MDU #0 builder
  async getMdu0WitnessCount(): Promise<number> {
    return sendMessageToWorker('getMdu0WitnessCount', {});
  },

  // Shard a file (or part of it) using NilWasm
  // This will likely need to handle streaming of data in the future for large files.
  async shardFile(data: Uint8Array): Promise<{ manifestRoot: string; mduData: any[] }> {
    return sendMessageToWorker('shardFile', { data }, [data.buffer]);
  },
};
