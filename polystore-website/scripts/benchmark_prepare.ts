import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import { loadKZG, type TrustedSetup } from 'kzg-wasm'
import init, { PolyStoreWasm } from '../public/wasm/polystore_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')

const BLOB_SIZE = 128 * 1024
const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

type ExpandPerf = {
  encode_ms?: number
  rs_ms?: number
  commit_decode_ms?: number
  commit_transform_ms?: number
  commit_msm_scalar_prep_ms?: number
  commit_msm_bucket_fill_ms?: number
  commit_msm_reduce_ms?: number
  commit_msm_double_ms?: number
  commit_msm_ms?: number
  commit_compress_ms?: number
  commit_ms?: number
  total_ms?: number
  rows?: number
  shards_total?: number
  shard_len?: number
}

type SplitPerf = {
  encode_ms?: number
  rs_ms?: number
  total_ms?: number
  rows?: number
  shards_total?: number
  shard_len?: number
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
  blobs?: number
}

type RecordWithWall = {
  index: number
  payload_bytes: number
  wall_ms: number
  expand_stage_ms: number
  commit_ms: number
  root_ms: number
  hex_encode_ms: number
  hex_decode_ms: number
  witness_bytes: number
  mdu_root_hex: string
} & ExpandPerf

type IterationResult = {
  wall_ms: number
  records: RecordWithWall[]
}

function makeDeterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 17 + 31) & 0xff
  }
  return bytes
}

function toExpandRecord(raw: unknown): ExpandPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as ExpandPerf
}

function toSplitRecord(raw: unknown): SplitPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as SplitPerf
}

function toCommitRecord(raw: unknown): CommitPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as CommitPerf
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex
  return new Uint8Array(Buffer.from(normalized, 'hex'))
}

function stats(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return { min: 0, median: 0, mean: 0, max: 0 }
  }
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    min: sorted[0],
    median,
    mean,
    max: sorted[sorted.length - 1],
  }
}

const fileBytes = Number(process.env.FILE_BYTES || RAW_MDU_CAPACITY)
const rsK = Number(process.env.RS_K || 2)
const rsM = Number(process.env.RS_M || 1)
const warmupRuns = Number(process.env.WARMUP_RUNS || 1)
const measureRuns = Number(process.env.MEASURE_RUNS || 3)

if (!Number.isFinite(fileBytes) || fileBytes <= 0) {
  throw new Error(`invalid FILE_BYTES: ${process.env.FILE_BYTES ?? ''}`)
}
if (!Number.isFinite(warmupRuns) || warmupRuns < 0) {
  throw new Error(`invalid WARMUP_RUNS: ${process.env.WARMUP_RUNS ?? ''}`)
}
if (!Number.isFinite(measureRuns) || measureRuns <= 0) {
  throw new Error(`invalid MEASURE_RUNS: ${process.env.MEASURE_RUNS ?? ''}`)
}

const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'polystore_core_bg.wasm')
const wasmBuffer = await fs.readFile(wasmPath)
const polyStoreInitStart = performance.now()
await init({ module_or_path: wasmBuffer })

const trustedSetupPath = path.resolve(websiteRoot, 'public', 'trusted_setup.txt')
const trustedSetup = new Uint8Array(await fs.readFile(trustedSetupPath))
const wasm = new PolyStoreWasm(trustedSetup)
const polyStoreInitMs = performance.now() - polyStoreInitStart

const payload = makeDeterministicPayload(fileBytes)
const totalMdus = Math.ceil(payload.byteLength / RAW_MDU_CAPACITY)

function parseTrustedSetupText(text: string): TrustedSetup {
  const lines = text.trim().split(/\r?\n/)
  const g1Count = Number(lines[0])
  const g2Count = Number(lines[1])
  const monomialStart = 2
  const g2Start = monomialStart + g1Count
  const lagrangeStart = g2Start + g2Count
  return {
    g1_monomial: lines.slice(monomialStart, g2Start).join(''),
    g2_monomial: lines.slice(g2Start, lagrangeStart).join(''),
    g1_lagrange: lines.slice(lagrangeStart, lagrangeStart + g1Count).join(''),
  }
}

