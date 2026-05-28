export const KZG_BLOB_SIZE = 128 * 1024
export const KZG_COMMITMENT_SIZE = 48

export type KzgCommitBackendKind = 'wasm-blst'

export type PolyStoreCommitApi = {
  commit_blobs(blobBytes: Uint8Array): Uint8Array | ArrayBufferLike
  commit_blobs_profiled(blobBytes: Uint8Array): unknown
}

export type KzgCommitPerf = {
  decodeMs: number
  transformMs: number
  msmScalarPrepMs: number
  msmBucketFillMs: number
  msmReduceMs: number
  msmDoubleMs: number
  msmMs: number
  compressMs: number
  totalMs: number
  blobs: number
}

export type KzgCommitProfiledResult = {
  witnessFlat: Uint8Array
  perf: KzgCommitPerf
}

export type KzgCommitBackendStatus = {
  kind: KzgCommitBackendKind
  initialized: boolean
  label: string
}

export type KzgCommitBackend = {
  readonly kind: KzgCommitBackendKind
  getStatus(): KzgCommitBackendStatus
  commitBlobs(blobsFlat: Uint8Array): Uint8Array
  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult
}

export function toUint8Array(value: Uint8Array | ArrayBufferLike): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function assertBlobBatch(blobsFlat: Uint8Array): number {
  if (!(blobsFlat instanceof Uint8Array)) {
    throw new Error('blobsFlat must be a Uint8Array')
  }
  if (blobsFlat.byteLength === 0 || blobsFlat.byteLength % KZG_BLOB_SIZE !== 0) {
    throw new Error('blobsFlat length must be a non-zero multiple of 128 KiB')
  }
  return blobsFlat.byteLength / KZG_BLOB_SIZE
}

function numberField(value: unknown): number {
  return Number(value ?? 0)
}

export function parseKzgCommitProfiledResult(raw: unknown, expectedBlobs: number): KzgCommitProfiledResult {
  const obj = raw as {
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

  if (!obj?.witness_flat) {
    throw new Error('commit_blobs_profiled returned no witness bytes')
  }

  const witnessFlat = toUint8Array(obj.witness_flat)
  const expectedWitnessBytes = expectedBlobs * KZG_COMMITMENT_SIZE
  if (witnessFlat.byteLength !== expectedWitnessBytes) {
    throw new Error(
      `commit_blobs_profiled returned ${witnessFlat.byteLength} witness bytes, expected ${expectedWitnessBytes}`,
    )
  }

  const perf = obj.perf
  return {
    witnessFlat,
    perf: {
      decodeMs: numberField(perf?.decode_ms),
      transformMs: numberField(perf?.transform_ms),
      msmScalarPrepMs: numberField(perf?.msm_scalar_prep_ms),
      msmBucketFillMs: numberField(perf?.msm_bucket_fill_ms),
      msmReduceMs: numberField(perf?.msm_reduce_ms),
      msmDoubleMs: numberField(perf?.msm_double_ms),
      msmMs: numberField(perf?.msm_ms),
      compressMs: numberField(perf?.compress_ms),
      totalMs: numberField(perf?.total_ms),
      blobs: Number(perf?.blobs ?? expectedBlobs),
    },
  }
}

export class WasmBlstKzgCommitBackend implements KzgCommitBackend {
  readonly kind = 'wasm-blst' as const

  constructor(private readonly wasm: PolyStoreCommitApi) {}

  getStatus(): KzgCommitBackendStatus {
    return {
      kind: this.kind,
      initialized: Boolean(this.wasm),
      label: 'WASM blst',
    }
  }

  commitBlobs(blobsFlat: Uint8Array): Uint8Array {
    const expectedBlobs = assertBlobBatch(blobsFlat)
    const commitments = toUint8Array(this.wasm.commit_blobs(blobsFlat))
    const expectedBytes = expectedBlobs * KZG_COMMITMENT_SIZE
    if (commitments.byteLength !== expectedBytes) {
      throw new Error(`commit_blobs returned ${commitments.byteLength} bytes, expected ${expectedBytes}`)
    }
    return commitments
  }

  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult {
    const expectedBlobs = assertBlobBatch(blobsFlat)
    return parseKzgCommitProfiledResult(this.wasm.commit_blobs_profiled(blobsFlat), expectedBlobs)
  }
}

export function createWasmBlstKzgCommitBackend(wasm: PolyStoreCommitApi | null | undefined): KzgCommitBackend {
  if (!wasm) {
    throw new Error('PolyStoreWasm not initialized')
  }
  return new WasmBlstKzgCommitBackend(wasm)
}
