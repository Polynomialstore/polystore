import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { NilWasm } from '../public/wasm/polystore_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')

const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

const rsK = Number(process.env.RS_K || 2)
const rsM = Number(process.env.RS_M || 1)
const fileBytes = Number(process.env.FILE_BYTES || RAW_MDU_CAPACITY)
const warmupRuns = Number(process.env.WARMUP_RUNS || 1)
const measureRuns = Number(process.env.MEASURE_RUNS || 3)
const windows = (process.env.WINDOWS || '8,9,10,11,12,13')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const basisModes = (process.env.BASIS_MODES || 'projective')
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is 'projective' | 'affine' => value === 'projective' || value === 'affine')

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

function makeDeterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 17 + 31) & 0xff
  }
  return bytes
}

const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'polystore_core_bg.wasm')
const wasmBuffer = await fs.readFile(wasmPath)
await init({ module_or_path: wasmBuffer })

const trustedSetupPath = path.resolve(websiteRoot, 'public', 'trusted_setup.txt')
const trustedSetup = new Uint8Array(await fs.readFile(trustedSetupPath))
const wasm = new NilWasm(trustedSetup)

const payload = makeDeterministicPayload(fileBytes)
const expandedRaw = wasm.expand_payload_rs_flat_uncommitted(payload, rsK, rsM) as unknown
const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
const shardsFlatRaw = (expanded as { shards_flat?: unknown }).shards_flat
const shardsFlat = shardsFlatRaw instanceof Uint8Array ? shardsFlatRaw : new Uint8Array(shardsFlatRaw as ArrayBufferLike)

const results = []
for (const basisMode of basisModes) {
  wasm.set_wasm_msm_basis_mode(basisMode)
  for (const bits of windows) {
    wasm.set_pippenger_window_bits(bits)
    for (let i = 0; i < warmupRuns; i += 1) {
      wasm.commit_blobs(shardsFlat)
    }
    const runs: number[] = []
    for (let i = 0; i < measureRuns; i += 1) {
      const t0 = performance.now()
      wasm.commit_blobs(shardsFlat)
      runs.push(performance.now() - t0)
    }
    results.push({
      basis_mode: basisMode,
      window_bits: bits,
      stats: stats(runs),
      runs,
    })
  }
}

wasm.set_pippenger_window_bits(0)
wasm.set_wasm_msm_basis_mode('projective')

console.log(JSON.stringify({
  file_bytes: payload.byteLength,
  rs_k: rsK,
  rs_m: rsM,
  warmup_runs: warmupRuns,
  measure_runs: measureRuns,
  basis_modes: basisModes,
  windows,
  results,
}, null, 2))