async function tryLoadCompatibleKzg(): Promise<
  | { supported: true; initMs: number; source: 'default' | 'polystore_setup'; kzg: Awaited<ReturnType<typeof loadKZG>> }
  | { supported: false; initMs: number; reason: string }
> {
  const blob = new Uint8Array(BLOB_SIZE)
  for (let i = 0; i < BLOB_SIZE; i += 32) {
    blob[i] = 0
    for (let j = 1; j < 32; j += 1) blob[i + j] = (i + j) & 0xff
  }
  const blobHex = bytesToHex(blob)
  const polyStoreHex = bytesToHex(wasm.commit_blobs(blob))

  const defaultInitStart = performance.now()
  const defaultKzg = await loadKZG()
  const defaultInitMs = performance.now() - defaultInitStart
  if (defaultKzg.blobToKZGCommitment(blobHex) === polyStoreHex) {
    return { supported: true, initMs: defaultInitMs, source: 'default', kzg: defaultKzg }
  }

  try {
    const setupText = await fs.readFile(trustedSetupPath, 'utf8')
    const exactSetup = parseTrustedSetupText(setupText)
    const exactInitStart = performance.now()
    const exactKzg = await loadKZG(0, exactSetup)
    const exactInitMs = performance.now() - exactInitStart
    if (exactKzg.blobToKZGCommitment(blobHex) === polyStoreHex) {
      return { supported: true, initMs: exactInitMs, source: 'polystore_setup', kzg: exactKzg }
    }
    return {
      supported: false,
      initMs: defaultInitMs + exactInitMs,
      reason: 'kzg-wasm commitments did not match polystore_core commitments for a canonical blob',
    }
  } catch (error) {
    return {
      supported: false,
      initMs: defaultInitMs,
      reason: `kzg-wasm could not load the PolyStore trusted setup: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

const kzgResolution = await tryLoadCompatibleKzg()

function runIntegratedIteration(): IterationResult {
  const records: RecordWithWall[] = []
  const benchStart = performance.now()

  for (let index = 0; index < totalMdus; index += 1) {
    const start = index * RAW_MDU_CAPACITY
    const end = Math.min(start + RAW_MDU_CAPACITY, payload.byteLength)
    const chunk = payload.subarray(start, end)
    const t0 = performance.now()
    const expandedRaw = wasm.expand_payload_rs_flat(chunk, rsK, rsM) as unknown
    const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
    const witnessFlatRaw = (expanded as { witness_flat?: unknown }).witness_flat
    const witnessFlat =
      witnessFlatRaw instanceof Uint8Array ? witnessFlatRaw : new Uint8Array(witnessFlatRaw as ArrayBufferLike)
    const rootStart = performance.now()
    const rootRaw = wasm.compute_mdu_root(witnessFlat) as unknown
    const rootMs = performance.now() - rootStart
    const rootBytes = rootRaw instanceof Uint8Array ? rootRaw : new Uint8Array(rootRaw as ArrayBufferLike)
    const perf = toExpandRecord((expanded as { perf?: unknown }).perf)
    const wallMs = performance.now() - t0
    records.push({
      index,
      payload_bytes: chunk.byteLength,
      wall_ms: wallMs,
      expand_stage_ms: Number(perf.total_ms ?? 0),
      commit_ms: Number(perf.commit_ms ?? 0),
      root_ms: rootMs,
      hex_encode_ms: 0,
      hex_decode_ms: 0,
      witness_bytes: witnessFlat.byteLength,
      mdu_root_hex: bytesToHex(rootBytes),
      ...perf,
    })
  }

  return {
    wall_ms: performance.now() - benchStart,
    records,
  }
}

function commitShardsWithKzgWasm(shardsFlat: Uint8Array): {
  witnessFlat: Uint8Array
  commitMs: number
  hexEncodeMs: number
  hexDecodeMs: number
} {
  if (!kzgResolution.supported) {
    throw new Error(kzgResolution.reason)
  }
  const kzg = kzgResolution.kzg
  if (shardsFlat.byteLength % BLOB_SIZE !== 0) {
    throw new Error(`invalid shard byte length for commitment: ${shardsFlat.byteLength}`)
  }
  const blobCount = shardsFlat.byteLength / BLOB_SIZE
  const witnessFlat = new Uint8Array(blobCount * 48)
  let commitMs = 0
  let hexEncodeMs = 0
  let hexDecodeMs = 0

  for (let blobIndex = 0; blobIndex < blobCount; blobIndex += 1) {
    const start = blobIndex * BLOB_SIZE
    const end = start + BLOB_SIZE
    const blob = shardsFlat.subarray(start, end)

    const hexEncodeStart = performance.now()
    const blobHex = bytesToHex(blob)
    hexEncodeMs += performance.now() - hexEncodeStart

    const commitStart = performance.now()
    const commitmentHex = kzg.blobToKZGCommitment(blobHex)
    commitMs += performance.now() - commitStart

    const hexDecodeStart = performance.now()
    const commitmentBytes = hexToBytes(commitmentHex)
    hexDecodeMs += performance.now() - hexDecodeStart
    witnessFlat.set(commitmentBytes, blobIndex * 48)
  }

  return { witnessFlat, commitMs, hexEncodeMs, hexDecodeMs }
}

function runSplitIteration(backend: 'polystore_wasm' | 'kzg_wasm'): IterationResult {
  const records: RecordWithWall[] = []
  const benchStart = performance.now()

  for (let index = 0; index < totalMdus; index += 1) {
    const start = index * RAW_MDU_CAPACITY
    const end = Math.min(start + RAW_MDU_CAPACITY, payload.byteLength)
    const chunk = payload.subarray(start, end)

    const t0 = performance.now()
    const expandedRaw = wasm.expand_payload_rs_flat_uncommitted(chunk, rsK, rsM) as unknown
    const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
    const shardsRaw = (expanded as { shards_flat?: unknown }).shards_flat
    const splitPerf = toSplitRecord((expanded as { perf?: unknown }).perf)
    const shardsFlat = shardsRaw instanceof Uint8Array ? shardsRaw : new Uint8Array(shardsRaw as ArrayBufferLike)

    let witnessFlat: Uint8Array
    let commitMs = 0
    let hexEncodeMs = 0
    let hexDecodeMs = 0
    let commitPerf: CommitPerf = {}
    if (backend === 'polystore_wasm') {
      const commitStart = performance.now()
      const committedRaw = wasm.commit_blobs_profiled(shardsFlat) as unknown
      commitMs = performance.now() - commitStart
      const committed = typeof committedRaw === 'string' ? JSON.parse(committedRaw) : committedRaw
      const witnessRaw = (committed as { witness_flat?: unknown }).witness_flat
      witnessFlat = witnessRaw instanceof Uint8Array ? witnessRaw : new Uint8Array(witnessRaw as ArrayBufferLike)
      commitPerf = toCommitRecord((committed as { perf?: unknown }).perf)
    } else {
      const committed = commitShardsWithKzgWasm(shardsFlat)
      witnessFlat = committed.witnessFlat
      commitMs = committed.commitMs
      hexEncodeMs = committed.hexEncodeMs
      hexDecodeMs = committed.hexDecodeMs
    }

    const rootStart = performance.now()
    const rootRaw = wasm.compute_mdu_root(witnessFlat) as unknown
    const rootMs = performance.now() - rootStart
    const rootBytes = rootRaw instanceof Uint8Array ? rootRaw : new Uint8Array(rootRaw as ArrayBufferLike)
    const wallMs = performance.now() - t0

    records.push({
      index,
      payload_bytes: chunk.byteLength,
      wall_ms: wallMs,
      expand_stage_ms: Number(splitPerf.total_ms ?? 0),
      commit_ms: commitMs,
      root_ms: rootMs,
      hex_encode_ms: hexEncodeMs,
      hex_decode_ms: hexDecodeMs,
      witness_bytes: witnessFlat.byteLength,
      mdu_root_hex: bytesToHex(rootBytes),
      encode_ms: Number(splitPerf.encode_ms ?? 0),
      rs_ms: Number(splitPerf.rs_ms ?? 0),
      total_ms: Number(splitPerf.total_ms ?? 0),
      rows: Number(splitPerf.rows ?? 0),
      shards_total: Number(splitPerf.shards_total ?? 0),
      shard_len: Number(splitPerf.shard_len ?? 0),
      commit_decode_ms: Number(commitPerf.decode_ms ?? 0),
      commit_transform_ms: Number(commitPerf.transform_ms ?? 0),
      commit_msm_scalar_prep_ms: Number(commitPerf.msm_scalar_prep_ms ?? 0),
      commit_msm_bucket_fill_ms: Number(commitPerf.msm_bucket_fill_ms ?? 0),
      commit_msm_reduce_ms: Number(commitPerf.msm_reduce_ms ?? 0),
      commit_msm_double_ms: Number(commitPerf.msm_double_ms ?? 0),
      commit_msm_ms: Number(commitPerf.msm_ms ?? 0),
      commit_compress_ms: Number(commitPerf.compress_ms ?? 0),
    })
  }

  return {
    wall_ms: performance.now() - benchStart,
    records,
  }
}

function summarizeRuns(name: string, runs: IterationResult[]) {
  const summarizedRuns = runs.map((run, runIndex) => ({
    run: runIndex + 1,
    wall_ms: run.wall_ms,
    per_mdu_avg_ms: totalMdus > 0 ? run.wall_ms / totalMdus : 0,
    phases: {
      expand_stage_ms: run.records.reduce((sum, record) => sum + record.expand_stage_ms, 0),
      commit_ms: run.records.reduce((sum, record) => sum + record.commit_ms, 0),
      root_ms: run.records.reduce((sum, record) => sum + record.root_ms, 0),
      hex_encode_ms: run.records.reduce((sum, record) => sum + record.hex_encode_ms, 0),
      hex_decode_ms: run.records.reduce((sum, record) => sum + record.hex_decode_ms, 0),
      rust_encode_ms: run.records.reduce((sum, record) => sum + Number(record.encode_ms ?? 0), 0),
      rust_rs_ms: run.records.reduce((sum, record) => sum + Number(record.rs_ms ?? 0), 0),
      rust_commit_decode_ms: run.records.reduce((sum, record) => sum + Number(record.commit_decode_ms ?? 0), 0),
      rust_commit_transform_ms: run.records.reduce((sum, record) => sum + Number(record.commit_transform_ms ?? 0), 0),
      rust_commit_msm_scalar_prep_ms: run.records.reduce((sum, record) => sum + Number(record.commit_msm_scalar_prep_ms ?? 0), 0),
      rust_commit_msm_bucket_fill_ms: run.records.reduce((sum, record) => sum + Number(record.commit_msm_bucket_fill_ms ?? 0), 0),
      rust_commit_msm_reduce_ms: run.records.reduce((sum, record) => sum + Number(record.commit_msm_reduce_ms ?? 0), 0),
      rust_commit_msm_double_ms: run.records.reduce((sum, record) => sum + Number(record.commit_msm_double_ms ?? 0), 0),
      rust_commit_msm_ms: run.records.reduce((sum, record) => sum + Number(record.commit_msm_ms ?? 0), 0),
      rust_commit_compress_ms: run.records.reduce((sum, record) => sum + Number(record.commit_compress_ms ?? 0), 0),
      rust_commit_ms: run.records.reduce((sum, record) => sum + Number(record.commit_ms ?? 0), 0),
      rust_total_ms: run.records.reduce((sum, record) => sum + Number(record.total_ms ?? 0), 0),
    },
    roots: run.records.map((record) => record.mdu_root_hex),
  }))

  return {
    name,
    wall_ms: stats(summarizedRuns.map((run) => run.wall_ms)).median,
    per_mdu_avg_ms: stats(summarizedRuns.map((run) => run.per_mdu_avg_ms)).median,
    stats: {
      wall_ms: stats(summarizedRuns.map((run) => run.wall_ms)),
      per_mdu_avg_ms: stats(summarizedRuns.map((run) => run.per_mdu_avg_ms)),
      phases: {
        expand_stage_ms: stats(summarizedRuns.map((run) => run.phases.expand_stage_ms)),
        commit_ms: stats(summarizedRuns.map((run) => run.phases.commit_ms)),
        root_ms: stats(summarizedRuns.map((run) => run.phases.root_ms)),
        hex_encode_ms: stats(summarizedRuns.map((run) => run.phases.hex_encode_ms)),
        hex_decode_ms: stats(summarizedRuns.map((run) => run.phases.hex_decode_ms)),
        rust_encode_ms: stats(summarizedRuns.map((run) => run.phases.rust_encode_ms)),
        rust_rs_ms: stats(summarizedRuns.map((run) => run.phases.rust_rs_ms)),
        rust_commit_decode_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_decode_ms)),
        rust_commit_transform_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_transform_ms)),
        rust_commit_msm_scalar_prep_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_msm_scalar_prep_ms)),
        rust_commit_msm_bucket_fill_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_msm_bucket_fill_ms)),
        rust_commit_msm_reduce_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_msm_reduce_ms)),
        rust_commit_msm_double_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_msm_double_ms)),
        rust_commit_msm_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_msm_ms)),
        rust_commit_compress_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_compress_ms)),
        rust_commit_ms: stats(summarizedRuns.map((run) => run.phases.rust_commit_ms)),
        rust_total_ms: stats(summarizedRuns.map((run) => run.phases.rust_total_ms)),
      },
    },
    runs: summarizedRuns,
  }
}

for (let i = 0; i < warmupRuns; i += 1) {
  runIntegratedIteration()
  runSplitIteration('polystore_wasm')
  if (kzgResolution.supported) {
    runSplitIteration('kzg_wasm')
  }
}

const integratedRuns: IterationResult[] = []
const splitPolyStoreRuns: IterationResult[] = []
const splitKzgRuns: IterationResult[] = []
for (let i = 0; i < measureRuns; i += 1) {
  integratedRuns.push(runIntegratedIteration())
  splitPolyStoreRuns.push(runSplitIteration('polystore_wasm'))
  if (kzgResolution.supported) {
    splitKzgRuns.push(runSplitIteration('kzg_wasm'))
  }
}

for (let runIndex = 0; runIndex < splitPolyStoreRuns.length; runIndex += 1) {
  const integratedRoots = integratedRuns[runIndex].records.map((record) => record.mdu_root_hex)
  const splitPolyStoreRoots = splitPolyStoreRuns[runIndex].records.map((record) => record.mdu_root_hex)
  if (JSON.stringify(integratedRoots) !== JSON.stringify(splitPolyStoreRoots)) {
    throw new Error(`split polystore_wasm roots diverged on run ${runIndex + 1}`)
  }
  if (kzgResolution.supported) {
    const splitKzgRoots = splitKzgRuns[runIndex].records.map((record) => record.mdu_root_hex)
    if (JSON.stringify(integratedRoots) !== JSON.stringify(splitKzgRoots)) {
      throw new Error(`split kzg_wasm roots diverged on run ${runIndex + 1}`)
    }
  }
}

const summary = {
  file_bytes: payload.byteLength,
  raw_mdu_capacity: RAW_MDU_CAPACITY,
  total_mdus: totalMdus,
  rs_k: rsK,
  rs_m: rsM,
  warmup_runs: warmupRuns,
  measure_runs: measureRuns,
  init: {
    polystore_wasm_ms: polyStoreInitMs,
    kzg_wasm_ms: kzgResolution.initMs,
  },
  kzg_wasm: kzgResolution.supported
    ? { supported: true, source: kzgResolution.source }
    : { supported: false, reason: kzgResolution.reason },
  variants: {
    integrated_polystore_wasm: summarizeRuns('integrated_polystore_wasm', integratedRuns),
    split_polystore_wasm: summarizeRuns('split_polystore_wasm', splitPolyStoreRuns),
    split_kzg_wasm: kzgResolution.supported
      ? summarizeRuns('split_kzg_wasm', splitKzgRuns)
      : null,
  },
}

console.log(JSON.stringify(summary, null, 2))
