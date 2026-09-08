import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import init, { PolyStoreWasm } from './polystoreCoreRuntime.js'

const root = new URL('../../../', import.meta.url)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const encoded = () => Uint8Array.from({ length: 8388608 }, (_, i) => i % 32 === 0 ? 0 : (i * 17 + Math.floor(i / 131072)) % 251)

test('real WASM reconstructs missing data from bounded authenticated K-slot inputs', async () => {
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  assert.equal(typeof PolyStoreWasm.reconstruct_mdu_from_shards, 'function')
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', root)))
  const bytes = encoded(), expected = digest(bytes)
  try {
    for (const [k, m] of [[8, 4], [2, 1]]) {
      const expanded = wasm.expand_mdu_rs_flat_uncommitted(bytes, k, m) as { shards_flat: number[]; shard_len: number }
      const flat = Uint8Array.from(expanded.shards_flat)
      const shards: (Uint8Array | null)[] = Array(k + m).fill(null)
      // Recover data slot 0 from the first parity; keep exactly K inputs.
      for (let slot = 1; slot <= k; slot++) shards[slot] = flat.slice(slot * expanded.shard_len, (slot + 1) * expanded.shard_len)
      assert.equal(digest(PolyStoreWasm.reconstruct_mdu_from_shards(shards, k, m)), expected)
      assert.equal(shards[0], null)
      shards[k] = null
      assert.throws(() => PolyStoreWasm.reconstruct_mdu_from_shards(shards, k, m), /Exactly K/)
    }
    // RS(1,256) is repetition coding. One last-slot shard must recover without
    // allocating the other 254 unused parity shards (formerly ~2GiB).
    const maximum: (Uint8Array | null)[] = Array(256).fill(null); maximum[255] = bytes
    assert.equal(digest(PolyStoreWasm.reconstruct_mdu_from_shards(maximum, 1, 255)), expected)
  } finally { wasm.free() }
})

test('WASM reconstruction rejects lossy geometry, wrong types and over-budget input before copying', async () => {
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  for (const k of [-1, 0, 0.5, 3, 65, 2 ** 32, NaN, Infinity]) assert.throws(() => PolyStoreWasm.reconstruct_mdu_from_shards([], k, 1))
  for (const m of [-1, 0, 0.5, 256, 2 ** 32, NaN, Infinity]) assert.throws(() => PolyStoreWasm.reconstruct_mdu_from_shards([], 1, m))
  for (const shard of [undefined, {}, new ArrayBuffer(8388608), new Uint8Array(1)]) assert.throws(() => PolyStoreWasm.reconstruct_mdu_from_shards([shard, null], 1, 1))
  for (const value of [null, {}, { length: 2, 0: new Uint8Array(8388608), 1: null }, new Uint8Array(2)]) assert.throws(() => PolyStoreWasm.reconstruct_mdu_from_shards(value as unknown as unknown[], 1, 1))
  const bytes = new Uint8Array(8388608)
  assert.throws(() => PolyStoreWasm.reconstruct_mdu_from_shards([bytes, bytes], 1, 1), /Exactly K/)
})

test('real WASM authenticates enclosing witness, exact commitment list and reconstructed data separately', async () => {
  const { verifyWitnessMdu, readUserCommitments, verifyRecoveredMdu } = await import('./retrievalRecovery')
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', root)))
  const cell = (digest: Uint8Array) => Uint8Array.from(Buffer.from((BigInt(`0x${Buffer.from(digest).toString('hex')}`) % BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')).toString(16).padStart(64, '0'), 'hex'))
  try {
    const bytes = encoded(), expanded = wasm.expand_mdu_rs_flat_uncommitted(bytes, 2, 1) as { shards_flat: number[]; shard_len: number }
    const flat = Uint8Array.from(expanded.shards_flat), commitments = new Uint8Array(96 * 48)
    for (let leaf = 0; leaf < 96; leaf++) commitments.set(wasm.commit_received_blob(flat.subarray(leaf * 131072, (leaf + 1) * 131072)), leaf * 48)
    const userCell = cell(new Uint8Array(wasm.compute_mdu_root(commitments) as ArrayLike<number>))
    const witness = new Uint8Array(8388608)
    for (let i = 0; i < commitments.length; i += 31) { const chunk = commitments.subarray(i, i + 31); witness.set(chunk, Math.floor(i / 31) * 32 + 32 - chunk.length) }
    const witnessCommitments = new Uint8Array(64 * 48)
    for (let leaf = 0; leaf < 64; leaf++) witnessCommitments.set(wasm.commit_received_blob(witness.subarray(leaf * 131072, (leaf + 1) * 131072)), leaf * 48)
    const witnessCell = cell(new Uint8Array(wasm.compute_mdu_root(witnessCommitments) as ArrayLike<number>))
    const pin = { layout: 2, k: 2, m: 1, rows: 32, leafCount: 96, userMdus: 1n, metadataMdus: 2n } as import('./retrieval').PinnedGeneration
    verifyWitnessMdu(witness, witnessCell, wasm)
    const list = readUserCommitments(pin, 0n, [{ index: 1n, bytes: witness }], userCell, wasm)
    const recovered = PolyStoreWasm.reconstruct_mdu_from_shards([null, flat.slice(4194304, 8388608), flat.slice(8388608)], 2, 1)
    verifyRecoveredMdu(pin, recovered, list, wasm)
    recovered[31] ^= 1
    assert.throws(() => verifyRecoveredMdu(pin, recovered, list, wasm), /data commitments/)
    const wrongRoot = userCell.slice(); wrongRoot[31] ^= 1
    assert.throws(() => readUserCommitments(pin, 0n, [{ index: 1n, bytes: witness }], wrongRoot, wasm), /root/)
    witness[31] ^= 1
    assert.throws(() => verifyWitnessMdu(witness, witnessCell, wasm), /root/)
  } finally { wasm.free() }
})
