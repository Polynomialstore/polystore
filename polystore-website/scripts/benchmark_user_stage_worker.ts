import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { NilWasm } from '../public/wasm/polystore_core.js'

type BasisMode = 'blst' | 'affine' | 'projective'

type WorkerInput = {
  basisMode: BasisMode
  trustedSetupPath: string
  wasmPath: string
  rsK: number
  rsM: number
  pipelineMode:
    | 'split'
    | 'split_unprofiled'
    | 'combined'
    | 'fused_batch'
    | 'fused_batch_unprofiled'
    | 'fused_batch_sampled'
}

type TaskPayload = {
  type: 'task'
  id: number
  index: number
  chunk: Uint8Array
}

type ResultPayload = {
  id: number
  index: number
  wall_ms: number
  expand_ms: number
  commit_ms: number
  root_ms: number
  rust_encode_ms: number
  rust_rs_ms: number
  rust_commit_decode_ms: number
  rust_commit_transform_ms: number
  rust_commit_msm_scalar_prep_ms: number
  rust_commit_msm_bucket_fill_ms: number
  rust_commit_msm_reduce_ms: number
  rust_commit_msm_double_ms: number
  rust_commit_msm_ms: number
  rust_commit_compress_ms: number
  raw_bytes: number
}

type SplitPerf = {
  encode_ms?: number
  rs_ms?: number
  total_ms?: number
}

type CommitPerf = {
  decode_ms?: number
  transform_ms?: number
  msm_scalar_prep_ms?: number
  msm_bucket_fill_ms?: number
  msm_reduce_ms?: number
  msm_double_ms?: number
  msm_ms?: number
  compress_ms?: number
  total_ms?: number
}

function toSplitPerf(raw: unknown): SplitPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as SplitPerf
}

function toCommitPerf(raw: unknown): CommitPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as CommitPerf
}

function toU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value as ArrayBufferLike)
}

const input = workerData as WorkerInput
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

if (!parentPort) {
  throw new Error(`benchmark_user_stage_worker must run in a worker thread (${__dirname})`)
}

const wasmBuffer = await fs.readFile(input.wasmPath)
await init({ module_or_path: wasmBuffer })
const trustedSetup = new Uint8Array(await fs.readFile(input.trustedSetupPath))
const wasm = new NilWasm(trustedSetup)
wasm.set_wasm_msm_basis_mode(input.basisMode)

