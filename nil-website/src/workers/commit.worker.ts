// nil-website/src/workers/commit.worker.ts
//
// A small worker used as a compute pool to parallelize blob commitment generation
// across multiple single-threaded WASM instances (no SharedArrayBuffer required).

import init, { NilWasm } from '../../public/wasm/nil_core.js'

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null
let wasmInitError: unknown = null

let nilWasmInstance: NilWasm | null = null

function initializeWasm(): Promise<void> {
  if (wasmInitialized) return Promise.resolve()
  if (wasmInitError) return Promise.reject(wasmInitError)
  if (wasmInitPromise) return wasmInitPromise

  const wasmUrl = new URL('/wasm/nil_core_bg.wasm', self.location.origin)
  wasmInitPromise = (async () => {
    await init(wasmUrl)
    wasmInitialized = true
  })().catch((err) => {
    wasmInitError = err
    throw err
  })

  return wasmInitPromise
}

void initializeWasm()

// Listen for messages from the parent worker.
self.onmessage = async (event) => {
  const { type, payload, id } = event.data as {
    id: number
    type: string
    payload: unknown
  }

  try {
    await initializeWasm()

    switch (type) {
      case 'initNilWasm': {
        const { trustedSetupBytes } = payload as { trustedSetupBytes: Uint8Array }
        if (!trustedSetupBytes) throw new Error('Trusted setup bytes required')
        nilWasmInstance = new NilWasm(trustedSetupBytes)
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: 'ok' })
        return
      }
      case 'commitBlobs': {
        if (!nilWasmInstance) throw new Error('NilWasm not initialized')
        const { data } = payload as { data: Uint8Array }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const commitments = nilWasmInstance.commit_blobs(data)
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: commitments }, [commitments.buffer])
        return
      }
      default:
        throw new Error(`Unknown message type: ${type}`)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ;(self as unknown as Worker).postMessage({ id, type: 'error', payload: message || 'Unknown worker error' })
  }
}

