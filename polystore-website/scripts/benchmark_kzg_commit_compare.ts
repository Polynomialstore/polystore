import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { NilWasm } from '../public/wasm/polystore_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')

const BLOB_SIZE = 131072
const chunksPerBlob = BLOB_SIZE / 32
const warmupRuns = Number(process.env.WARMUP_RUNS || 2)
const measureRuns = Number(process.env.MEASURE_RUNS || 7)
const batchBlobCount = Number(process.env.BATCH_BLOBS || 64)

function assertPositiveInt(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) {
    throw new Error(`invalid ${name}: ${value}`)
  }
}

assertPositiveInt('WARMUP_RUNS', warmupRuns)
assertPositiveInt('MEASURE_RUNS', measureRuns)
assertPositiveInt('BATCH_BLOBS', batchBlobCount)

function makeValidBlob(seed: number): Uint8Array {
  const blob = new Uint8Array(BLOB_SIZE)
  for (let i = 0; i < chunksPerBlob; i += 1) {
    const offset = i * 32
    // Keep the field element canonical for EIP-4844-style APIs by forcing the top byte to zero.
    blob[offset] = 0
    for (let j = 1; j < 32; j += 1) {
      blob[offset + j] = (seed + i * 17 + j * 29) & 0xff
    }
  }
  return blob
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
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

async function loadNilWasm() {
  const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'polystore_core_bg.wasm')
  const wasmBuffer = await fs.readFile(wasmPath)
  const initStart = performance.now()
  await init({ module_or_path: wasmBuffer })
  const trustedSetupPath = path.resolve(websiteRoot, 'public', 'trusted_setup.txt')
  const trustedSetup = new Uint8Array(await fs.readFile(trustedSetupPath))
  const instance = new NilWasm(trustedSetup)
  return {
    instance,
    initMs: performance.now() - initStart,
  }
}

async function loadKzgWasm() {
  const moduleUrl = pathToFileURL('/tmp/kzg-wasm-bench/dist/esm/index.js').href
  const mod = (await import(moduleUrl)) as { loadKZG: (precompute?: number) => Promise<{ blobToKZGCommitment: (blob: string) => string }> }
  const initStart = performance.now()
  const instance = await mod.loadKZG()
  return {
    instance,
    initMs: performance.now() - initStart,
  }
}

async function loadMicroEthSigner() {
  const trustedSetupUrl = pathToFileURL('/tmp/micro-eth-signer-bench/node_modules/@paulmillr/trusted-setups/fast-kzg.js').href
  const kzgUrl = pathToFileURL('/tmp/micro-eth-signer-bench/src/advanced/kzg.ts').href
  const trustedSetupModule = (await import(trustedSetupUrl)) as { trustedSetup: unknown }
  const kzgModule = (await import(kzgUrl)) as { KZG: new (setup: unknown) => { blobToKzgCommitment: (blob: string) => string } }
  const initStart = performance.now()
  const instance = new kzgModule.KZG(trustedSetupModule.trustedSetup)
  return {
    instance,
    initMs: performance.now() - initStart,
  }
}

type LibKzgExports = {
  commit: (coefficients: bigint[]) => unknown
}

async function loadLibKzg(): Promise<{ instance: LibKzgExports; note: string } | null> {
  try {
    const require = createRequire(import.meta.url)
    const libKzgNs = require('/tmp/libkzg-bench/ts/index.ts') as {
      default?: LibKzgExports
      'module.exports'?: LibKzgExports
      commit?: LibKzgExports['commit']
    }
    const instance = libKzgNs.commit ? (libKzgNs as LibKzgExports) : libKzgNs.default ?? libKzgNs['module.exports']
    if (!instance?.commit) {
      throw new Error('libkzg commit() export not found')
    }
    return {
      instance,
      note: 'Not apples-to-apples with EIP-4844 blob commitment: BN254 coefficient-form KZG over 4096 coefficients.',
    }
  } catch (error) {
    return null
  }
}

