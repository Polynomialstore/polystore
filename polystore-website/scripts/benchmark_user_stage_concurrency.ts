import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

type BasisMode = 'blst' | 'affine' | 'projective'
type PipelineMode =
  | 'split'
  | 'split_unprofiled'
  | 'combined'
  | 'fused_batch'
  | 'fused_batch_unprofiled'
  | 'fused_batch_sampled'

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
  error?: string
}

type Stats = {
  min: number
  median: number
  mean: number
  max: number
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')

const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

const fileBytes = Number(process.env.FILE_BYTES || 49_103_158)
const rsK = Number(process.env.RS_K || 2)
const rsM = Number(process.env.RS_M || 1)
const cycles = Number(process.env.CYCLES || 3)
const basisMode = (process.env.BASIS_MODE || 'blst') as BasisMode
const pipelineModes = (process.env.PIPELINE_MODES || process.env.PIPELINE_MODE || 'split')
  .split(',')
  .map((value) => value.trim())
  .filter(
    (value): value is PipelineMode =>
      value === 'split' ||
      value === 'split_unprofiled' ||
      value === 'combined' ||
      value === 'fused_batch' ||
      value === 'fused_batch_unprofiled' ||
      value === 'fused_batch_sampled',
  )
const concurrencies = (process.env.CONCURRENCIES || '3,4,5,6')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
  .map((value) => Math.floor(value))

if (!Number.isFinite(fileBytes) || fileBytes <= 0) throw new Error(`invalid FILE_BYTES: ${process.env.FILE_BYTES ?? ''}`)
if (!Number.isFinite(cycles) || cycles <= 0) throw new Error(`invalid CYCLES: ${process.env.CYCLES ?? ''}`)
if (!['blst', 'affine', 'projective'].includes(basisMode)) {
  throw new Error(`invalid BASIS_MODE: ${process.env.BASIS_MODE ?? ''}`)
}
if (concurrencies.length === 0) {
  throw new Error('CONCURRENCIES must include at least one positive integer')
}
if (pipelineModes.length === 0) {
  throw new Error(
    'PIPELINE_MODES must include at least one of split,split_unprofiled,combined,fused_batch,fused_batch_unprofiled',
  )
}

if (
  pipelineModes.some(
    (value) =>
      value !== 'split' &&
      value !== 'split_unprofiled' &&
      value !== 'combined' &&
      value !== 'fused_batch' &&
      value !== 'fused_batch_unprofiled' &&
      value !== 'fused_batch_sampled',
  )
) {
  throw new Error('invalid PIPELINE_MODES')
}

function makeDeterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 17 + 31) & 0xff
  }
  return bytes
}

function readStats(values: number[]): Stats {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return { min: 0, median: 0, mean: 0, max: 0 }
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { min: sorted[0], median, mean, max: sorted[sorted.length - 1] }
}

function chunkPayload(payload: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let index = 0; index * RAW_MDU_CAPACITY < payload.byteLength; index += 1) {
    const start = index * RAW_MDU_CAPACITY
    const end = Math.min(start + RAW_MDU_CAPACITY, payload.byteLength)
    chunks.push(payload.slice(start, end))
  }
  return chunks
}

