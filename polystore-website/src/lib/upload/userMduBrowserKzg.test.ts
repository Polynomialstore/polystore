import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import init, { PolyStoreWasm } from '../../../public/wasm/polystore_core.js'
import { createWasmBlstKzgCommitBackend, KZG_BLOB_SIZE, type KzgCommitBackend, type KzgCommitBackendStatus } from '../kzgCommitBackend'
import {
  expandUserMduRsWithBrowserKzg,
  parseUserMduUncommittedExpansion,
  toUserMduUint8Array,
  USER_MDU_UNCOMMITTED_CONTRACT,
  type UserMduBrowserKzgWasm,
} from './userMduBrowserKzg'

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < out.length; i += 1) out[i] = (seed + i * 17) & 0xff
  return out
}

function rootFromWitness(witness: Uint8Array): Uint8Array {
  const root = new Uint8Array(32)
  root[0] = witness.byteLength & 0xff
  root[1] = witness[0] ?? 0
  root[2] = witness[witness.length - 1] ?? 0
  return root
}

function makeCommitments(blobs: number, seed = 11): Uint8Array {
  const out = new Uint8Array(blobs * 48)
  for (let i = 0; i < out.length; i += 1) out[i] = (seed + i * 13) & 0xff
  return out
}

function makeCommittedResult(shardsFlat: Uint8Array, shardLen: number, witnessFlat = makeCommitments(shardsFlat.byteLength / KZG_BLOB_SIZE)) {
  return {
    shards_flat: shardsFlat,
    shard_len: shardLen,
    witness_flat: witnessFlat,
    mdu_root: rootFromWitness(witnessFlat),
    perf: {
      encode_ms: 3,
      rs_ms: 4,
      commit_decode_ms: 5,
      commit_transform_ms: 6,
      commit_msm_scalar_prep_ms: 7,
      commit_msm_bucket_fill_ms: 8,
      commit_msm_reduce_ms: 9,
      commit_msm_double_ms: 10,
      commit_msm_ms: 11,
      commit_compress_ms: 12,
      commit_ms: 13,
      total_ms: 20,
      rows: 1,
      shards_total: shardsFlat.byteLength / shardLen,
      shard_len: shardLen,
    },
  }
}

function makeWasm(options?: { committedWitness?: Uint8Array; committedRoot?: Uint8Array }) {
  const calls = {
    mduUncommitted: 0,
    payloadUncommitted: 0,
    mduCommitted: 0,
    payloadCommitted: 0,
    computeRoot: 0,
  }
  const shardLen = KZG_BLOB_SIZE
  const mduShards = bytes(KZG_BLOB_SIZE * 2, 31)
  const payloadShards = bytes(KZG_BLOB_SIZE * 3, 47)
  const wasm: UserMduBrowserKzgWasm = {
    expand_mdu_rs_flat_uncommitted: () => {
      calls.mduUncommitted += 1
      return { shards_flat: mduShards, shard_len: shardLen, perf: { encode_ms: 1, rs_ms: 2, total_ms: 3, rows: 1, shards_total: 2, shard_len: shardLen } }
    },
    expand_payload_rs_flat_uncommitted: () => {
      calls.payloadUncommitted += 1
      return { shards_flat: payloadShards, shard_len: shardLen, perf: { encode_ms: 2, rs_ms: 3, total_ms: 5, rows: 1, shards_total: 3, shard_len: shardLen } }
    },
    expand_mdu_rs_flat_committed: () => {
      calls.mduCommitted += 1
      return makeCommittedResult(mduShards, shardLen, options?.committedWitness)
    },
    expand_payload_rs_flat_committed: () => {
      calls.payloadCommitted += 1
      return makeCommittedResult(payloadShards, shardLen, options?.committedWitness)
    },
    expand_mdu_rs_flat_committed_profiled: () => {
      calls.mduCommitted += 1
      return makeCommittedResult(mduShards, shardLen, options?.committedWitness)
    },
    expand_payload_rs_flat_committed_profiled: () => {
      calls.payloadCommitted += 1
      return makeCommittedResult(payloadShards, shardLen, options?.committedWitness)
    },
    compute_mdu_root: (witnessFlat: Uint8Array) => {
      calls.computeRoot += 1
      return options?.committedRoot ?? rootFromWitness(witnessFlat)
    },
  }
  return { wasm, calls, mduShards, payloadShards, shardLen }
}

