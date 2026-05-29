import {
  KZG_BLOB_SIZE,
  KZG_COMMITMENT_SIZE,
  type KzgCommitBackend,
  type KzgCommitPerf,
  type KzgCommitProfiledResult,
} from '../kzgCommitBackend'

export type UserMduExpansionKind = 'mdu' | 'payload'

export type UserMduBrowserKzgWasm = {
  expand_mdu_rs_flat_uncommitted(data: Uint8Array, k: number, m: number): unknown
  expand_payload_rs_flat_uncommitted(data: Uint8Array, k: number, m: number): unknown
  expand_mdu_rs_flat_committed(data: Uint8Array, k: number, m: number): unknown
  expand_payload_rs_flat_committed(data: Uint8Array, k: number, m: number): unknown
  expand_mdu_rs_flat_committed_profiled(data: Uint8Array, k: number, m: number): unknown
  expand_payload_rs_flat_committed_profiled(data: Uint8Array, k: number, m: number): unknown
  compute_mdu_root(witnessFlat: Uint8Array): unknown
}

export type UserMduBrowserKzgPerf = ReturnType<typeof kzgCommitDiagnosticsForBackend> & {
  expandMs: number
  commitMs: number
  rootMs: number
  totalMs: number
  shardCount: number
  shardLen: number
  rustEncodeMs: number
  rustRsMs: number
  rustCommitDecodeMs: number
  rustCommitTransformMs: number
  rustCommitMsmScalarPrepMs: number
  rustCommitMsmBucketFillMs: number
  rustCommitMsmReduceMs: number
  rustCommitMsmDoubleMs: number
  rustCommitMsmMs: number
  rustCommitCompressMs: number
  rustCommitMs: number
  rustTotalMs: number
  rustCommitBackend: string
  rustCommitMsmSubphasesAvailable: boolean
  rows: number
  shardsTotal: number
  browserKzgCommitFallbackReason?: string
}

export type UserMduBrowserKzgResult = {
  witness_flat: Uint8Array
  mdu_root: Uint8Array
  shards_flat: Uint8Array
  shard_len: number
  perf: UserMduBrowserKzgPerf
}

type SplitExpansionPerf = {
  encode_ms?: unknown
  rs_ms?: unknown
  total_ms?: unknown
  rows?: unknown
  shards_total?: unknown
  shard_len?: unknown
}

type CommittedExpansionPerf = SplitExpansionPerf & {
  commit_decode_ms?: unknown
  commit_transform_ms?: unknown
  commit_msm_scalar_prep_ms?: unknown
  commit_msm_bucket_fill_ms?: unknown
  commit_msm_reduce_ms?: unknown
  commit_msm_double_ms?: unknown
  commit_msm_ms?: unknown
  commit_compress_ms?: unknown
  commit_ms?: unknown
}

type ParsedUncommittedExpansion = {
  shardsFlat: Uint8Array
  shardLen: number
  perf: SplitExpansionPerf
}

type ParsedCommittedExpansion = ParsedUncommittedExpansion & {
  witnessFlat: Uint8Array
  mduRoot: Uint8Array
  perf: CommittedExpansionPerf
}

type ExpandWithBrowserKzgOptions = {
  kind: UserMduExpansionKind
  data: Uint8Array
  k: number
  m: number
  profile?: boolean
  wasm: UserMduBrowserKzgWasm
  kzgCommitBackend: KzgCommitBackend
  now?: () => number
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

function numberField(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function toUserMduUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return new Uint8Array(value as ArrayBufferLike)
}

function parseMaybeJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  if (!value || typeof value !== 'object') throw new Error('WASM expansion returned a non-object result')
  return value as Record<string, unknown>
}

function parseUncommittedExpansion(raw: unknown, label: string): ParsedUncommittedExpansion {
  const parsed = parseMaybeJson(raw)
  const shardLen = Number(parsed.shard_len ?? 0)
  if (!Number.isInteger(shardLen) || shardLen <= 0) {
    throw new Error(`${label} returned an invalid shard length`)
  }
  const shardsFlat = toUserMduUint8Array(parsed.shards_flat)
  if (shardsFlat.byteLength === 0 || shardsFlat.byteLength % shardLen !== 0) {
    throw new Error(`${label} returned misaligned shard bytes`)
  }
  if (shardsFlat.byteLength % KZG_BLOB_SIZE !== 0) {
    throw new Error(`${label} returned shard bytes that are not 128 KiB aligned`)
  }
  return {
    shardsFlat,
    shardLen,
    perf: (parsed.perf ?? {}) as SplitExpansionPerf,
  }
}

