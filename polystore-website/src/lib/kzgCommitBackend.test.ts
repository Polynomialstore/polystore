import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  KZG_BLOB_SIZE,
  KZG_COMMITMENT_SIZE,
  POLYSTORE_TRUSTED_SETUP_SHA256,
  WasmBlstKzgCommitBackend,
  createBrowserKzgCommitBackend,
  createWasmBlstKzgCommitBackend,
  parseTrustedSetupG1Srs,
  parseKzgCommitProfiledResult,
} from './kzgCommitBackend'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type PolyStoreWasmLike = {
  commit_blobs: (blobBytes: Uint8Array) => Uint8Array
  commit_blobs_profiled: (blobBytes: Uint8Array) => unknown
}

async function loadPolyStoreCoreWasm(): Promise<null | {
  init: (args: unknown) => Promise<unknown>
  PolyStoreWasm: new (trustedSetupBytes: Uint8Array) => PolyStoreWasmLike
  wasmPath: string
}> {
  const jsPath = path.resolve(__dirname, '../../public/wasm/polystore_core.js')
  const wasmPath = path.resolve(__dirname, '../../public/wasm/polystore_core_bg.wasm')
  try {
    await fs.access(jsPath)
    await fs.access(wasmPath)
  } catch {
    return null
  }
  const mod = (await import(pathToFileURL(jsPath).href)) as {
    default: (args: unknown) => Promise<unknown>
    PolyStoreWasm: new (trustedSetupBytes: Uint8Array) => PolyStoreWasmLike
  }
  return { init: mod.default, PolyStoreWasm: mod.PolyStoreWasm, wasmPath }
}

function blobBatch(blobs: number): Uint8Array {
  return new Uint8Array(KZG_BLOB_SIZE * blobs)
}

function validBlob(seed: number): Uint8Array {
  const blob = new Uint8Array(KZG_BLOB_SIZE)
  for (let i = 0; i < KZG_BLOB_SIZE / 32; i += 1) {
    const offset = i * 32
    blob[offset] = 0
    for (let j = 1; j < 32; j += 1) {
      blob[offset + j] = (seed + i * 17 + j * 29) & 0xff
    }
  }
  return blob
}

function commitments(blobs: number, seed = 1): Uint8Array {
  const out = new Uint8Array(KZG_COMMITMENT_SIZE * blobs)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (seed + i) & 0xff
  }
  return out
}

function mockWasm(blobs = 1): PolyStoreWasmLike {
  return {
    commit_blobs: () => commitments(blobs),
    commit_blobs_profiled: () => ({ witness_flat: commitments(blobs), perf: { blobs } }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function loadTrustedSetupBytes(): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.resolve(__dirname, '../../public/trusted_setup.txt')))
}

test('wasm blst backend reports default status', () => {
  const backend = new WasmBlstKzgCommitBackend({
    commit_blobs: () => commitments(1),
    commit_blobs_profiled: () => ({ witness_flat: commitments(1), perf: { blobs: 1 } }),
  })

  assert.deepEqual(backend.getStatus(), {
    kind: 'wasm-blst',
    initialized: true,
    label: 'WASM blst',
  })
})

test('wasm blst backend wraps direct commit_blobs output unchanged', () => {
  const expected = commitments(2, 17)
  const backend = new WasmBlstKzgCommitBackend({
    commit_blobs: (input) => {
      assert.equal(input.byteLength, KZG_BLOB_SIZE * 2)
      return expected
    },
    commit_blobs_profiled: () => ({ witness_flat: expected, perf: { blobs: 2 } }),
  })

  assert.strictEqual(backend.commitBlobs(blobBatch(2)), expected)
})

test('wasm blst backend preserves empty commit_blobs batches', () => {
  const expected = new Uint8Array()
  const backend = new WasmBlstKzgCommitBackend({
    commit_blobs: (input) => {
      assert.equal(input.byteLength, 0)
      return expected
    },
    commit_blobs_profiled: () => ({ witness_flat: expected, perf: { blobs: 0 } }),
  })

  assert.strictEqual(backend.commitBlobs(new Uint8Array()), expected)
  assert.deepEqual(backend.commitBlobsProfiled(new Uint8Array()), {
    witnessFlat: expected,
    perf: {
      decodeMs: 0,
      transformMs: 0,
      msmScalarPrepMs: 0,
      msmBucketFillMs: 0,
      msmReduceMs: 0,
      msmDoubleMs: 0,
      msmMs: 0,
      compressMs: 0,
      totalMs: 0,
      blobs: 0,
    },
  })
})

