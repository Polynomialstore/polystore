import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { NilWasm } from '../public/wasm/nil_core.js'

type BasisMode = 'blst' | 'affine' | 'projective'

type WorkerInput = {
  basisMode: BasisMode
  trustedSetupPath: string
  wasmPath: string
  rsK: number
  rsM: number
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
    const expandedRaw = wasm.expand_payload_rs_flat_uncommitted(message.chunk, input.rsK, input.rsM) as unknown
    const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
    const splitPerf = toSplitPerf((expanded as { perf?: unknown }).perf)
    const shardsFlat = toU8((expanded as { shards_flat?: unknown }).shards_flat)

    const commitStart = performance.now()
    const committedRaw = wasm.commit_blobs_profiled(shardsFlat) as unknown
    const committed = typeof committedRaw === 'string' ? JSON.parse(committedRaw) : committedRaw
    const commitPerf = toCommitPerf((committed as { perf?: unknown }).perf)
    const witnessFlat = toU8((committed as { witness_flat?: unknown }).witness_flat)
    const commitMs = performance.now() - commitStart

    const rootStart = performance.now()
    wasm.compute_mdu_root(witnessFlat)
    const rootMs = performance.now() - rootStart

    const payload: ResultPayload = {
      id: message.id,
      index: message.index,
      raw_bytes: message.chunk.byteLength,
      wall_ms: performance.now() - opStart,
      expand_ms: Number(splitPerf.total_ms ?? 0),
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
