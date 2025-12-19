import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import init, { NilWasm } from '../public/wasm/nil_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(websiteRoot, '..')

function toU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  throw new Error('Expected Uint8Array-compatible value')
}

function sha256Hex(bytes: Uint8Array): string {
  const hash = createHash('sha256')
  hash.update(bytes)
  return hash.digest('hex')
}

function sha256Chunks(chunks: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) {
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(chunk.length))
    hash.update(len)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function pickIndices(count: number): number[] {
  const out: number[] = []
  let seed = 0x00c0ffee
  while (out.length < count) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const idx = (seed % 255) + 1 // 1..255 (avoid trivial 0)
    if (!out.includes(idx)) out.push(idx)
  }
  return out
}

function deriveRoots(base: Uint8Array, indices: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const idx of indices) {
    const next = new Uint8Array(base)
    next[0] ^= idx & 0xff
    next[31] ^= (idx * 29) & 0xff
    out.push(next)
  }
  return out
}

const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'nil_core_bg.wasm')
const wasmBuffer = await fs.readFile(wasmPath)
await init(wasmBuffer)

const trustedSetupPath = path.resolve(repoRoot, 'nilchain', 'trusted_setup.txt')
const trustedSetup = await fs.readFile(trustedSetupPath)
const wasm = new NilWasm(trustedSetup)

const fixturesDir = path.resolve(repoRoot, 'nil_core', 'fixtures', 'parity')
const mduBytes = new Uint8Array(await fs.readFile(path.join(fixturesDir, 'mdu_8m.bin')))

const expanded = wasm.expand_file(mduBytes) as { witness: unknown; shards: unknown }
const witness = (Array.isArray(expanded.witness) ? expanded.witness : []).map(toU8)
const shards = (Array.isArray(expanded.shards) ? expanded.shards : []).map(toU8)

const witnessFlat = new Uint8Array(
  witness.reduce((acc, cur) => acc + cur.length, 0),
)
let offset = 0
for (const entry of witness) {
  witnessFlat.set(entry, offset)
  offset += entry.length
}

const mduRoot = toU8(wasm.compute_mdu_root(witnessFlat))
const rootIndices = pickIndices(4)
const roots = deriveRoots(mduRoot, rootIndices)
const rootsFlat = new Uint8Array(roots.length * 32)
roots.forEach((root, i) => rootsFlat.set(root, i * 32))

const manifest = wasm.compute_manifest(rootsFlat) as { root?: unknown; blob?: unknown }
const manifestRoot = toU8(manifest.root)
const manifestBlob = toU8(manifest.blob)

const output = {
  fixture: {
    mdu_bytes: mduBytes.length,
    root_count: roots.length,
    root_indices: rootIndices,
  },
  expand_mdu: {
    witness_sha256: sha256Chunks(witness),
    shards_sha256: sha256Chunks(shards),
    witness_count: witness.length,
    shard_count: shards.length,
    mdu_root: `0x${Buffer.from(mduRoot).toString('hex')}`,
  },
  manifest: {
    manifest_root: `0x${Buffer.from(manifestRoot).toString('hex')}`,
    manifest_blob_sha256: sha256Hex(manifestBlob),
  },
}

console.log(JSON.stringify(output))