function makeBackend(options?: { selectedBackend?: 'webgpu' | 'wasm-blst'; throwCommit?: boolean; witnessSeed?: number; malformedWitness?: boolean }) {
  const calls = { commitProfiled: 0 }
  const backend: KzgCommitBackend = {
    kind: options?.selectedBackend === 'webgpu' ? 'webgpu-scheduler' : 'wasm-blst',
    getStatus(): KzgCommitBackendStatus {
      return {
        kind: this.kind,
        initialized: true,
        label: options?.selectedBackend === 'webgpu' ? 'WebGPU KZG MSM' : 'WASM blst',
        selectedBackend: options?.selectedBackend,
        webgpu: options?.selectedBackend === 'webgpu'
          ? {
              supported: true,
              available: true,
              deviceLost: false,
              fallbackActive: false,
              reductionMode: 'parallel32',
              scheduler: {
                mode: 'auto',
                probeStatus: 'passed',
                probeTimeoutMs: 1500,
                commitTimeoutMs: 3000,
                minBlobs: 1,
                circuitOpen: false,
              },
            }
          : undefined,
      }
    },
    commitBlobs: (blobsFlat: Uint8Array) => makeCommitments(blobsFlat.byteLength / KZG_BLOB_SIZE, options?.witnessSeed),
    commitBlobsProfiled: (blobsFlat: Uint8Array) => {
      calls.commitProfiled += 1
      if (options?.throwCommit) throw new Error('synthetic backend failure')
      return {
        witnessFlat: options?.malformedWitness ? new Uint8Array(1) : makeCommitments(blobsFlat.byteLength / KZG_BLOB_SIZE, options?.witnessSeed),
        perf: {
          decodeMs: 21,
          transformMs: 22,
          msmScalarPrepMs: 23,
          msmBucketFillMs: 24,
          msmReduceMs: 25,
          msmDoubleMs: 26,
          msmMs: 27,
          compressMs: 28,
          totalMs: 29,
          blobs: blobsFlat.byteLength / KZG_BLOB_SIZE,
        },
      }
    },
  }
  return { backend, calls }
}

test('uncommitted expansion parser stamps the deterministic internal contract', () => {
  const shardsFlat = bytes(KZG_BLOB_SIZE * 3, 5)
  const parsed = parseUserMduUncommittedExpansion(
    {
      shards_flat: shardsFlat,
      shard_len: KZG_BLOB_SIZE,
      perf: { encode_ms: 1, rs_ms: 2, total_ms: 3, rows: 1, shards_total: 3, shard_len: KZG_BLOB_SIZE },
    },
    { kind: 'payload', k: 2, m: 1, payloadId: 'fixture', sequence: 12 },
  )

  assert.equal(parsed.contract, USER_MDU_UNCOMMITTED_CONTRACT)
  assert.equal(parsed.payloadId, 'fixture')
  assert.equal(parsed.sequence, 12)
  assert.equal(parsed.kind, 'payload')
  assert.equal(parsed.k, 2)
  assert.equal(parsed.m, 1)
  assert.equal(parsed.shardLen, KZG_BLOB_SIZE)
  assert.deepEqual(parsed.shardsFlat, shardsFlat)
})

test('uncommitted expansion parser rejects shard-count drift before commitment', () => {
  assert.throws(
    () => parseUserMduUncommittedExpansion(
      {
        shards_flat: bytes(KZG_BLOB_SIZE * 2, 9),
        shard_len: KZG_BLOB_SIZE,
        perf: { rows: 1, shards_total: 2 },
      },
      { kind: 'payload', k: 2, m: 1, payloadId: 'bad' },
    ),
    /returned 2 shards, expected 3/,
  )
})