parentPort.on('message', (message: TaskPayload) => {
  if (!message || message.type !== 'task') return

  try {
    const opStart = performance.now()
    let splitPerf: SplitPerf = {}
    let commitPerf: CommitPerf = {}
    let witnessFlat: Uint8Array
    let commitMs = 0

    if (input.pipelineMode === 'combined') {
      const combinedStart = performance.now()
      const expandedRaw = wasm.expand_payload_rs_flat(message.chunk, input.rsK, input.rsM) as unknown
      const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
      const perfRaw = (expanded as { perf?: unknown }).perf as {
        encode_ms?: unknown
        rs_ms?: unknown
        total_ms?: unknown
        commit_decode_ms?: unknown
        commit_transform_ms?: unknown
        commit_msm_scalar_prep_ms?: unknown
        commit_msm_bucket_fill_ms?: unknown
        commit_msm_reduce_ms?: unknown
        commit_msm_double_ms?: unknown
        commit_msm_ms?: unknown
        commit_compress_ms?: unknown
        commit_ms?: unknown
      } | undefined
      splitPerf = {
        encode_ms: Number(perfRaw?.encode_ms ?? 0),
        rs_ms: Number(perfRaw?.rs_ms ?? 0),
        total_ms: Number(perfRaw?.total_ms ?? 0),
      }
      commitPerf = {
        decode_ms: Number(perfRaw?.commit_decode_ms ?? 0),
        transform_ms: Number(perfRaw?.commit_transform_ms ?? 0),
        msm_scalar_prep_ms: Number(perfRaw?.commit_msm_scalar_prep_ms ?? 0),
        msm_bucket_fill_ms: Number(perfRaw?.commit_msm_bucket_fill_ms ?? 0),
        msm_reduce_ms: Number(perfRaw?.commit_msm_reduce_ms ?? 0),
        msm_double_ms: Number(perfRaw?.commit_msm_double_ms ?? 0),
        msm_ms: Number(perfRaw?.commit_msm_ms ?? 0),
        compress_ms: Number(perfRaw?.commit_compress_ms ?? 0),
        total_ms: Number(perfRaw?.commit_ms ?? 0),
      }
      witnessFlat = toU8((expanded as { witness_flat?: unknown }).witness_flat)
      commitMs = performance.now() - combinedStart
    } else if (
      input.pipelineMode === 'fused_batch' ||
      input.pipelineMode === 'fused_batch_unprofiled' ||
      input.pipelineMode === 'fused_batch_sampled'
    ) {
      const fusedStart = performance.now()
      const useProfiled =
        input.pipelineMode === 'fused_batch' ||
        (input.pipelineMode === 'fused_batch_sampled' && message.index === 0)
      const expandedRaw = (
        useProfiled
          ? wasm.expand_payload_rs_flat_committed_profiled(message.chunk, input.rsK, input.rsM)
          : wasm.expand_payload_rs_flat_committed(message.chunk, input.rsK, input.rsM)
      ) as unknown
      const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
      const perfRaw = (expanded as { perf?: unknown }).perf as {
        encode_ms?: unknown
        rs_ms?: unknown
        total_ms?: unknown
        commit_decode_ms?: unknown
        commit_transform_ms?: unknown
        commit_msm_scalar_prep_ms?: unknown
        commit_msm_bucket_fill_ms?: unknown
        commit_msm_reduce_ms?: unknown
        commit_msm_double_ms?: unknown
        commit_msm_ms?: unknown
        commit_compress_ms?: unknown
        commit_ms?: unknown
      } | undefined
      splitPerf = {
        encode_ms: Number(perfRaw?.encode_ms ?? 0),
        rs_ms: Number(perfRaw?.rs_ms ?? 0),
        total_ms: Number(perfRaw?.total_ms ?? 0),
      }
      commitPerf = {
        decode_ms: Number(perfRaw?.commit_decode_ms ?? 0),
        transform_ms: Number(perfRaw?.commit_transform_ms ?? 0),
        msm_scalar_prep_ms: Number(perfRaw?.commit_msm_scalar_prep_ms ?? 0),
        msm_bucket_fill_ms: Number(perfRaw?.commit_msm_bucket_fill_ms ?? 0),
        msm_reduce_ms: Number(perfRaw?.commit_msm_reduce_ms ?? 0),
        msm_double_ms: Number(perfRaw?.commit_msm_double_ms ?? 0),
        msm_ms: Number(perfRaw?.commit_msm_ms ?? 0),
        compress_ms: Number(perfRaw?.commit_compress_ms ?? 0),
        total_ms: Number(perfRaw?.commit_ms ?? 0),
      }
      witnessFlat = toU8((expanded as { witness_flat?: unknown }).witness_flat)
      commitMs = performance.now() - fusedStart
      const rootMs = 0
      const payload: ResultPayload = {
        id: message.id,
        index: message.index,
        raw_bytes: message.chunk.byteLength,
        wall_ms: performance.now() - opStart,
        expand_ms: Number(splitPerf.encode_ms ?? 0) + Number(splitPerf.rs_ms ?? 0),
        commit_ms: Number(commitPerf.total_ms ?? commitMs),
        root_ms: rootMs,
        rust_encode_ms: Number(splitPerf.encode_ms ?? 0),
        rust_rs_ms: Number(splitPerf.rs_ms ?? 0),
        rust_commit_decode_ms: Number(commitPerf.decode_ms ?? 0),
        rust_commit_transform_ms: Number(commitPerf.transform_ms ?? 0),
        rust_commit_msm_scalar_prep_ms: Number(commitPerf.msm_scalar_prep_ms ?? 0),
        rust_commit_msm_bucket_fill_ms: Number(commitPerf.msm_bucket_fill_ms ?? 0),
        rust_commit_msm_reduce_ms: Number(commitPerf.msm_reduce_ms ?? 0),
        rust_commit_msm_double_ms: Number(commitPerf.msm_double_ms ?? 0),
        rust_commit_msm_ms: Number(commitPerf.msm_ms ?? 0),
        rust_commit_compress_ms: Number(commitPerf.compress_ms ?? 0),
      }
      parentPort!.postMessage(payload)
      return
    } else if (input.pipelineMode === 'split') {
      const expandedRaw = wasm.expand_payload_rs_flat_uncommitted(message.chunk, input.rsK, input.rsM) as unknown
      const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
      splitPerf = toSplitPerf((expanded as { perf?: unknown }).perf)
      const shardsFlat = toU8((expanded as { shards_flat?: unknown }).shards_flat)

      const commitStart = performance.now()
      const committedRaw = wasm.commit_blobs_profiled(shardsFlat) as unknown
      const committed = typeof committedRaw === 'string' ? JSON.parse(committedRaw) : committedRaw
      commitPerf = toCommitPerf((committed as { perf?: unknown }).perf)
      witnessFlat = toU8((committed as { witness_flat?: unknown }).witness_flat)
      commitMs = performance.now() - commitStart
    } else {
      const expandedRaw = wasm.expand_payload_rs_flat_uncommitted(message.chunk, input.rsK, input.rsM) as unknown
      const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
      splitPerf = toSplitPerf((expanded as { perf?: unknown }).perf)
      const shardsFlat = toU8((expanded as { shards_flat?: unknown }).shards_flat)

      const commitStart = performance.now()
      witnessFlat = wasm.commit_blobs(shardsFlat)
      commitMs = performance.now() - commitStart
    }

    const rootStart = performance.now()
    wasm.compute_mdu_root(witnessFlat)
    const rootMs = performance.now() - rootStart

    const payload: ResultPayload = {
      id: message.id,
      index: message.index,
      raw_bytes: message.chunk.byteLength,
      wall_ms: performance.now() - opStart,
      expand_ms: Number(
        input.pipelineMode === 'combined'
          ? Number(splitPerf.encode_ms ?? 0) + Number(splitPerf.rs_ms ?? 0)
          : Number(splitPerf.total_ms ?? 0),
      ),
      commit_ms: Number(commitPerf.total_ms ?? commitMs),
      root_ms: rootMs,
      rust_encode_ms: Number(splitPerf.encode_ms ?? 0),
      rust_rs_ms: Number(splitPerf.rs_ms ?? 0),
      rust_commit_decode_ms: Number(commitPerf.decode_ms ?? 0),
      rust_commit_transform_ms: Number(commitPerf.transform_ms ?? 0),
      rust_commit_msm_scalar_prep_ms: Number(commitPerf.msm_scalar_prep_ms ?? 0),
      rust_commit_msm_bucket_fill_ms: Number(commitPerf.msm_bucket_fill_ms ?? 0),
      rust_commit_msm_reduce_ms: Number(commitPerf.msm_reduce_ms ?? 0),
      rust_commit_msm_double_ms: Number(commitPerf.msm_double_ms ?? 0),
      rust_commit_msm_ms: Number(commitPerf.msm_ms ?? 0),
      rust_commit_compress_ms: Number(commitPerf.compress_ms ?? 0),
    }
    parentPort!.postMessage(payload)
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      index: message.index,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
