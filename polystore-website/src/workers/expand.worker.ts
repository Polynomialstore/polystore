import init, { PolyStoreWasm } from '../lib/polystoreCoreRuntime.js'
import { createBrowserKzgCommitBackend, type KzgCommitBackend } from '../lib/kzgCommitBackend'
import {
  expandUserMduRsWithBrowserKzg,
  kzgCommitDiagnosticsForBackend,
} from '../lib/upload/userMduBrowserKzg'

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null
let wasmInitError: unknown = null
let polyStoreWasmInstance: PolyStoreWasm | null = null
let kzgCommitBackend: KzgCommitBackend | null = null

// User MDU batches are large (default Mode 2 RS 8+4 commits 96 blobs), so
// do not let a one-blob probe reject WebGPU for the dominant upload stage.
// Validation failures still fall back through expandUserMduRsWithBrowserKzg.
const USER_UPLOAD_KZG_OPTIONS = {
  preferWebGpu: true,
  webGpuMode: 'force' as const,
  webGpuProbeTimeoutMs: 15_000,
  webGpuCommitTimeoutMs: 60_000,
}

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

function kzgCommitDiagnostics() {
  return kzgCommitDiagnosticsForBackend(kzgCommitBackend)
}

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
        kzgCommitBackend = await createBrowserKzgCommitBackend(polyStoreWasmInstance, trustedSetupBytes, USER_UPLOAD_KZG_OPTIONS)
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: 'ok' })
        return
      }
      case 'expandMduRs': {
        if (!polyStoreWasmInstance || !kzgCommitBackend) throw new Error('PolyStoreWasm not initialized')
        const { data, k, m, profile = true } = payload as { data: Uint8Array; k: number; m: number; profile?: boolean }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const result = await expandUserMduRsWithBrowserKzg({
          kind: 'mdu',
          data,
          k: Number(k),
          m: Number(m),
          profile,
          wasm: polyStoreWasmInstance,
          kzgCommitBackend,
        })
        const transferables: Transferable[] = [result.witness_flat.buffer, result.mdu_root.buffer, result.shards_flat.buffer]
        ;(self as unknown as Worker).postMessage(
          {
            id,
            type: 'result',
            payload: result,
          },
          transferables,
        )
        return
      }
      case 'expandPayloadRs': {
        if (!polyStoreWasmInstance || !kzgCommitBackend) throw new Error('PolyStoreWasm not initialized')
        const { data, k, m, profile = true } = payload as {
          data: Uint8Array
          k: number
          m: number
          profile?: boolean
        }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')

        const result = await expandUserMduRsWithBrowserKzg({
          kind: 'payload',
          data,
          k: Number(k),
          m: Number(m),
          profile,
          wasm: polyStoreWasmInstance,
          kzgCommitBackend,
        })
        ;(self as unknown as Worker).postMessage(
          {
            id,
            type: 'result',
            payload: result,
          },
          [result.witness_flat.buffer, result.mdu_root.buffer, result.shards_flat.buffer],
        )
        return
      }
      case 'commitMduProfiled': {
        if (!polyStoreWasmInstance || !kzgCommitBackend) throw new Error('PolyStoreWasm not initialized')
        const { data } = payload as { data: Uint8Array }
        const BLOBS_PER_MDU = 64
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        if (data.byteLength !== 8 * 1024 * 1024) throw new Error('MDU bytes must be exactly 8 MiB')

        const opStart = performance.now()
        const commitStart = performance.now()
        const committedRaw = await kzgCommitBackend.commitBlobsProfiled(data)
        const commitMs = performance.now() - commitStart
        const witnessFlat = committedRaw.witnessFlat
        const commitPerf = committedRaw.perf

        const rootStart = performance.now()
        const root = polyStoreWasmInstance.compute_mdu_root(witnessFlat) as unknown
        const rootMs = performance.now() - rootStart
        const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike)
        ;(self as unknown as Worker).postMessage(
          {
            id,
            type: 'result',
            payload: {
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
            },
          },
          [witnessFlat.buffer, rootBytes.buffer],
        )
        return
      }
      case 'computeManifest': {
        if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized')
        const { roots } = payload as { roots: Uint8Array }
        if (!(roots instanceof Uint8Array)) throw new Error('roots must be Uint8Array')
        const manifest = polyStoreWasmInstance.compute_manifest(roots) as unknown as {
          root: Uint8Array | ArrayBufferLike
          blob: Uint8Array | ArrayBufferLike
        }
        const root = manifest.root instanceof Uint8Array ? manifest.root : new Uint8Array(manifest.root)
        const blob = manifest.blob instanceof Uint8Array ? manifest.blob : new Uint8Array(manifest.blob)
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: { root, blob } }, [
          root.buffer,
          blob.buffer,
        ])
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
