import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import init, { PolyStoreWasm } from './polystoreCoreRuntime.js'

const root = new URL('../../../', import.meta.url)
const hex = (value: string) => Buffer.from(value, 'hex')

test('real WASM shares canonical challenges, batch verification and received-byte guards', async () => {
  // This check requires the maintained WASM bundle; a missing or stale build fails.
  const binary = await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root))
  await init({ module_or_path: binary })
  const setup = await readFile(new URL('polystorechain/trusted_setup.txt', root))
  PolyStoreWasm.validate_trusted_setup(setup)
  const wasm = new PolyStoreWasm(setup)
  const wrong = Buffer.from(setup)
  wrong[wrong.length - 2] ^= 1
  for (const invalid of [new Uint8Array(), setup.subarray(0, setup.length - 1), wrong]) {
    assert.throws(() => PolyStoreWasm.validate_trusted_setup(invalid))
    assert.throws(() => new PolyStoreWasm(invalid))
  }
  // Identity must still be checked after a valid context already exists.
  PolyStoreWasm.validate_trusted_setup(setup)
  assert.throws(() => PolyStoreWasm.validate_trusted_setup(wrong))

  const golden = JSON.parse(await readFile(new URL('polystorechain/pkg/retrievalchallenge/testdata/challenge-golden.json', root), 'utf8')) as {
    schema: { seed_hex: string }
    vectors: Record<string, { context_hex: string; context_hash: string; samples: { ordinal: number; population_index: number; mdu_index: number; leaf_index: number; z: string }[] }>
  }
  for (const vector of Object.values(golden.vectors)) {
    const context = hex(vector.context_hex)
    assert.equal(Buffer.from(PolyStoreWasm.challenge_context_hash(context)).toString('hex'), vector.context_hash)
    const actual = Buffer.from(PolyStoreWasm.derive_challenges(context, hex(golden.schema.seed_hex)))
    assert.equal(actual.length, vector.samples.length * 60)
    vector.samples.forEach((sample, i) => {
      const record = actual.subarray(i * 60, (i + 1) * 60)
      assert.equal(record.readBigUInt64BE(0), BigInt(sample.ordinal))
      assert.equal(record.readBigUInt64BE(8), BigInt(sample.population_index))
      assert.equal(record.readBigUInt64BE(16), BigInt(sample.mdu_index))
      assert.equal(record.readUInt32BE(24), sample.leaf_index)
      assert.equal(record.subarray(28).toString('hex'), sample.z)
    })
    assert.throws(() => PolyStoreWasm.challenge_context_hash(Buffer.concat([context, Buffer.from([0])])))
    assert.throws(() => PolyStoreWasm.derive_challenges(context, new Uint8Array(31)))
  }

  const batch = await readFile(new URL('polystore_core/tests/testdata/session-batch-input.bin', root))
  assert.equal(wasm.verify_polyfs_session_batch(batch), true)
  const received = new Uint8Array(131072)
  received[31] = 1
  received[63] = 2
  const commitmentOffset = 106 + 8 + 4 + 32 + 48 + 48
  const authenticatedCommitment = batch.subarray(commitmentOffset, commitmentOffset + 48)
  assert.deepEqual(Buffer.from(wasm.commit_received_blob(received)), authenticatedCommitment)
  received[95] = 3
  // The public proof still verifies, but different canonical bytes must not ACK.
  assert.equal(wasm.verify_polyfs_session_batch(batch), true)
  assert.notDeepEqual(Buffer.from(wasm.commit_received_blob(received)), authenticatedCommitment)
  const invalid = Buffer.from(batch)
  invalid[106 + 8 + 4 + 32 + 48 + 48 + 48 + 32 + 31] ^= 1 // canonical y, invalid opening
  assert.equal(wasm.verify_polyfs_session_batch(invalid), false)
  assert.throws(() => wasm.verify_polyfs_session_batch(Buffer.concat([batch, Buffer.from([0])])))

  const blob = new Uint8Array(131072)
  for (let i = 31; i < blob.length; i += 32) blob[i] = 1 + (i / 32 | 0) % 251
  assert.deepEqual(wasm.commit_received_blob(blob), wasm.commit_blobs(blob))
  assert.throws(() => wasm.commit_received_blob(blob.subarray(1)))
  blob.set(hex('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001'), blob.length - 32)
  assert.throws(() => wasm.commit_received_blob(blob))
  const packed = new Uint8Array(64)
  packed[31] = 7
  PolyStoreWasm.validate_packed_payload(packed, 1)
  for (const length of [-1, 0.5, 2 ** 32, NaN, Infinity, 63]) {
    assert.throws(() => PolyStoreWasm.validate_packed_payload(packed, length))
  }
  packed[63] = 1
  assert.throws(() => PolyStoreWasm.validate_packed_payload(packed, 1))
  packed[63] = 0
  packed[0] = 1
  assert.throws(() => PolyStoreWasm.validate_packed_payload(packed, 1))
  wasm.free()
})