async function runUserStageIteration(chunks: Uint8Array[], concurrency: number, pipelineMode: PipelineMode) {
  const workerCount = Math.max(1, Math.min(concurrency, chunks.length))
  const workerFile = new URL('./benchmark_user_stage_worker.ts', import.meta.url)
  const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'nil_core_bg.wasm')
  const trustedSetupPath = path.resolve(websiteRoot, 'public', 'trusted_setup.txt')

  const workers = Array.from({ length: workerCount }, () =>
    new Worker(workerFile, {
      workerData: { basisMode, trustedSetupPath, wasmPath, rsK, rsM, pipelineMode },
      execArgv: process.execArgv,
    }),
  )

  const pendingByWorker = new Map<Worker, Set<number>>()
  const results = new Map<number, ResultPayload>()
  let nextMessageId = 1

  const assignTask = (worker: Worker, index: number) =>
    new Promise<void>((resolve, reject) => {
      const id = nextMessageId++
      const pending = pendingByWorker.get(worker) ?? new Set<number>()
      pending.add(id)
      pendingByWorker.set(worker, pending)

      const onMessage = (payload: ResultPayload) => {
        if (payload.id !== id) return
        worker.off('message', onMessage)
        worker.off('error', onError)
        pending.delete(id)
        if (payload.error) {
          reject(new Error(payload.error))
          return
        }
        results.set(index, payload)
        resolve()
      }

      const onError = (error: Error) => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        pending.delete(id)
        reject(error)
      }

      worker.on('message', onMessage)
      worker.on('error', onError)
      const chunk = chunks[index]
      worker.postMessage({ type: 'task', id, index, chunk })
    })

  const start = performance.now()
  let nextIndex = 0
  const runners = workers.map(async (worker) => {
    while (nextIndex < chunks.length) {
      const current = nextIndex
      nextIndex += 1
      await assignTask(worker, current)
    }
  })

  try {
    await Promise.all(runners)
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }

  const ordered = Array.from(results.values()).sort((a, b) => a.index - b.index)
  return {
    pipeline_mode: pipelineMode,
    worker_count: workerCount,
    user_stage_wall_ms: performance.now() - start,
    records: ordered,
    phase_totals: {
      expand_ms: ordered.reduce((sum, record) => sum + record.expand_ms, 0),
      commit_ms: ordered.reduce((sum, record) => sum + record.commit_ms, 0),
      root_ms: ordered.reduce((sum, record) => sum + record.root_ms, 0),
      rust_encode_ms: ordered.reduce((sum, record) => sum + record.rust_encode_ms, 0),
      rust_rs_ms: ordered.reduce((sum, record) => sum + record.rust_rs_ms, 0),
      rust_commit_decode_ms: ordered.reduce((sum, record) => sum + record.rust_commit_decode_ms, 0),
      rust_commit_transform_ms: ordered.reduce((sum, record) => sum + record.rust_commit_transform_ms, 0),
      rust_commit_msm_scalar_prep_ms: ordered.reduce((sum, record) => sum + record.rust_commit_msm_scalar_prep_ms, 0),
      rust_commit_msm_bucket_fill_ms: ordered.reduce((sum, record) => sum + record.rust_commit_msm_bucket_fill_ms, 0),
      rust_commit_msm_reduce_ms: ordered.reduce((sum, record) => sum + record.rust_commit_msm_reduce_ms, 0),
      rust_commit_msm_double_ms: ordered.reduce((sum, record) => sum + record.rust_commit_msm_double_ms, 0),
      rust_commit_msm_ms: ordered.reduce((sum, record) => sum + record.rust_commit_msm_ms, 0),
      rust_commit_compress_ms: ordered.reduce((sum, record) => sum + record.rust_commit_compress_ms, 0),
    },
  }
}

const payload = makeDeterministicPayload(fileBytes)
const chunks = chunkPayload(payload)
const results = new Map<string, { runs: number[]; worker_count: number; pipeline_mode: PipelineMode; concurrency: number }>()

for (let cycle = 0; cycle < cycles; cycle += 1) {
  for (const pipelineMode of pipelineModes) {
    for (const concurrency of concurrencies) {
      const summary = await runUserStageIteration(chunks, concurrency, pipelineMode)
      const key = `${pipelineMode}:${concurrency}`
      const bucket = results.get(key) ?? {
        runs: [],
        worker_count: summary.worker_count,
        pipeline_mode: pipelineMode,
        concurrency,
      }
      bucket.runs.push(summary.user_stage_wall_ms)
      results.set(key, bucket)
    }
  }
}

const output = {
  file_bytes: fileBytes,
  total_user_mdus: chunks.length,
  basis_mode: basisMode,
  pipeline_modes: pipelineModes,
  cycles,
  concurrencies,
  results: Object.fromEntries(
    [...results.entries()].map(([key, result]) => [
      key,
      {
        pipeline_mode: result.pipeline_mode,
        concurrency: result.concurrency,
        worker_count: result.worker_count,
        runs: result.runs,
        stats: readStats(result.runs),
      },
    ]),
  ),
}

console.log(JSON.stringify(output, null, 2))
