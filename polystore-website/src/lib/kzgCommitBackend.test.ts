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
import {
  WebGpuKzgMsmCalibrationCache,
  defaultWebGpuKzgMsmAdapterCalibration,
  type WebGpuKzgMsmOptions,
} from './webgpuKzgMsm'

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

function dynamicMockWasm(): PolyStoreWasmLike {
  return {
    commit_blobs: (input) => commitments(input.byteLength / KZG_BLOB_SIZE),
    commit_blobs_profiled: (input) => {
      const blobs = input.byteLength / KZG_BLOB_SIZE
      return { witness_flat: commitments(blobs), perf: { blobs } }
    },
  }
}

function fakeNavigator(info: Record<string, unknown> = {}) {
  return {
    gpu: {
      requestAdapter: async () => ({
        info,
        requestDevice: async () => ({
          queue: { writeBuffer: () => undefined },
          createBuffer: () => ({}),
        }),
      }),
    },
  } as unknown as Navigator
}

function fakeCommitter(options: {
  totalMs?: number
  delayMs?: number
  commitmentsSeed?: number
  bucketWidth?: number
  reductionMode?: 'serial' | 'parallel16' | 'parallel32' | 'parallel64'
}) {
  const destroyed = { value: false }
  return {
    destroyed,
    committer: {
      destroy: () => {
        destroyed.value = true
      },
      getDeviceLostInfo: async () => null,
      commitBlobs: async (input: Uint8Array) => {
        if (options.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        }
        const blobs = input.byteLength / KZG_BLOB_SIZE
        const totalMs = options.totalMs ?? 10
        return {
          commitments: commitments(blobs, options.commitmentsSeed ?? 1),
          timings: {
            scalarPrepMs: 0,
            bucketBuildMs: 0,
            uploadMs: 0,
            dispatchReadbackMs: totalMs,
            foldMs: 0,
            totalMs,
          },
          blobs,
          debug: {
            bucketWidth: options.bucketWidth ?? 10,
            reductionMode: options.reductionMode ?? 'serial',
            bucketCount: 1,
            baseIndexCount: 1,
            numWindows: 1,
            maxBucketSize: 1,
            meanBucketSize: 1,
            uploadBytes: 4,
            readbackBytes: 384,
            windowSumNonZeroBytes: 1,
            processedBlobs: blobs,
            commandSubmissions: blobs,
            readbackCount: blobs,
            scratchCapacityBytes: 4096,
            scratchResizeCount: 1,
          },
        }
      },
    },
  }
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

test('browser backend starts with a bounded WebGPU scheduler and WASM fallback', async () => {
  const setupBytes = await loadTrustedSetupBytes()
  const backend = await createBrowserKzgCommitBackend(mockWasm(2), setupBytes, {
    preferWebGpu: true,
    navigatorLike: fakeNavigator({ vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }),
  })

  assert.equal(backend.kind, 'webgpu-scheduler')
  const status = backend.getStatus()
  assert.equal(status.webgpu?.supported, true)
  assert.equal(status.webgpu?.available, false)
  assert.equal(status.webgpu?.fallbackActive, true)
  assert.equal(status.selectedBackend, 'wasm-blst')
  assert.equal(status.webgpu?.srs?.sha256, POLYSTORE_TRUSTED_SETUP_SHA256)
  assert.equal(status.webgpu?.scheduler?.probeStatus, 'not-run')
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

test('browser backend rejects fallback adapters before scheduler selection', async () => {
  const backend = await createBrowserKzgCommitBackend(mockWasm(1), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    navigatorLike: fakeNavigator({ vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true }),
  })

  const status = backend.getStatus()
  assert.equal(status.webgpu?.available, false)
  assert.match(status.fallbackReason || '', /fallback\/software adapter/)
})

test('browser backend selects WebGPU after bounded parity probe', async () => {
  const fake = fakeCommitter({ totalMs: 5, reductionMode: 'serial' })
  const backend = await createBrowserKzgCommitBackend(dynamicMockWasm(), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    webGpuMode: 'force',
    navigatorLike: fakeNavigator({ vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }),
    webGpuCommitterFactory: async () => fake.committer as never,
    now: (() => {
      let current = 0
      return () => {
        current += 1
        return current
      }
    })(),
  })

  assert.deepEqual(await backend.commitBlobs(blobBatch(2)), commitments(2))
  const status = backend.getStatus()
  assert.equal(status.selectedBackend, 'webgpu')
  assert.equal(status.webgpu?.fallbackActive, false)
  assert.equal(status.webgpu?.scheduler?.probeStatus, 'passed')
  assert.equal(status.webgpu?.reductionMode, 'serial')
})

test('browser backend applies bounded calibration winner and reports diagnostics', async () => {
  const calls: Array<WebGpuKzgMsmOptions | undefined> = []
  const backend = await createBrowserKzgCommitBackend(dynamicMockWasm(), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    webGpuMode: 'force',
    webGpuCalibrationMode: 'force',
    webGpuCalibrationBlobCount: 1,
    webGpuCalibrationRuns: 1,
    webGpuCalibrationTimeoutMs: 1000,
    webGpuCalibrationCache: new WebGpuKzgMsmCalibrationCache({ storage: null }),
    navigatorLike: fakeNavigator({ vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }),
    webGpuCommitterFactory: async (options) => {
      calls.push(options)
      const totalMs = options?.bucketWidth === 12 && options.reductionMode === 'parallel16' ? 5 : 20
      return fakeCommitter({ totalMs, bucketWidth: options?.bucketWidth, reductionMode: options?.reductionMode }).committer as never
    },
  })

  assert.deepEqual(await backend.commitBlobs(blobBatch(2)), commitments(2))
  const status = backend.getStatus()
  assert.equal(status.selectedBackend, 'webgpu')
  assert.equal(status.webgpu?.bucketWidth, 12)
  assert.equal(status.webgpu?.reductionMode, 'parallel16')
  assert.equal(status.webgpu?.calibration?.status, 'passed')
  assert.equal(status.webgpu?.calibration?.source, 'benchmark-matrix')
  assert.equal(status.webgpu?.scheduler?.bucketWidth, 12)
  assert.ok(calls.some((call) => call?.bucketWidth === 10 && call.reductionMode === 'serial'))
  assert.ok(calls.some((call) => call?.bucketWidth === 12 && call.reductionMode === 'parallel16'))
})