function benchSingle(label: string, fn: () => void) {
  for (let i = 0; i < warmupRuns; i += 1) fn()
  const runs: number[] = []
  for (let i = 0; i < measureRuns; i += 1) {
    const t0 = performance.now()
    fn()
    runs.push(performance.now() - t0)
  }
  return {
    label,
    ...stats(runs),
    runs,
  }
}

function benchBatch(label: string, fn: () => void) {
  for (let i = 0; i < warmupRuns; i += 1) fn()
  const runs: number[] = []
  for (let i = 0; i < measureRuns; i += 1) {
    const t0 = performance.now()
    fn()
    runs.push(performance.now() - t0)
  }
  const summary = stats(runs)
  return {
    label,
    total_ms: summary,
    per_commit_ms: stats(runs.map((ms) => ms / batchBlobCount)),
    runs,
  }
}

const blob = makeValidBlob(11)
const blobHex = bytesToHex(blob)
const blobsFlat = new Uint8Array(BLOB_SIZE * batchBlobCount)
for (let i = 0; i < batchBlobCount; i += 1) {
  blobsFlat.set(makeValidBlob(11 + i), i * BLOB_SIZE)
}
const blobHexes = Array.from({ length: batchBlobCount }, (_, i) => bytesToHex(blobsFlat.subarray(i * BLOB_SIZE, (i + 1) * BLOB_SIZE)))

const nil = await loadNilWasm()
const kzgWasm = await loadKzgWasm()
const microEthSigner = await loadMicroEthSigner()
const libKzg = await loadLibKzg()
const libKzgCoefficients = Array.from({ length: chunksPerBlob }, (_, i) => BigInt(i + 1))

const result = {
  config: {
    blob_size: BLOB_SIZE,
    warmup_runs: warmupRuns,
    measure_runs: measureRuns,
    batch_blobs: batchBlobCount,
  },
  init: {
    nil_wasm_ms: nil.initMs,
    kzg_wasm_ms: kzgWasm.initMs,
    micro_eth_signer_fast_setup_ms: microEthSigner.initMs,
  },
  notes: {
    nil_wasm: 'NilStore BLS12-381 wasm path over a canonical 128 KiB blob.',
    kzg_wasm: 'c-kzg-4844 compiled to wasm; same canonical 128 KiB blob workload.',
    micro_eth_signer: 'Pure JS KZG from micro-eth-signer using fast-kzg setup, matching the upstream benchmark style.',
    libkzg:
      libKzg?.note ??
      'Unavailable locally. The upstream repo targets BN254 coefficient-form commitments and is not directly comparable to EIP-4844 blob commitment APIs.',
  },
  single_blob_commitment: {
    nil_wasm: benchSingle('nil_wasm', () => {
      nil.instance.commit_blobs(blob)
    }),
    kzg_wasm: benchSingle('kzg_wasm', () => {
      kzgWasm.instance.blobToKZGCommitment(blobHex)
    }),
    micro_eth_signer: benchSingle('micro_eth_signer', () => {
      microEthSigner.instance.blobToKzgCommitment(blobHex)
    }),
  },
  batch_commitment: {
    nil_wasm: benchBatch('nil_wasm', () => {
      nil.instance.commit_blobs(blobsFlat)
    }),
    kzg_wasm: benchBatch('kzg_wasm', () => {
      for (const hex of blobHexes) {
        kzgWasm.instance.blobToKZGCommitment(hex)
      }
    }),
    micro_eth_signer: benchBatch('micro_eth_signer', () => {
      for (const hex of blobHexes) {
        microEthSigner.instance.blobToKzgCommitment(hex)
      }
    }),
  },
  side_benchmarks: libKzg
    ? {
        libkzg_coefficient_commitment_4096: benchSingle('libkzg', () => {
          libKzg.instance.commit(libKzgCoefficients)
        }),
      }
    : {
        libkzg_coefficient_commitment_4096: null,
      },
}

console.log(JSON.stringify(result, null, 2))
