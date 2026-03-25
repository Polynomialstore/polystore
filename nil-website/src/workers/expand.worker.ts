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
    await init({ module_or_path: wasmUrl })
    wasmInitialized = true
  })().catch((err) => {
    wasmInitError = err
    throw err
  })

  return wasmInitPromise
}

void initializeWasm()

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
      case 'expandMduRs': {
        if (!nilWasmInstance) throw new Error('NilWasm not initialized')
        const { data, k, m } = payload as { data: Uint8Array; k: number; m: number }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const opStart = performance.now()
        const expandStart = performance.now()
        const expanded = nilWasmInstance.expand_mdu_rs(data, Number(k), Number(m)) as unknown
        const expandMs = performance.now() - expandStart
        const parsed = typeof expanded === 'string' ? JSON.parse(expanded) : expanded
        const witnessRaw = (parsed as { witness?: unknown[] }).witness ?? []
        const shardsRaw = (parsed as { shards?: unknown[] }).shards ?? []

        const witnessList: Uint8Array[] = witnessRaw.map((w) =>
          w instanceof Uint8Array ? w : new Uint8Array(w as ArrayBufferLike),
        )
        const shardsList: Uint8Array[] = shardsRaw.map((s) =>
          s instanceof Uint8Array ? s : new Uint8Array(s as ArrayBufferLike),
        )

        const witnessFlat = new Uint8Array(witnessList.length * 48)
        let offset = 0
        for (const w of witnessList) {
          witnessFlat.set(w, offset)
          offset += w.length
        }

        const rootStart = performance.now()
        const root = nilWasmInstance.compute_mdu_root(witnessFlat) as unknown
        const rootMs = performance.now() - rootStart
        const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike)
        const transferables: Transferable[] = [witnessFlat.buffer, rootBytes.buffer]
        for (const shard of shardsList) transferables.push(shard.buffer)
        ;(self as unknown as Worker).postMessage(
          {
            id,
            type: 'result',
            payload: {
              witness_flat: witnessFlat,
              mdu_root: rootBytes,
              shards: shardsList,
              perf: {
                expandMs,
                rootMs,
                totalMs: performance.now() - opStart,
                shardCount: shardsList.length,
              },
            },
          },
          transferables,
        )
        return
      }
      case 'expandPayloadRs': {
        if (!nilWasmInstance) throw new Error('NilWasm not initialized')
        const { data, k, m } = payload as { data: Uint8Array; k: number; m: number }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')

        const opStart = performance.now()
        const expandStart = performance.now()
        const expanded = nilWasmInstance.expand_payload_rs_flat(data, Number(k), Number(m)) as unknown
        const expandMs = performance.now() - expandStart
        const parsed = typeof expanded === 'string' ? JSON.parse(expanded) : expanded
        const witnessRaw = (parsed as { witness_flat?: unknown }).witness_flat
        const shardsRaw = (parsed as { shards_flat?: unknown }).shards_flat
        const shardLen = Number((parsed as { shard_len?: unknown }).shard_len ?? 0)
        if (!Number.isInteger(shardLen) || shardLen <= 0) {
          throw new Error('expandPayloadRs returned an invalid shard length')
        }

        const witnessFlat = witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike)
        const shardsFlat = shardsRaw instanceof Uint8Array ? shardsRaw : new Uint8Array(shardsRaw as ArrayBufferLike)
        if (shardsFlat.byteLength % shardLen !== 0) {
          throw new Error('expandPayloadRs returned misaligned shard bytes')
        }

        const rootStart = performance.now()
        const root = nilWasmInstance.compute_mdu_root(witnessFlat) as unknown
        const rootMs = performance.now() - rootStart
        const rootBytes = root instanceof Uint8Array ? root : new Uint8Array(root as ArrayBufferLike)
        ;(self as unknown as Worker).postMessage(
          {
            id,
            type: 'result',
            payload: {
              witness_flat: witnessFlat,
              mdu_root: rootBytes,
              shards_flat: shardsFlat,
              shard_len: shardLen,
              perf: {
                expandMs,
                rootMs,
                totalMs: performance.now() - opStart,
                shardCount: shardsFlat.byteLength / shardLen,
                shardLen,
              },
            },
          },
          [witnessFlat.buffer, rootBytes.buffer, shardsFlat.buffer],
        )
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