function parseCommittedExpansion(raw: unknown, label: string): ParsedCommittedExpansion {
  const parsed = parseMaybeJson(raw)
  const base = parseUncommittedExpansion(parsed, label)
  const witnessFlat = toUserMduUint8Array(parsed.witness_flat)
  const mduRoot = toUserMduUint8Array(parsed.mdu_root)
  const expectedWitnessBytes = (base.shardsFlat.byteLength / KZG_BLOB_SIZE) * KZG_COMMITMENT_SIZE
  if (witnessFlat.byteLength !== expectedWitnessBytes) {
    throw new Error(`${label} returned ${witnessFlat.byteLength} witness bytes, expected ${expectedWitnessBytes}`)
  }
  if (mduRoot.byteLength !== 32) {
    throw new Error(`${label} returned ${mduRoot.byteLength} MDU root bytes, expected 32`)
  }
  return {
    ...base,
    witnessFlat,
    mduRoot,
    perf: (parsed.perf ?? {}) as CommittedExpansionPerf,
  }
}

export function kzgCommitDiagnosticsForBackend(kzgCommitBackend: KzgCommitBackend | null | undefined) {
  const status = kzgCommitBackend?.getStatus()
  const scheduler = status?.webgpu?.scheduler
  return {
    rustCommitBackend: status?.selectedBackend === 'webgpu' ? 'webgpu-msm' : 'blst',
    kzgCommitBackend: status?.selectedBackend ?? status?.kind ?? 'unknown',
    kzgWebGpuAvailable: Boolean(status?.webgpu?.available),
    kzgWebGpuFallbackReason: status?.fallbackReason ?? '',
    kzgWebGpuProbeStatus: scheduler?.probeStatus ?? '',
    kzgWebGpuCircuitOpen: Boolean(scheduler?.circuitOpen),
    kzgWebGpuProbeTimeoutMs: scheduler?.probeTimeoutMs ?? 0,
    kzgWebGpuCommitTimeoutMs: scheduler?.commitTimeoutMs ?? 0,
    kzgWebGpuMinBlobs: scheduler?.minBlobs ?? 0,
    kzgWebGpuReductionMode: status?.webgpu?.reductionMode ?? '',
  }
}

function perfFromSplitAndCommit(
  splitPerf: SplitExpansionPerf,
  commitPerf: KzgCommitPerf,
  commitMs: number,
  rootMs: number,
  totalMs: number,
  shardsFlat: Uint8Array,
  shardLen: number,
  diagnostics: ReturnType<typeof kzgCommitDiagnosticsForBackend>,
  fallbackReason?: string,
): UserMduBrowserKzgPerf {
  const expandMs = numberField(splitPerf.encode_ms) + numberField(splitPerf.rs_ms)
  const rustCommitMs = commitPerf.totalMs || commitMs
  const fallbackFields = fallbackReason
    ? {
        browserKzgCommitFallbackReason: fallbackReason,
        kzgWebGpuFallbackReason: diagnostics.kzgWebGpuFallbackReason || fallbackReason,
      }
    : {}
  return {
    expandMs,
    commitMs,
    rootMs,
    totalMs,
    shardCount: Math.floor(shardsFlat.byteLength / shardLen),
    shardLen,
    rustEncodeMs: numberField(splitPerf.encode_ms),
    rustRsMs: numberField(splitPerf.rs_ms),
    rustCommitDecodeMs: commitPerf.decodeMs,
    rustCommitTransformMs: commitPerf.transformMs,
    rustCommitMsmScalarPrepMs: commitPerf.msmScalarPrepMs,
    rustCommitMsmBucketFillMs: commitPerf.msmBucketFillMs,
    rustCommitMsmReduceMs: commitPerf.msmReduceMs,
    rustCommitMsmDoubleMs: commitPerf.msmDoubleMs,
    rustCommitMsmMs: commitPerf.msmMs,
    rustCommitCompressMs: commitPerf.compressMs,
    rustCommitMs,
    rustTotalMs: numberField(splitPerf.total_ms) + rustCommitMs + rootMs,
    rustCommitMsmSubphasesAvailable: false,
    rows: numberField(splitPerf.rows),
    shardsTotal: numberField(splitPerf.shards_total),
    ...diagnostics,
    ...fallbackFields,
  }
}