test('wasm blst backend rejects invalid batch shape and invalid output length', () => {
  const backend = new WasmBlstKzgCommitBackend({
    commit_blobs: () => new Uint8Array(1),
    commit_blobs_profiled: () => ({ witness_flat: new Uint8Array(1), perf: { blobs: 1 } }),
  })

  assert.throws(() => backend.commitBlobs(new Uint8Array(KZG_BLOB_SIZE + 1)), /multiple/)
  assert.throws(() => backend.commitBlobs(blobBatch(1)), /commit_blobs returned 1 bytes/)
})

test('profiled parser normalizes wasm field names', () => {
  const witnessFlat = commitments(3)
  const parsed = parseKzgCommitProfiledResult(
    {
      witness_flat: witnessFlat.buffer,
      perf: {
        decode_ms: 1,
        transform_ms: 2,
        msm_scalar_prep_ms: 3,
        msm_bucket_fill_ms: 4,
        msm_reduce_ms: 5,
        msm_double_ms: 6,
        msm_ms: 7,
        compress_ms: 8,
        total_ms: 9,
        blobs: 3,
      },
    },
    3,
  )

  assert.equal(parsed.witnessFlat.byteLength, KZG_COMMITMENT_SIZE * 3)
  assert.equal(parsed.perf.decodeMs, 1)
  assert.equal(parsed.perf.transformMs, 2)
  assert.equal(parsed.perf.msmScalarPrepMs, 3)
  assert.equal(parsed.perf.msmBucketFillMs, 4)
  assert.equal(parsed.perf.msmReduceMs, 5)
  assert.equal(parsed.perf.msmDoubleMs, 6)
  assert.equal(parsed.perf.msmMs, 7)
  assert.equal(parsed.perf.compressMs, 8)
  assert.equal(parsed.perf.totalMs, 9)
  assert.equal(parsed.perf.blobs, 3)
})

test('createWasmBlstKzgCommitBackend fails closed before wasm init', () => {
  assert.throws(() => createWasmBlstKzgCommitBackend(null), /PolyStoreWasm not initialized/)
})

test('trusted setup parser validates pinned SRS shape for WebGPU residency', async () => {
  const parsed = parseTrustedSetupG1Srs(await loadTrustedSetupBytes())

  assert.equal(parsed.g1Count, 4096)
  assert.equal(parsed.g2Count, 65)
  assert.equal(parsed.g1Bytes, 4096 * KZG_COMMITMENT_SIZE)
  assert.equal(parsed.g1Compressed.byteLength, 4096 * KZG_COMMITMENT_SIZE)
  assert.equal(parsed.basis, 'lagrange-or-monomial-g1-compressed')
})

test('browser backend falls back when WebGPU is unavailable', async () => {
  const backend = await createBrowserKzgCommitBackend(mockWasm(1), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    navigatorLike: {} as unknown as Navigator,
  })

  assert.equal(backend.kind, 'webgpu-wasm-fallback')
  assert.deepEqual(backend.commitBlobs(blobBatch(1)), commitments(1))
  const status = backend.getStatus()
  assert.equal(status.webgpu?.supported, false)
  assert.equal(status.webgpu?.available, false)
  assert.equal(status.webgpu?.fallbackActive, true)
  assert.match(status.fallbackReason || '', /navigator\.gpu is unavailable/)
})

test('browser backend uploads SRS to a persistent WebGPU buffer and keeps WASM as commit path', async () => {
  const setupBytes = await loadTrustedSetupBytes()
  const writes: Array<{ offset: number; bytes: number }> = []
  const buffer = { destroyed: false, destroy() { this.destroyed = true } }
  const deviceLost = deferred<{ reason?: string; message?: string }>()
  const backend = await createBrowserKzgCommitBackend(mockWasm(2), setupBytes, {
    preferWebGpu: true,
    navigatorLike: {
      gpu: {
        requestAdapter: async () => ({
          requestDevice: async () => ({
            queue: {
              writeBuffer: (_buffer: unknown, offset: number, data: Uint8Array) => {
                writes.push({ offset, bytes: data.byteLength })
              },
            },
            lost: deviceLost.promise,
            createBuffer: (descriptor: { size: number }) => {
              assert.equal(descriptor.size, 4096 * KZG_COMMITMENT_SIZE)
              return buffer
            },
          }),
        }),
      },
    } as unknown as Navigator,
    bufferUsage: { STORAGE: 1, COPY_DST: 2 },
  })

  assert.equal(backend.kind, 'webgpu-wasm-fallback')
  assert.deepEqual(backend.commitBlobs(blobBatch(2)), commitments(2))
  assert.deepEqual(writes, [{ offset: 0, bytes: 4096 * KZG_COMMITMENT_SIZE }])
  const status = backend.getStatus()
  assert.equal(status.webgpu?.supported, true)
  assert.equal(status.webgpu?.available, true)
  assert.equal(status.webgpu?.fallbackActive, true)
  assert.equal(status.webgpu?.srs?.sha256, POLYSTORE_TRUSTED_SETUP_SHA256)
  assert.match(status.fallbackReason || '', /commitments use WASM/)
})

