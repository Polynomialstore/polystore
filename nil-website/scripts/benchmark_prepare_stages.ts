import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { NilWasm, WasmMdu0Builder } from '../public/wasm/nil_core.js'
import { sanitizeNilfsRecordPath } from '../src/lib/nilfsPath'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')

const BLOBS_PER_MDU = 64
const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

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

type SplitPerf = {
  encode_ms?: number
  rs_ms?: number
  total_ms?: number
  rows?: number
  shards_total?: number
  shard_len?: number
}

type StageRecord = {
  index: number
  kind: 'user' | 'witness' | 'meta'
  raw_bytes: number
  encoded_mdu_bytes: number
  witness_bytes: number
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
  mdu_root_hex: string
}

type StageSummary = {
  wall_ms: number
  records: StageRecord[]
}

type PrepareRun = {
  total_ms: number
  user_stage: StageSummary
  witness_stage: StageSummary
  meta_stage: StageSummary
  manifest_ms: number
  user_count: number
  witness_count: number
  manifest_root_hex: string
}

type BasisMode = 'blst' | 'affine' | 'projective'

type Stats = {
  min: number
  median: number
  mean: number
  max: number
}

function makeDeterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 17 + 31) & 0xff
  }
  return bytes
}

function encodeToMdu(rawData: Uint8Array): Uint8Array {
  const mdu = new Uint8Array(MDU_SIZE_BYTES)
  let readOffset = 0
  let writeOffset = 0
  while (readOffset < rawData.length && writeOffset < MDU_SIZE_BYTES) {
    const chunkLen = Math.min(SCALAR_PAYLOAD_BYTES, rawData.length - readOffset)
    const chunk = rawData.subarray(readOffset, readOffset + chunkLen)
    const pad = SCALAR_BYTES - chunkLen
    mdu.set(chunk, writeOffset + pad)
    readOffset += chunkLen
    writeOffset += SCALAR_BYTES
  }
  return mdu
}

