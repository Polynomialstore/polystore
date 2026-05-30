import init, { PolyStoreWasm } from '../lib/polystoreCoreRuntime.js'
import {
  committedExpansionToUserMduBrowserKzgResult,
  parseCommittedExpansion,
  parseUserMduUncommittedExpansion,
} from '../lib/upload/userMduBrowserKzg'

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null
let wasmInitError: unknown = null
let polyStoreWasmInstance: PolyStoreWasm | null = null

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

function committedFallbackReason(fallbackReason: unknown): string | undefined {
  return typeof fallbackReason === 'string' && fallbackReason.trim()
    ? `scheduler owner failed; used committed WASM fallback: ${fallbackReason}`
    : undefined
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
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: 'ok' })
        return
      }
      case 'expandMduRsUncommitted':
      case 'expandPayloadRsUncommitted': {
        if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized')
        const { data, k, m, profile = true, payloadId, sequence, mduIndex } = payload as {
          data: Uint8Array
          k: number
          m: number
          profile?: boolean
          payloadId?: string
          sequence?: number
          mduIndex?: number
        }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const kind = type === 'expandMduRsUncommitted' ? 'mdu' : 'payload'
        const raw = kind === 'mdu'
          ? polyStoreWasmInstance.expand_mdu_rs_flat_uncommitted(data, Number(k), Number(m))
          : polyStoreWasmInstance.expand_payload_rs_flat_uncommitted(data, Number(k), Number(m))
        const result = parseUserMduUncommittedExpansion(raw, {
          kind,
          k: Number(k),
          m: Number(m),
          profile,
          payloadId,
          sequence,
          mduIndex,
          label: kind === 'mdu' ? 'expandMduRsUncommitted' : 'expandPayloadRsUncommitted',
        })
        ;(self as unknown as Worker).postMessage({ id, type: 'result', payload: result }, [result.shardsFlat.buffer])
        return
      }
      case 'expandMduRsCommitted':
      case 'expandPayloadRsCommitted': {
        if (!polyStoreWasmInstance) throw new Error('PolyStoreWasm not initialized')
        const { data, k, m, profile = true, fallbackReason } = payload as {
          data: Uint8Array
          k: number
          m: number
          profile?: boolean
          fallbackReason?: string
        }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const isMdu = type === 'expandMduRsCommitted'
        const raw = isMdu
          ? profile
            ? polyStoreWasmInstance.expand_mdu_rs_flat_committed_profiled(data, Number(k), Number(m))
            : polyStoreWasmInstance.expand_mdu_rs_flat_committed(data, Number(k), Number(m))
          : profile
            ? polyStoreWasmInstance.expand_payload_rs_flat_committed_profiled(data, Number(k), Number(m))
            : polyStoreWasmInstance.expand_payload_rs_flat_committed(data, Number(k), Number(m))
        const parsed = parseCommittedExpansion(raw, isMdu ? 'expandMduRsCommitted' : 'expandPayloadRsCommitted')
        const result = committedExpansionToUserMduBrowserKzgResult(parsed, committedFallbackReason(fallbackReason))
        ;(self as unknown as Worker).postMessage(
          { id, type: 'result', payload: result },
          [parsed.witnessFlat.buffer, parsed.mduRoot.buffer, parsed.shardsFlat.buffer],
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
