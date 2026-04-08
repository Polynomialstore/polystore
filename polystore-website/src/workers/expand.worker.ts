import init, { NilWasm } from '../lib/polystoreCoreRuntime.js'

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null
let wasmInitError: unknown = null
let nilWasmInstance: NilWasm | null = null

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
        const { data, k, m, profile = true } = payload as { data: Uint8Array; k: number; m: number; profile?: boolean }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        const opStart = performance.now()
        const expanded = (
          profile
            ? nilWasmInstance.expand_mdu_rs_flat_committed_profiled(data, Number(k), Number(m))
            : nilWasmInstance.expand_mdu_rs_flat_committed(data, Number(k), Number(m))
        ) as unknown
        const parsed = typeof expanded === 'string' ? JSON.parse(expanded) : expanded
        const witnessRaw = (parsed as { witness_flat?: unknown }).witness_flat
        const rootRaw = (parsed as { mdu_root?: unknown }).mdu_root
        const shardsRaw = (parsed as { shards_flat?: unknown }).shards_flat
        const shardLen = Number((parsed as { shard_len?: unknown }).shard_len ?? 0)
        const rustPerf = (parsed as {
          perf?: {
            encode_ms?: unknown
            rs_ms?: unknown
            commit_decode_ms?: unknown
            commit_transform_ms?: unknown
            commit_msm_scalar_prep_ms?: unknown
            commit_msm_bucket_fill_ms?: unknown
            commit_msm_reduce_ms?: unknown
            commit_msm_double_ms?: unknown
            commit_msm_ms?: unknown
            commit_compress_ms?: unknown
            commit_ms?: unknown
            total_ms?: unknown
            rows?: unknown
            shards_total?: unknown
          }
        }).perf
        if (!Number.isInteger(shardLen) || shardLen <= 0) {
          throw new Error('expandMduRs returned an invalid shard length')
        }

        const witnessFlat = witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike)
        const rootBytes = rootRaw instanceof Uint8Array ? rootRaw : new Uint8Array(rootRaw as ArrayBufferLike)
        const shardsFlat = shardsRaw instanceof Uint8Array ? shardsRaw : new Uint8Array(shardsRaw as ArrayBufferLike)
        const transferables: Transferable[] = [witnessFlat.buffer, rootBytes.buffer, shardsFlat.buffer]
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
                expandMs: Number(rustPerf?.encode_ms ?? 0) + Number(rustPerf?.rs_ms ?? 0),
                rootMs: 0,
                totalMs: performance.now() - opStart,
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
            },
          },
          transferables,
        )
        return
      }
      case 'expandPayloadRs': {
        if (!nilWasmInstance) throw new Error('NilWasm not initialized')
        const { data, k, m, profile = true } = payload as {
          data: Uint8Array
          k: number
          m: number
          profile?: boolean
        }
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')

        const opStart = performance.now()
        const expanded = (
          profile
            ? nilWasmInstance.expand_payload_rs_flat_committed_profiled(data, Number(k), Number(m))
            : nilWasmInstance.expand_payload_rs_flat_committed(data, Number(k), Number(m))
        ) as unknown
        const parsed = typeof expanded === 'string' ? JSON.parse(expanded) : expanded
        const shardsRaw = (parsed as { shards_flat?: unknown }).shards_flat
        const witnessRaw = (parsed as { witness_flat?: unknown }).witness_flat
        const rootRaw = (parsed as { mdu_root?: unknown }).mdu_root
        const shardLen = Number((parsed as { shard_len?: unknown }).shard_len ?? 0)
        const rustPerf = (parsed as {
          perf?: {
            encode_ms?: unknown
            rs_ms?: unknown
            commit_decode_ms?: unknown
            commit_transform_ms?: unknown
            commit_msm_scalar_prep_ms?: unknown
            commit_msm_bucket_fill_ms?: unknown
            commit_msm_reduce_ms?: unknown
            commit_msm_double_ms?: unknown
            commit_msm_ms?: unknown
            commit_compress_ms?: unknown
            commit_ms?: unknown
            total_ms?: unknown
            rows?: unknown
            shards_total?: unknown
          }
        }).perf
        if (!Number.isInteger(shardLen) || shardLen <= 0) {
          throw new Error('expandPayloadRs returned an invalid shard length')
        }

        const shardsFlat = shardsRaw instanceof Uint8Array ? shardsRaw : new Uint8Array(shardsRaw as ArrayBufferLike)
        if (shardsFlat.byteLength % shardLen !== 0) {
          throw new Error('expandPayloadRs returned misaligned shard bytes')
        }
        const witnessFlat =
          witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike)
        const rootBytes = rootRaw instanceof Uint8Array ? rootRaw : new Uint8Array(rootRaw as ArrayBufferLike)
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
                expandMs: Number(rustPerf?.encode_ms ?? 0) + Number(rustPerf?.rs_ms ?? 0),
                commitMs: Number(rustPerf?.commit_ms ?? 0),
                rootMs: 0,
                totalMs: performance.now() - opStart,
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
            },
          },
          [witnessFlat.buffer, rootBytes.buffer, shardsFlat.buffer],
        )
        return
      }
      case 'commitMduProfiled': {
        if (!nilWasmInstance) throw new Error('NilWasm not initialized')
        const { data } = payload as { data: Uint8Array }
        const BLOBS_PER_MDU = 64
        if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array')
        if (data.byteLength !== 8 * 1024 * 1024) throw new Error('MDU bytes must be exactly 8 MiB')

        const opStart = performance.now()
        const commitStart = performance.now()
        const committedRaw = nilWasmInstance.commit_blobs_profiled(data) as {
          witness_flat?: Uint8Array | ArrayBufferLike
          perf?: {
            decode_ms?: unknown
            transform_ms?: unknown
            msm_scalar_prep_ms?: unknown
            msm_bucket_fill_ms?: unknown
            msm_reduce_ms?: unknown
            msm_double_ms?: unknown
            msm_ms?: unknown
            compress_ms?: unknown
            total_ms?: unknown
            blobs?: unknown
          }
        }
        const commitMs = performance.now() - commitStart
        const witnessRaw = committedRaw?.witness_flat
        if (!witnessRaw) {
          throw new Error('commit_blobs_profiled returned no witness bytes')
        }
        const witnessFlat =
          witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike)
        const commitPerf = committedRaw?.perf

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
            },
          },
          [witnessFlat.buffer, rootBytes.buffer],
        )
        return
      }
      case 'computeManifest': {
        if (!nilWasmInstance) throw new Error('NilWasm not initialized')
        const { roots } = payload as { roots: Uint8Array }
        if (!(roots instanceof Uint8Array)) throw new Error('roots must be Uint8Array')
        const manifest = nilWasmInstance.compute_manifest(roots) as unknown as {
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