function toU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value as ArrayBufferLike)
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`
}

function readStats(values: number[]): Stats {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return { min: 0, median: 0, mean: 0, max: 0 }
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { min: sorted[0], median, mean, max: sorted[sorted.length - 1] }
}

function summarizeStage(records: StageRecord[]): Omit<StageSummary, 'records'> & { phase_totals: Record<string, number> } {
  return {
    wall_ms: records.reduce((sum, record) => sum + record.wall_ms, 0),
    phase_totals: {
      expand_ms: records.reduce((sum, record) => sum + record.expand_ms, 0),
      commit_ms: records.reduce((sum, record) => sum + record.commit_ms, 0),
      root_ms: records.reduce((sum, record) => sum + record.root_ms, 0),
      rust_encode_ms: records.reduce((sum, record) => sum + record.rust_encode_ms, 0),
      rust_rs_ms: records.reduce((sum, record) => sum + record.rust_rs_ms, 0),
      rust_commit_decode_ms: records.reduce((sum, record) => sum + record.rust_commit_decode_ms, 0),
      rust_commit_transform_ms: records.reduce((sum, record) => sum + record.rust_commit_transform_ms, 0),
      rust_commit_msm_scalar_prep_ms: records.reduce((sum, record) => sum + record.rust_commit_msm_scalar_prep_ms, 0),
      rust_commit_msm_bucket_fill_ms: records.reduce((sum, record) => sum + record.rust_commit_msm_bucket_fill_ms, 0),
      rust_commit_msm_reduce_ms: records.reduce((sum, record) => sum + record.rust_commit_msm_reduce_ms, 0),
      rust_commit_msm_double_ms: records.reduce((sum, record) => sum + record.rust_commit_msm_double_ms, 0),
      rust_commit_msm_ms: records.reduce((sum, record) => sum + record.rust_commit_msm_ms, 0),
      rust_commit_compress_ms: records.reduce((sum, record) => sum + record.rust_commit_compress_ms, 0),
    },
  }
}

function toSplitPerf(raw: unknown): SplitPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as SplitPerf
}

function toCommitPerf(raw: unknown): CommitPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as CommitPerf
}

const fileBytes = Number(process.env.FILE_BYTES || 49_103_158)
const rsK = Number(process.env.RS_K || 2)
const rsM = Number(process.env.RS_M || 1)
const warmupRuns = Number(process.env.WARMUP_RUNS || 0)
const measureRuns = Number(process.env.MEASURE_RUNS || 3)
const fileName = process.env.FILE_NAME || 'benchmark.bin'
const basisMode = (process.env.BASIS_MODE || 'blst') as BasisMode

if (!Number.isFinite(fileBytes) || fileBytes <= 0) throw new Error(`invalid FILE_BYTES: ${process.env.FILE_BYTES ?? ''}`)
if (!Number.isFinite(warmupRuns) || warmupRuns < 0) throw new Error(`invalid WARMUP_RUNS: ${process.env.WARMUP_RUNS ?? ''}`)
if (!Number.isFinite(measureRuns) || measureRuns <= 0) throw new Error(`invalid MEASURE_RUNS: ${process.env.MEASURE_RUNS ?? ''}`)
if (!['blst', 'affine', 'projective'].includes(basisMode)) {
  throw new Error(`invalid BASIS_MODE: ${process.env.BASIS_MODE ?? ''}`)
}

const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'nil_core_bg.wasm')
const wasmBuffer = await fs.readFile(wasmPath)
const wasmInitStart = performance.now()
await init({ module_or_path: wasmBuffer })
const trustedSetupPath = path.resolve(websiteRoot, 'public', 'trusted_setup.txt')
const trustedSetup = new Uint8Array(await fs.readFile(trustedSetupPath))
const wasm = new NilWasm(trustedSetup)
wasm.set_wasm_msm_basis_mode(basisMode)
const wasmInitMs = performance.now() - wasmInitStart

const payload = makeDeterministicPayload(fileBytes)
const totalUserMdus = Math.ceil(payload.byteLength / RAW_MDU_CAPACITY)

function commitEncodedMduProfiled(mduBytes: Uint8Array, index: number, kind: 'witness' | 'meta'): StageRecord {
  const start = performance.now()
  const committedRaw = wasm.commit_blobs_profiled(mduBytes) as unknown
  const commitMs = performance.now() - start
  const committed = typeof committedRaw === 'string' ? JSON.parse(committedRaw) : committedRaw
  const witnessFlat = toU8((committed as { witness_flat?: unknown }).witness_flat)
  const commitPerf = toCommitPerf((committed as { perf?: unknown }).perf)
  const rootStart = performance.now()
  const rootRaw = wasm.compute_mdu_root(witnessFlat) as unknown
  const rootMs = performance.now() - rootStart
  const rootBytes = toU8(rootRaw)
  return {
    index,
    kind,
    raw_bytes: 0,
    encoded_mdu_bytes: mduBytes.byteLength,
    witness_bytes: witnessFlat.byteLength,
    wall_ms: commitMs + rootMs,
    expand_ms: 0,
    commit_ms: commitMs,
    root_ms: rootMs,
    rust_encode_ms: 0,
    rust_rs_ms: 0,
    rust_commit_decode_ms: Number(commitPerf.decode_ms ?? 0),
    rust_commit_transform_ms: Number(commitPerf.transform_ms ?? 0),
    rust_commit_msm_scalar_prep_ms: Number(commitPerf.msm_scalar_prep_ms ?? 0),
    rust_commit_msm_bucket_fill_ms: Number(commitPerf.msm_bucket_fill_ms ?? 0),
    rust_commit_msm_reduce_ms: Number(commitPerf.msm_reduce_ms ?? 0),
    rust_commit_msm_double_ms: Number(commitPerf.msm_double_ms ?? 0),
    rust_commit_msm_ms: Number(commitPerf.msm_ms ?? 0),
    rust_commit_compress_ms: Number(commitPerf.compress_ms ?? 0),
    mdu_root_hex: bytesToHex(rootBytes),
  }
}

function runPrepareStagesIteration(): PrepareRun {
  const totalStart = performance.now()
  const userRecords: StageRecord[] = []
  const witnessRecords: StageRecord[] = []
  const metaRecords: StageRecord[] = []
  const userRoots: Uint8Array[] = []
  const witnessDataBlobs: Uint8Array[] = []

  for (let index = 0; index < totalUserMdus; index += 1) {
    const start = index * RAW_MDU_CAPACITY
    const end = Math.min(start + RAW_MDU_CAPACITY, payload.byteLength)
    const chunk = payload.subarray(start, end)
    const opStart = performance.now()
    const expandedRaw = wasm.expand_payload_rs_flat_uncommitted(chunk, rsK, rsM) as unknown
    const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
    const splitPerf = toSplitPerf((expanded as { perf?: unknown }).perf)
    const shardsFlat = toU8((expanded as { shards_flat?: unknown }).shards_flat)
    const commitStart = performance.now()
    const committedRaw = wasm.commit_blobs_profiled(shardsFlat) as unknown
    const commitMs = performance.now() - commitStart
    const committed = typeof committedRaw === 'string' ? JSON.parse(committedRaw) : committedRaw
    const witnessFlat = toU8((committed as { witness_flat?: unknown }).witness_flat)
    const commitPerf = toCommitPerf((committed as { perf?: unknown }).perf)
    const rootStart = performance.now()
    const rootRaw = wasm.compute_mdu_root(witnessFlat) as unknown
    const rootMs = performance.now() - rootStart
    const rootBytes = toU8(rootRaw)
    userRoots.push(rootBytes)
    witnessDataBlobs.push(witnessFlat)
    userRecords.push({
      index,
      kind: 'user',
      raw_bytes: chunk.byteLength,
      encoded_mdu_bytes: encodeToMdu(chunk).byteLength,
      witness_bytes: witnessFlat.byteLength,
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
      mdu_root_hex: bytesToHex(rootBytes),
    })
  }

  const totalWitnessBytes = witnessDataBlobs.reduce((sum, blob) => sum + blob.byteLength, 0)
  const fullWitnessData = new Uint8Array(totalWitnessBytes)
  let witnessOffset = 0
  for (const blob of witnessDataBlobs) {
    fullWitnessData.set(blob, witnessOffset)
    witnessOffset += blob.byteLength
  }

  const totalWitnessMdus = Math.ceil(fullWitnessData.byteLength / RAW_MDU_CAPACITY)
  const witnessRoots: Uint8Array[] = []
  for (let index = 0; index < totalWitnessMdus; index += 1) {
    const start = index * RAW_MDU_CAPACITY
    const end = Math.min(start + RAW_MDU_CAPACITY, fullWitnessData.byteLength)
    const rawChunk = fullWitnessData.subarray(start, end)
    const encodedMdu = encodeToMdu(rawChunk)
    const record = commitEncodedMduProfiled(encodedMdu, index, 'witness')
    record.raw_bytes = rawChunk.byteLength
    witnessRecords.push(record)
    witnessRoots.push(new Uint8Array(Buffer.from(record.mdu_root_hex.slice(2), 'hex')))
  }

  const commitmentsPerMdu = (rsK + rsM) * (BLOBS_PER_MDU / rsK)
  const builder = (WasmMdu0Builder as unknown as {
    new_with_commitments: (maxUserMdus: bigint, commitmentsPerMdu: bigint) => WasmMdu0Builder
  }).new_with_commitments(BigInt(totalUserMdus), BigInt(commitmentsPerMdu))
  for (let i = 0; i < witnessRoots.length; i += 1) {
    builder.set_root(BigInt(i), witnessRoots[i])
  }
  for (let i = 0; i < userRoots.length; i += 1) {
    builder.set_root(BigInt(totalWitnessMdus + i), userRoots[i])
  }
  const filePath = sanitizeNilfsRecordPath(fileName)
  if (typeof (builder as unknown as { append_file_with_flags?: unknown }).append_file_with_flags === 'function') {
    (builder as unknown as {
      append_file_with_flags: (path: string, size: bigint, startOffset: bigint, flags: number) => void
    }).append_file_with_flags(filePath, BigInt(payload.byteLength), 0n, 0)
  } else {
    builder.append_file(filePath, BigInt(payload.byteLength), 0n)
  }
  const mdu0Bytes = builder.bytes()
  const metaRecord = commitEncodedMduProfiled(mdu0Bytes, 0, 'meta')
  metaRecord.raw_bytes = mdu0Bytes.byteLength
  metaRecords.push(metaRecord)
  const mdu0Root = new Uint8Array(Buffer.from(metaRecord.mdu_root_hex.slice(2), 'hex'))

  const allRoots = new Uint8Array(32 * (1 + witnessRoots.length + userRoots.length))
  allRoots.set(mdu0Root, 0)
  let rootOffset = 32
  for (const root of witnessRoots) {
    allRoots.set(root, rootOffset)
    rootOffset += 32
  }
  for (const root of userRoots) {
    allRoots.set(root, rootOffset)
    rootOffset += 32
  }

  const manifestStart = performance.now()
  const manifest = wasm.compute_manifest(allRoots) as unknown as { root: Uint8Array | ArrayBufferLike }
  const manifestMs = performance.now() - manifestStart
  const manifestRootHex = bytesToHex(toU8(manifest.root))

  return {
    total_ms: performance.now() - totalStart,
    user_stage: { wall_ms: userRecords.reduce((sum, record) => sum + record.wall_ms, 0), records: userRecords },
    witness_stage: { wall_ms: witnessRecords.reduce((sum, record) => sum + record.wall_ms, 0), records: witnessRecords },
    meta_stage: { wall_ms: metaRecords.reduce((sum, record) => sum + record.wall_ms, 0), records: metaRecords },
    manifest_ms: manifestMs,
    user_count: totalUserMdus,
    witness_count: totalWitnessMdus,
    manifest_root_hex: manifestRootHex,
  }
}

for (let i = 0; i < warmupRuns; i += 1) {
  runPrepareStagesIteration()
}

const runs: PrepareRun[] = []
for (let i = 0; i < measureRuns; i += 1) {
  runs.push(runPrepareStagesIteration())
}

const referenceRoot = runs[0]?.manifest_root_hex ?? ''
for (const [index, run] of runs.entries()) {
  if (run.manifest_root_hex !== referenceRoot) {
    throw new Error(`manifest root mismatch on run ${index + 1}: got ${run.manifest_root_hex}, want ${referenceRoot}`)
  }
}

const summary = {
  file_bytes: payload.byteLength,
  raw_mdu_capacity: RAW_MDU_CAPACITY,
  total_user_mdus: totalUserMdus,
  rs_k: rsK,
  rs_m: rsM,
  basis_mode: basisMode,
  warmup_runs: warmupRuns,
  measure_runs: measureRuns,
  init: {
    nil_wasm_ms: wasmInitMs,
  },
  stages: {
    total_ms: readStats(runs.map((run) => run.total_ms)),
    user_stage_ms: readStats(runs.map((run) => run.user_stage.wall_ms)),
    witness_stage_ms: readStats(runs.map((run) => run.witness_stage.wall_ms)),
    meta_stage_ms: readStats(runs.map((run) => run.meta_stage.wall_ms)),
    manifest_ms: readStats(runs.map((run) => run.manifest_ms)),
  },
  phase_totals: {
    user: summarizeStage(runs.flatMap((run) => run.user_stage.records)),
    witness: summarizeStage(runs.flatMap((run) => run.witness_stage.records)),
    meta: summarizeStage(runs.flatMap((run) => run.meta_stage.records)),
  },
  runs,
}

console.log(JSON.stringify(summary, null, 2))