test('user MDU expansion routes commitments through the browser KZG backend', async () => {
  const { wasm, calls, mduShards, shardLen } = makeWasm()
  const { backend, calls: backendCalls } = makeBackend({ selectedBackend: 'webgpu', witnessSeed: 19 })

  const result = await expandUserMduRsWithBrowserKzg({
    kind: 'mdu',
    data: bytes(64),
    k: 2,
    m: 1,
    wasm,
    kzgCommitBackend: backend,
    now: () => 100,
  })

  assert.equal(calls.mduUncommitted, 1)
  assert.equal(calls.mduCommitted, 0)
  assert.equal(backendCalls.commitProfiled, 1)
  assert.deepEqual(result.shards_flat, mduShards)
  assert.equal(result.shard_len, shardLen)
  assert.deepEqual(result.mdu_root, rootFromWitness(result.witness_flat))
  assert.equal(result.perf.rustCommitBackend, 'webgpu-msm')
  assert.equal(result.perf.kzgCommitBackend, 'webgpu')
  assert.equal(result.perf.kzgWebGpuProbeStatus, 'passed')
  assert.equal(result.perf.kzgWebGpuReductionMode, 'parallel32')
  assert.equal(result.perf.rustCommitMs, 29)
  assert.equal(result.perf.rustEncodeMs, 1)
  assert.equal(result.perf.rustRsMs, 2)
})

test('partial payload expansion uses the same browser KZG route and preserves shape', async () => {
  const { wasm, calls, payloadShards, shardLen } = makeWasm()
  const { backend, calls: backendCalls } = makeBackend({ selectedBackend: 'webgpu', witnessSeed: 23 })

  const result = await expandUserMduRsWithBrowserKzg({
    kind: 'payload',
    data: bytes(1000),
    k: 2,
    m: 1,
    wasm,
    kzgCommitBackend: backend,
  })

  assert.equal(calls.payloadUncommitted, 1)
  assert.equal(calls.payloadCommitted, 0)
  assert.equal(backendCalls.commitProfiled, 1)
  assert.equal(result.witness_flat.byteLength, 3 * 48)
  assert.deepEqual(result.shards_flat, payloadShards)
  assert.equal(result.shard_len, shardLen)
  assert.deepEqual(result.mdu_root, rootFromWitness(result.witness_flat))
  assert.equal(result.perf.shardCount, 3)
  assert.equal(result.perf.rows, 1)
  assert.equal(result.perf.shardsTotal, 3)
})

test('browser KZG failure falls back to the existing committed WASM path', async () => {
  const committedWitness = makeCommitments(2, 101)
  const { wasm, calls } = makeWasm({ committedWitness })
  const { backend, calls: backendCalls } = makeBackend({ throwCommit: true })

  const result = await expandUserMduRsWithBrowserKzg({
    kind: 'mdu',
    data: bytes(64),
    k: 2,
    m: 1,
    wasm,
    kzgCommitBackend: backend,
  })

  assert.equal(calls.mduUncommitted, 1)
  assert.equal(calls.mduCommitted, 1)
  assert.equal(backendCalls.commitProfiled, 1)
  assert.deepEqual(result.witness_flat, committedWitness)
  assert.deepEqual(result.mdu_root, rootFromWitness(committedWitness))
  assert.equal(result.perf.rustCommitBackend, 'blst')
  assert.match(result.perf.browserKzgCommitFallbackReason ?? '', /synthetic backend failure/)
  assert.match(result.perf.kzgWebGpuFallbackReason, /synthetic backend failure/)
})

test('browser KZG validation failure falls back to the existing committed WASM path', async () => {
  const committedWitness = makeCommitments(2, 111)
  const { wasm, calls } = makeWasm({ committedWitness })
  const { backend, calls: backendCalls } = makeBackend({ selectedBackend: 'webgpu', malformedWitness: true })

  const result = await expandUserMduRsWithBrowserKzg({
    kind: 'mdu',
    data: bytes(64),
    k: 2,
    m: 1,
    wasm,
    kzgCommitBackend: backend,
  })

  assert.equal(calls.mduUncommitted, 1)
  assert.equal(calls.mduCommitted, 1)
  assert.equal(backendCalls.commitProfiled, 1)
  assert.deepEqual(result.witness_flat, committedWitness)
  assert.deepEqual(result.mdu_root, rootFromWitness(committedWitness))
  assert.equal(result.perf.rustCommitBackend, 'blst')
  assert.match(result.perf.browserKzgCommitFallbackReason ?? '', /failed validation/)
})