test('browser backend uses cached calibration instead of default adapter rule', async () => {
  const info = { vendor: 'nvidia', architecture: 'ampere', device: 'rtx-3060-ti', isFallbackAdapter: false }
  const cache = new WebGpuKzgMsmCalibrationCache({ storage: null })
  cache.set(info, {
    ...defaultWebGpuKzgMsmAdapterCalibration(info),
    bucketWidth: 12,
    reductionMode: 'parallel16',
    source: 'benchmark-matrix',
    reason: 'cached winner',
    score: 4.58,
    measuredFixture: { blobs: 96, bytes: 96 * KZG_BLOB_SIZE, runs: 1, candidates: 2, metric: 'median-total-ms', wasmMs: 28.3 },
    measuredAtMs: 123,
  })
  const calls: Array<WebGpuKzgMsmOptions | undefined> = []
  const backend = await createBrowserKzgCommitBackend(dynamicMockWasm(), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    webGpuMode: 'force',
    webGpuCalibrationCache: cache,
    navigatorLike: fakeNavigator(info),
    webGpuCommitterFactory: async (options) => {
      calls.push(options)
      return fakeCommitter({ totalMs: 5, bucketWidth: options?.bucketWidth, reductionMode: options?.reductionMode }).committer as never
    },
  })

  assert.deepEqual(await backend.commitBlobs(blobBatch(1)), commitments(1))
  assert.equal(backend.getStatus().webgpu?.calibration?.status, 'cached')
  assert.equal(backend.getStatus().webgpu?.bucketWidth, 12)
  assert.equal(calls[0]?.bucketWidth, 12)
  assert.equal(calls[0]?.reductionMode, 'parallel16')
})

test('browser backend opens circuit when calibration parity fails', async () => {
  const backend = await createBrowserKzgCommitBackend(dynamicMockWasm(), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    webGpuMode: 'force',
    webGpuCalibrationMode: 'force',
    webGpuCalibrationBlobCount: 1,
    webGpuCalibrationCache: new WebGpuKzgMsmCalibrationCache({ storage: null }),
    navigatorLike: fakeNavigator({ vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }),
    webGpuCommitterFactory: async (options) =>
      fakeCommitter({
        totalMs: 5,
        commitmentsSeed: 99,
        bucketWidth: options?.bucketWidth,
        reductionMode: options?.reductionMode,
      }).committer as never,
  })

  assert.deepEqual(await backend.commitBlobs(blobBatch(1)), commitments(1))
  const status = backend.getStatus()
  assert.equal(status.selectedBackend, 'wasm-blst')
  assert.equal(status.webgpu?.scheduler?.circuitOpen, true)
  assert.equal(status.webgpu?.calibration?.status, 'failed')
  assert.match(status.fallbackReason || '', /calibration failed/)
})

test('browser backend falls back when auto probe is slower than WASM', async () => {
  const fake = fakeCommitter({ totalMs: 500 })
  const backend = await createBrowserKzgCommitBackend(dynamicMockWasm(), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    navigatorLike: fakeNavigator({ vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }),
    webGpuCommitterFactory: async () => fake.committer as never,
    now: (() => {
      let current = 0
      return () => {
        current += 1
        return current
      }
    })(),
  })

  assert.deepEqual(await backend.commitBlobs(blobBatch(1)), commitments(1))
  const status = backend.getStatus()
  assert.equal(status.selectedBackend, 'wasm-blst')
  assert.equal(status.webgpu?.scheduler?.probeStatus, 'failed')
  assert.match(status.fallbackReason || '', /slower than WASM/)
})

test('browser backend opens session circuit breaker on WebGPU timeout', async () => {
  const fake = fakeCommitter({ delayMs: 25 })
  const backend = await createBrowserKzgCommitBackend(dynamicMockWasm(), await loadTrustedSetupBytes(), {
    preferWebGpu: true,
    webGpuProbeTimeoutMs: 5,
    navigatorLike: fakeNavigator({ vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }),
    webGpuCommitterFactory: async () => fake.committer as never,
  })

  assert.deepEqual(await backend.commitBlobs(blobBatch(1)), commitments(1))
  const status = backend.getStatus()
  assert.equal(status.selectedBackend, 'wasm-blst')
  assert.equal(status.webgpu?.scheduler?.circuitOpen, true)
  assert.equal(status.webgpu?.scheduler?.probeStatus, 'timeout')
  assert.match(status.fallbackReason || '', /probe exceeded/)
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