test('browser backend contains WebGPU init failure and falls back to WASM', async () => {
  const backend = await createBrowserKzgCommitBackend(mockWasm(1), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    navigatorLike: {
      gpu: {
        requestAdapter: async () => {
          throw new Error('adapter denied')
        },
      },
    } as unknown as Navigator,
    bufferUsage: { STORAGE: 1, COPY_DST: 2 },
  })

  assert.deepEqual(backend.commitBlobs(blobBatch(1)), commitments(1))
  const status = backend.getStatus()
  assert.equal(status.webgpu?.supported, true)
  assert.equal(status.webgpu?.available, false)
  assert.match(status.fallbackReason || '', /adapter denied/)
})

test('browser backend marks device loss unavailable without changing commitment output', async () => {
  const deviceLost = deferred<{ reason?: string; message?: string }>()
  const buffer = { destroyed: false, destroy() { this.destroyed = true } }
  const backend = await createBrowserKzgCommitBackend(mockWasm(1), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    navigatorLike: {
      gpu: {
        requestAdapter: async () => ({
          requestDevice: async () => ({
            queue: { writeBuffer: () => undefined },
            lost: deviceLost.promise,
            createBuffer: () => buffer,
          }),
        }),
      },
    } as unknown as Navigator,
    bufferUsage: { STORAGE: 1, COPY_DST: 2 },
  })

  assert.equal(backend.getStatus().webgpu?.available, true)
  deviceLost.resolve({ reason: 'destroyed', message: 'test device loss' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const status = backend.getStatus()
  assert.equal(buffer.destroyed, true)
  assert.equal(status.webgpu?.available, false)
  assert.equal(status.webgpu?.deviceLost, true)
  assert.match(status.fallbackReason || '', /destroyed/)
  assert.deepEqual(backend.commitBlobs(blobBatch(1)), commitments(1))
})

test('browser backend fails closed on incompatible trusted setup bytes before GPU upload', async () => {
  let adapterRequested = false
  const backend = await createBrowserKzgCommitBackend(mockWasm(1), new TextEncoder().encode('1\n0\n00\n'), {
    preferWebGpu: true,
    navigatorLike: {
      gpu: {
        requestAdapter: async () => {
          adapterRequested = true
          return null
        },
      },
    } as unknown as Navigator,
    bufferUsage: { STORAGE: 1, COPY_DST: 2 },
  })

  assert.equal(adapterRequested, false)
  assert.deepEqual(backend.commitBlobs(blobBatch(1)), commitments(1))
  const status = backend.getStatus()
  assert.equal(status.webgpu?.available, false)
  assert.match(status.fallbackReason || '', /below required blob domain/)
})

test('browser backend fails closed on trusted setup hash mismatch before adapter request', async () => {
  const setupBytes = await loadTrustedSetupBytes()
  const tampered = setupBytes.slice()
  const firstG1ByteOffset = new TextDecoder().decode(tampered).indexOf('\n', new TextDecoder().decode(tampered).indexOf('\n') + 1) + 1
  tampered[firstG1ByteOffset] = tampered[firstG1ByteOffset] === 'a'.charCodeAt(0) ? 'b'.charCodeAt(0) : 'a'.charCodeAt(0)
  let adapterRequested = false

  const backend = await createBrowserKzgCommitBackend(mockWasm(1), tampered, {
    preferWebGpu: true,
    navigatorLike: {
      gpu: {
        requestAdapter: async () => {
          adapterRequested = true
          return null
        },
      },
    } as unknown as Navigator,
    bufferUsage: { STORAGE: 1, COPY_DST: 2 },
  })

  assert.equal(adapterRequested, false)
  assert.deepEqual(backend.commitBlobs(blobBatch(1)), commitments(1))
  assert.match(backend.getStatus().fallbackReason || '', /Trusted setup SHA-256 mismatch/)
})

test('wasm blst backend output matches direct PolyStoreWasm commit_blobs', async (t) => {
  const wasm = await loadPolyStoreCoreWasm()
  if (!wasm) {
    t.skip('WASM artifacts not present (polystore-website/public/wasm).')
    return
  }

  const wasmBuffer = await fs.readFile(wasm.wasmPath)
  await wasm.init({ module_or_path: wasmBuffer })
  const trustedSetupPath = path.resolve(__dirname, '../../public/trusted_setup.txt')
  const trustedSetupBytes = new Uint8Array(await fs.readFile(trustedSetupPath))
  const polyStoreWasm = new wasm.PolyStoreWasm(trustedSetupBytes)
  const backend = createWasmBlstKzgCommitBackend(polyStoreWasm)
  const input = validBlob(23)

  assert.deepEqual(backend.commitBlobs(input), polyStoreWasm.commit_blobs(input))
})
