import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { NilWasm } from '../public/wasm/nil_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')

const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

type ExpandPerf = {
  encode_ms?: number
  rs_ms?: number
  commit_ms?: number
  total_ms?: number
  rows?: number
  shards_total?: number
  shard_len?: number
}

function makeDeterministicPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 17 + 31) & 0xff
  }
  return bytes
}

function toRecord(raw: unknown): ExpandPerf {
  if (!raw || typeof raw !== 'object') return {}
  return raw as ExpandPerf
}

const fileBytes = Number(process.env.FILE_BYTES || RAW_MDU_CAPACITY)
const rsK = Number(process.env.RS_K || 2)
const rsM = Number(process.env.RS_M || 1)

if (!Number.isFinite(fileBytes) || fileBytes <= 0) {
  throw new Error(`invalid FILE_BYTES: ${process.env.FILE_BYTES ?? ''}`)
}

const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'nil_core_bg.wasm')
const wasmBuffer = await fs.readFile(wasmPath)
await init({ module_or_path: wasmBuffer })

const trustedSetupPath = path.resolve(websiteRoot, 'public', 'trusted_setup.txt')
const trustedSetup = new Uint8Array(await fs.readFile(trustedSetupPath))
const wasm = new NilWasm(trustedSetup)

const payload = makeDeterministicPayload(fileBytes)
const totalMdus = Math.ceil(payload.byteLength / RAW_MDU_CAPACITY)
const records: Array<ExpandPerf & { index: number; payload_bytes: number; wall_ms: number }> = []
const benchStart = performance.now()

for (let index = 0; index < totalMdus; index += 1) {
  const start = index * RAW_MDU_CAPACITY
  const end = Math.min(start + RAW_MDU_CAPACITY, payload.byteLength)
  const chunk = payload.subarray(start, end)
  const t0 = performance.now()
  const expandedRaw = wasm.expand_payload_rs_flat(chunk, rsK, rsM) as unknown
  const wallMs = performance.now() - t0
  const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
  records.push({
    index,
    payload_bytes: chunk.byteLength,
    wall_ms: wallMs,
    ...toRecord((expanded as { perf?: unknown }).perf),
  })
}

const benchWallMs = performance.now() - benchStart
const sumBy = (pick: (record: (typeof records)[number]) => number) =>
  records.reduce((sum, record) => sum + pick(record), 0)

const summary = {
  file_bytes: payload.byteLength,
  raw_mdu_capacity: RAW_MDU_CAPACITY,
  total_mdus: totalMdus,
  rs_k: rsK,
  rs_m: rsM,
  wall_ms: benchWallMs,
  per_mdu_avg_ms: totalMdus > 0 ? benchWallMs / totalMdus : 0,
  phases: {
    rust_encode_ms: sumBy((record) => Number(record.encode_ms ?? 0)),
    rust_rs_ms: sumBy((record) => Number(record.rs_ms ?? 0)),
    rust_commit_ms: sumBy((record) => Number(record.commit_ms ?? 0)),
    rust_total_ms: sumBy((record) => Number(record.total_ms ?? 0)),
    outer_wall_ms: sumBy((record) => Number(record.wall_ms ?? 0)),
  },
  records,
}

console.log(JSON.stringify(summary, null, 2))
