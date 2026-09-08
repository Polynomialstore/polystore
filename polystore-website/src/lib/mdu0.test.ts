import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import init, { WasmMdu0Builder } from './polystoreCoreRuntime.js'
import { polyfsMetadataFixture } from './polyfsMetadata.fixture'
import { decodePolyfsFileRecord, parsePolyfsFilesFromMdu0, readPolyfsFatRange } from './polyfsLocal'

const root = new URL('../../../', import.meta.url)
const ready = readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)).then((binary) => init({ module_or_path: binary }))

test('maintained real WASM agrees with independent FAT v2 bytes and bounded readers', async () => {
  await ready // Missing or stale maintained artifacts fail this test.
  const golden = JSON.parse(await readFile(new URL('polystore_core/testdata/polyfs_fat_v2.json', root), 'utf8'))
  const bytes = polyfsMetadataFixture(golden.records.map((r: { path: string; start: string; length: string; flags: number; timestamp: string }) => ({ path: r.path, start: BigInt(r.start), size: BigInt(r.length), flags: r.flags, timestamp: BigInt(r.timestamp) })))
  bytes.set(Buffer.from(golden.root_cell_hex, 'hex'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), golden.mdu0_sha256)
  const loaded = WasmMdu0Builder.load(bytes, 65536n, 96n)
  try {
    assert.equal(loaded.get_record_count(), 2)
    assert.equal(loaded.is_legacy_recovery(), false)
    assert.deepEqual(loaded.bytes(), bytes)
    assert.equal(Buffer.from(loaded.get_root(0n)).toString('hex'), golden.root_cell_hex)
    assert.deepEqual(loaded.get_record(1), readPolyfsFatRange(bytes, 384, 256))
    assert.deepEqual(loaded.read_fat_range(157, 33), readPolyfsFatRange(bytes, 157, 33))
    assert.equal(decodePolyfsFileRecord(loaded.get_record(0)).timestamp, 17n)
    assert.equal(parsePolyfsFilesFromMdu0(loaded.bytes())[0].path, 'dir/é.txt')
    for (const n of [-1, 0.5, NaN, Infinity, 2 ** 32]) {
      assert.throws(() => loaded.get_record(n))
      assert.throws(() => loaded.read_fat_range(n, 1))
      assert.throws(() => loaded.read_fat_range(0, n))
    }
  } finally { loaded.free() }
})

test('real WASM producer rejects numeric wrapping and lossy paths without mutation', async () => {
  await ready
  const builder = new WasmMdu0Builder(65536n)
  try {
    for (const path of ['replacement�.txt', 'Desktop/📸.png', 'é'.repeat(116), 'a'.repeat(232), '\ufefffile', 'a//./b']) builder.append_file(path, 1n, 0n)
    const before = builder.bytes()
    for (const path of ['', 'x'.repeat(233), ' x', 'x\u0085', '../x', 'x\0y', '\ud800']) assert.throws(() => builder.append_file(path, 1n, 0n))
    for (const flags of [-1, 256, 0.5, NaN, Infinity]) assert.throws(() => builder.append_file_with_flags('x', 1n, 0n, flags))
    for (const value of [-1n, 1n << 64n, (1n << 64n) + 1n, 0 as unknown as bigint, '0' as unknown as bigint]) {
      assert.throws(() => builder.append_file('x', value, 0n))
      assert.throws(() => builder.append_file('x', 0n, value))
      assert.throws(() => builder.set_root(value, new Uint8Array(32)))
      assert.throws(() => builder.get_root(value))
      assert.throws(() => new WasmMdu0Builder(value))
      assert.throws(() => WasmMdu0Builder.load(before, value, 64n))
    }
    assert.throws(() => builder.append_file('x', 1n << 56n, 0n))
    assert.throws(() => builder.append_file('x', 1n, (1n << 64n) - 1n))
    assert.deepEqual(builder.bytes(), before)
    builder.set_root(0n, new Uint8Array(32).fill(255))
    assert.notDeepEqual(builder.get_root(0n), new Uint8Array(32).fill(255))
  } finally { builder.free() }
})

test('real WASM legacy recovery is explicit, read-only and stages separate v2 bytes', async () => {
  await ready
  const legacy = new Uint8Array(8 * 1024 * 1024)
  legacy.set([78, 73, 76, 70, 1, 0, 0, 1], 16 * 128 * 1024)
  const before = legacy.slice()
  assert.throws(() => WasmMdu0Builder.load(legacy, 1n, 64n))
  const recovery = WasmMdu0Builder.load_legacy_recovery(legacy, 1n, 64n)
  const staged = WasmMdu0Builder.stage_v2_from_trusted_legacy(legacy, 1n, 64n)
  try {
    assert.equal(recovery.is_legacy_recovery(), true)
    assert.throws(() => recovery.append_file('x', 1n, 0n))
    assert.throws(() => recovery.set_root(0n, new Uint8Array(32)))
    assert.deepEqual(recovery.bytes(), before)
    assert.deepEqual(legacy, before)
    assert.equal(staged.is_legacy_recovery(), false)
    assert.deepEqual(staged.bytes(), polyfsMetadataFixture())
  } finally { recovery.free(); staged.free() }
})