function committedPerfToKzgCommitPerf(perf: CommittedExpansionPerf): KzgCommitPerf {
  return {
    decodeMs: numberField(perf.commit_decode_ms),
    transformMs: numberField(perf.commit_transform_ms),
    msmScalarPrepMs: numberField(perf.commit_msm_scalar_prep_ms),
    msmBucketFillMs: numberField(perf.commit_msm_bucket_fill_ms),
    msmReduceMs: numberField(perf.commit_msm_reduce_ms),
    msmDoubleMs: numberField(perf.commit_msm_double_ms),
    msmMs: numberField(perf.commit_msm_ms),
    compressMs: numberField(perf.commit_compress_ms),
    totalMs: numberField(perf.commit_ms),
    blobs: numberField(perf.shards_total) * numberField(perf.rows),
  }
}

function committedFallback(
  options: ExpandWithBrowserKzgOptions,
  now: () => number,
  totalStart: number,
  fallbackReason?: string,
): UserMduBrowserKzgResult {
  const { kind, data, k, m, profile = true, wasm, kzgCommitBackend } = options
  const committedRaw = kind === 'mdu'
    ? profile
      ? wasm.expand_mdu_rs_flat_committed_profiled(data, k, m)
      : wasm.expand_mdu_rs_flat_committed(data, k, m)
    : profile
      ? wasm.expand_payload_rs_flat_committed_profiled(data, k, m)
      : wasm.expand_payload_rs_flat_committed(data, k, m)
  const parsed = parseCommittedExpansion(committedRaw, kind === 'mdu' ? 'expandMduRs fallback' : 'expandPayloadRs fallback')
  const diagnostics = {
    ...kzgCommitDiagnosticsForBackend(kzgCommitBackend),
    rustCommitBackend: 'blst',
  }
  const rootMs = 0
  const commitPerf = committedPerfToKzgCommitPerf(parsed.perf)
  return {
    witness_flat: parsed.witnessFlat,
    mdu_root: parsed.mduRoot,
    shards_flat: parsed.shardsFlat,
    shard_len: parsed.shardLen,
    perf: perfFromSplitAndCommit(
      parsed.perf,
      commitPerf,
      numberField(parsed.perf.commit_ms),
      rootMs,
      now() - totalStart,
      parsed.shardsFlat,
      parsed.shardLen,
      diagnostics,
      fallbackReason,
    ),
  }
}

export async function expandUserMduRsWithBrowserKzg(
  options: ExpandWithBrowserKzgOptions,
): Promise<UserMduBrowserKzgResult> {
  const { kind, data, k, m, wasm, kzgCommitBackend } = options
  if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array')
  const now = options.now ?? defaultNow
  const totalStart = now()

  const uncommittedRaw = kind === 'mdu'
    ? wasm.expand_mdu_rs_flat_uncommitted(data, k, m)
    : wasm.expand_payload_rs_flat_uncommitted(data, k, m)
  const expanded = parseUncommittedExpansion(uncommittedRaw, kind === 'mdu' ? 'expandMduRs' : 'expandPayloadRs')

  let committedRaw: KzgCommitProfiledResult
  let commitMs = 0
  let witnessFlat: Uint8Array
  let rootMs = 0
  let rootBytes: Uint8Array
  try {
    const commitStart = now()
    committedRaw = await kzgCommitBackend.commitBlobsProfiled(expanded.shardsFlat)
    commitMs = now() - commitStart
    witnessFlat = committedRaw.witnessFlat
    const expectedWitnessBytes = (expanded.shardsFlat.byteLength / KZG_BLOB_SIZE) * KZG_COMMITMENT_SIZE
    if (witnessFlat.byteLength !== expectedWitnessBytes) {
      throw new Error(`browser KZG returned ${witnessFlat.byteLength} witness bytes, expected ${expectedWitnessBytes}`)
    }

    const rootStart = now()
    const root = wasm.compute_mdu_root(witnessFlat) as unknown
    rootMs = now() - rootStart
    rootBytes = toUserMduUint8Array(root)
    if (rootBytes.byteLength !== 32) {
      throw new Error(`compute_mdu_root returned ${rootBytes.byteLength} bytes, expected 32`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return committedFallback(options, now, totalStart, `browser KZG commit failed validation; used committed WASM fallback: ${message}`)
  }

  const diagnostics = kzgCommitDiagnosticsForBackend(kzgCommitBackend)
  const totalMs = now() - totalStart
  return {
    witness_flat: witnessFlat,
    mdu_root: rootBytes,
    shards_flat: expanded.shardsFlat,
    shard_len: expanded.shardLen,
    perf: perfFromSplitAndCommit(
      expanded.perf,
      committedRaw.perf,
      commitMs,
      rootMs,
      totalMs,
      expanded.shardsFlat,
      expanded.shardLen,
      diagnostics,
    ),
  }
}
