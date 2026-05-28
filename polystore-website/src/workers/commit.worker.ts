// polystore-website/src/workers/commit.worker.ts
//
// A small worker used as a compute pool to parallelize blob commitment generation
// across multiple single-threaded WASM instances (no SharedArrayBuffer required).

import init, { PolyStoreWasm } from '../lib/polystoreCoreRuntime.js'
import { createBrowserKzgCommitBackend, type KzgCommitBackend } from '../lib/kzgCommitBackend'

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null
let wasmInitError: unknown = null

let polyStoreWasmInstance: PolyStoreWasm | null = null
let kzgCommitBackend: KzgCommitBackend | null = null

function initializeWasm(): Promise<void> {
  if (wasmInitialized) return Promise.resolve()
  if (wasmInitError) return Promise.reject(wasmInitError)
  if (wasmInitPromise) return wasmInitPromise

  const wasmUrl = new URL('/wasm/polystore_core_bg.wasm', self.location.origin)
  wasmInitPromise = (async () => {
    await init({ module_or_path: wasmUrl })
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
      case 'initPolyStoreWasm': {
        const { trustedSetupBytes } = payload as { trustedSetupBytes: Uint8Array }
        if (!trustedSetupBytes) throw new Error('Trusted setup bytes required')
        polyStoreWasmInstance = new PolyStoreWasm(trustedSetupBytes)
        kzgCommitBackend = await createBrowserKzgCommitBackend(polyStoreWasmInstance, trustedSetupBytes, {
          preferWebGpu: false,
          webGpuMode: 'off',
        })
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: 'ok' })
        return
      }
      case 'commitBlobs': {
        if (!kzgCommitBackend) throw new Error('PolyStoreWasm not initialized')
        const { data } = payload as { data: Uint8Array }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const commitments = await kzgCommitBackend.commitBlobs(data)
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
