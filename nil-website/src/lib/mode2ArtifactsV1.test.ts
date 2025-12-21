import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

import init, { NilWasm } from '../../public/wasm/nil_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function sha256Hex0x(bytes: Uint8Array): string {
  const h = createHash('sha256')
  h.update(bytes)
  return `0x${h.digest('hex')}`
}

function hexToBytes(hex0x: string): Uint8Array {
  const trimmed = String(hex0x || '').trim().replace(/^0x/i, '')
  return new Uint8Array(Buffer.from(trimmed, 'hex'))
}

function bytesToHex0x(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`
}

function encodePayloadToMdu(rawData: Uint8Array): Uint8Array {
  const MDU_SIZE = 8 * 1024 * 1024
  const SCALAR_BYTES = 32
  const SCALAR_PAYLOAD_BYTES = 31
  const SCALARS_PER_MDU = MDU_SIZE / SCALAR_BYTES
  const MDU_PAYLOAD_BYTES = SCALARS_PER_MDU * SCALAR_PAYLOAD_BYTES

  const payload = rawData.subarray(0, Math.min(rawData.length, MDU_PAYLOAD_BYTES))
  const mdu = new Uint8Array(MDU_SIZE)

  let scalarIdx = 0
  for (let i = 0; i < payload.length && scalarIdx < SCALARS_PER_MDU; i += SCALAR_PAYLOAD_BYTES) {
    const chunk = payload.subarray(i, Math.min(i + SCALAR_PAYLOAD_BYTES, payload.length))
    const pad = SCALAR_BYTES - chunk.length
    const offset = scalarIdx * SCALAR_BYTES + pad
    mdu.set(chunk, offset)
    scalarIdx++
  }
  return mdu
}

test('mode2-artifacts-v1 fixture: WASM matches golden hashes', async () => {
  const repoRoot = path.resolve(__dirname, '../../..')
  const fixturePath = path.join(repoRoot, 'testdata/mode2-artifacts-v1/fixture_k8m4_single.json')
  const fixtureRaw = await fs.readFile(fixturePath, 'utf8')
  const fx = JSON.parse(fixtureRaw) as {
    spec: string
    k: number
    m: number
    leaf_count: number
    payload_hex: string
    payload_sha256: string
    witness_count: number
    roots: Record<string, string>
    artifact_sha256: Record<string, string>
    extra: Record<string, unknown>
  }

  assert.strictEqual(fx.spec, 'mode2-artifacts-v1')
  assert.strictEqual(fx.k, 8)
  assert.strictEqual(fx.m, 4)
  assert.strictEqual(fx.leaf_count, 96)
  assert.strictEqual(fx.witness_count, 1)

  const wasmPath = path.resolve(__dirname, '../../public/wasm/nil_core_bg.wasm')
  const wasmBuffer = await fs.readFile(wasmPath)
  await init({ module_or_path: wasmBuffer })

  const trustedSetupPath = path.resolve(__dirname, '../../public/trusted_setup.txt')
  const trustedSetupBytes = new Uint8Array(await fs.readFile(trustedSetupPath))
  const nilWasm = new NilWasm(trustedSetupBytes)

  const payload = hexToBytes(fx.payload_hex)
  assert.strictEqual(sha256Hex0x(payload), fx.payload_sha256)

  const encodedUser = encodePayloadToMdu(payload)
  const expandedRaw = nilWasm.expand_mdu_rs(encodedUser, fx.k, fx.m) as unknown
  const expanded = typeof expandedRaw === 'string' ? JSON.parse(expandedRaw) : expandedRaw
  const witnessRaw = (expanded as { witness?: unknown[] }).witness ?? []
  const shardsRaw = (expanded as { shards?: unknown[] }).shards ?? []

  const witnessList = witnessRaw.map((w) => (w instanceof Uint8Array ? w : new Uint8Array(w as ArrayBufferLike)))
  const shardsList = shardsRaw.map((s) => (s instanceof Uint8Array ? s : new Uint8Array(s as ArrayBufferLike)))

  assert.strictEqual(witnessList.length, fx.leaf_count)
  assert.strictEqual(shardsList.length, fx.k + fx.m)

  const witnessFlat = new Uint8Array(witnessList.length * 48)
  let off = 0
  for (const w of witnessList) {
    witnessFlat.set(w, off)
    off += w.length
  }
  assert.strictEqual(sha256Hex0x(witnessFlat), fx.extra['witness_flat_sha256'])

  const userRootRaw = nilWasm.compute_mdu_root(witnessFlat) as unknown
  const userRoot = userRootRaw instanceof Uint8Array ? userRootRaw : new Uint8Array(userRootRaw as ArrayBufferLike)
  assert.strictEqual(bytesToHex0x(userRoot), fx.roots['user_mdu_root'])

  // Fixture shard artifacts: single user MDU => slab_index = 1 + W, W=1 => 2.
  const slabIndex = 2
  for (let slot = 0; slot < shardsList.length; slot++) {
    const name = `mdu_${slabIndex}_slot_${slot}.bin`
    assert.strictEqual(sha256Hex0x(shardsList[slot]), fx.artifact_sha256[name])
  }
})