test('split browser route can be parity-checked against committed WASM outputs', async () => {
  const parityWitness = makeCommitments(3, 77)
  const parityRoot = rootFromWitness(parityWitness)
  const { wasm } = makeWasm({ committedWitness: parityWitness, committedRoot: parityRoot })
  const { backend } = makeBackend({ selectedBackend: 'webgpu', witnessSeed: 77 })

  const split = await expandUserMduRsWithBrowserKzg({
    kind: 'payload',
    data: bytes(1000),
    k: 2,
    m: 1,
    wasm,
    kzgCommitBackend: backend,
  })
  const committed = wasm.expand_payload_rs_flat_committed_profiled(bytes(1000), 2, 1) as {
    witness_flat: Uint8Array
    mdu_root: Uint8Array
  }

  assert.deepEqual(split.witness_flat, committed.witness_flat)
  assert.deepEqual(split.mdu_root, committed.mdu_root)
})

const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

let realWasmReady: Promise<unknown> | null = null

async function loadRealPolyStoreWasm(): Promise<PolyStoreWasm> {
  if (!realWasmReady) {
    realWasmReady = init({
      module_or_path: await fs.readFile(new URL('../../../public/wasm/polystore_core_bg.wasm', import.meta.url)),
    })
  }
  await realWasmReady
  const trustedSetup = new Uint8Array(await fs.readFile(new URL('../../../public/trusted_setup.txt', import.meta.url)))
  return new PolyStoreWasm(trustedSetup)
}

function encodeToMdu(rawData: Uint8Array): Uint8Array {
  const mdu = new Uint8Array(MDU_SIZE_BYTES)
  let readOffset = 0
  let writeOffset = 0
  while (readOffset < rawData.length && writeOffset < MDU_SIZE_BYTES) {
    const chunkLen = Math.min(SCALAR_PAYLOAD_BYTES, rawData.length - readOffset)
    const pad = SCALAR_BYTES - chunkLen
    mdu.set(rawData.subarray(readOffset, readOffset + chunkLen), writeOffset + pad)
    readOffset += chunkLen
    writeOffset += SCALAR_BYTES
  }
  return mdu
}

function parseRealCommitted(raw: unknown): { witness_flat: Uint8Array; mdu_root: Uint8Array; shards_flat: Uint8Array; shard_len: number } {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>
  return {
    witness_flat: toUserMduUint8Array(parsed.witness_flat),
    mdu_root: toUserMduUint8Array(parsed.mdu_root),
    shards_flat: toUserMduUint8Array(parsed.shards_flat),
    shard_len: Number(parsed.shard_len ?? 0),
  }
}

async function assertRealWasmParity(kind: 'mdu' | 'payload', data: Uint8Array): Promise<void> {
  const wasm = await loadRealPolyStoreWasm()
  const k = 64
  const m = 1
  const committedRaw = kind === 'mdu'
    ? wasm.expand_mdu_rs_flat_committed_profiled(data, k, m)
    : wasm.expand_payload_rs_flat_committed_profiled(data, k, m)
  const committed = parseRealCommitted(committedRaw)
  const split = await expandUserMduRsWithBrowserKzg({
    kind,
    data,
    k,
    m,
    wasm,
    kzgCommitBackend: createWasmBlstKzgCommitBackend(wasm),
  })

  assert.deepEqual(split.witness_flat, committed.witness_flat)
  assert.deepEqual(split.mdu_root, committed.mdu_root)
  assert.deepEqual(split.shards_flat, committed.shards_flat)
  assert.equal(split.shard_len, committed.shard_len)
  assert.equal(split.perf.kzgCommitBackend, 'wasm-blst')
  assert.equal(split.perf.rustCommitBackend, 'blst')
}

test('real WASM parity covers a full encoded MDU and a partial payload', { timeout: 180_000 }, async () => {
  await assertRealWasmParity('mdu', encodeToMdu(bytes(RAW_MDU_CAPACITY, 89)))
  await assertRealWasmParity('payload', bytes(4096, 97))
})

test('invalid uncommitted shard contracts fail before commitment', async () => {
  const { wasm } = makeWasm()
  const { backend, calls } = makeBackend({ selectedBackend: 'webgpu' })
  wasm.expand_mdu_rs_flat_uncommitted = () => ({ shards_flat: bytes(7), shard_len: 0, perf: {} })

  await assert.rejects(
    expandUserMduRsWithBrowserKzg({
      kind: 'mdu',
      data: bytes(64),
      k: 2,
      m: 1,
      wasm,
      kzgCommitBackend: backend,
    }),
    /invalid shard length/,
  )
  assert.equal(calls.commitProfiled, 0)
})
