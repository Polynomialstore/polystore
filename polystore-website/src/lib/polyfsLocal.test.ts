import test from 'node:test'
import assert from 'node:assert/strict'
import { polyfsMetadataFixture } from './polyfsMetadata.fixture'
import { decodePolyfsFileRecord, parsePolyfsFilesFromMdu0, parsePolyfsRootTableFromMdu0, readPolyfsFatRange } from './polyfsLocal'
import { validatePolyfsRecordPath } from './polyfsPath'
import { POLYFS_FILE_RECORD_CAPACITY, asNonNegativeInteger, computePolyfsResolvedRange } from '../domain/polyfsLayout'

const fatStart = 16 * 128 * 1024
const physical = (logical: number) => fatStart + Math.floor(logical / 31) * 32 + 1 + logical % 31

test('canonical FAT v2 reads cross-scalar records and preserves root cell indices', () => {
  const mdu = polyfsMetadataFixture([{ path: 'dir/é.txt', size: 31n, flags: 0x81, timestamp: 17n }, { path: 'a//./b', start: 8126464n, size: 1n, timestamp: 18n }])
  mdu[63] = 2
  assert.deepEqual(parsePolyfsFilesFromMdu0(mdu), [
    { path: 'dir/é.txt', start_offset: 0, size_bytes: 31, flags: 0x81 },
    { path: 'a//./b', start_offset: 8126464, size_bytes: 1, flags: 0 },
  ])
  assert.deepEqual(parsePolyfsRootTableFromMdu0(mdu, 2).map((r) => r[31]), [0, 2])
  assert.deepEqual(parsePolyfsFilesFromMdu0(polyfsMetadataFixture()), [])
  assert.equal(POLYFS_FILE_RECORD_CAPACITY, 23807)
})

test('malformed metadata cannot become an empty or partial file map', () => {
  const valid = polyfsMetadataFixture([{ path: 'first', size: 1n }, { path: 'second', size: 1n }])
  for (const [label, mutate] of [
    ['version', (b: Uint8Array) => { b[physical(4)] = 1 }],
    ['reserved', (b: Uint8Array) => { b[physical(5)] = 1 }],
    ['header padding', (b: Uint8Array) => { b[physical(127)] = 1 }],
    ['prefix', (b: Uint8Array) => { b[fatStart + 128] = 1 }],
    ['tail', (b: Uint8Array) => { b[b.length - 1] = 1 }],
    ['count', (b: Uint8Array) => { b[physical(8)] = 0xff; b[physical(9)] = 0xff }],
    ['utf8', (b: Uint8Array) => { b[physical(128 + 256 + 24)] = 0xff }],
    ['path suffix', (b: Uint8Array) => { b[physical(128 + 256 + 24 + 8)] = 1 }],
    ['Fr boundary', (b: Uint8Array) => { b.set(Buffer.from('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001', 'hex')) }],
  ] as const) {
    const malformed = valid.slice(); mutate(malformed)
    assert.throws(() => parsePolyfsFilesFromMdu0(malformed), Error, label)
  }
  assert.throws(() => parsePolyfsFilesFromMdu0(valid.subarray(1)))
  const legacy = new Uint8Array(valid.length)
  legacy.set([78, 73, 76, 70, 1, 0, 0, 1], fatStart)
  assert.throws(() => parsePolyfsFilesFromMdu0(legacy))
})

test('wire integers remain exact and unsupported UI ranges fail before rounding', () => {
  const big = 9007199254740993n
  const mdu = polyfsMetadataFixture([{ path: 'large', start: big, size: 1n }])
  assert.equal(decodePolyfsFileRecord(readPolyfsFatRange(mdu, 128, 256)).start_offset, big)
  assert.throws(() => parsePolyfsFilesFromMdu0(mdu))
  assert.throws(() => asNonNegativeInteger(1.5, 'offset'))
  assert.throws(() => asNonNegativeInteger('1' as unknown as number, 'offset'))
  assert.throws(() => computePolyfsResolvedRange({ witnessMdus: 1, startOffsetBytes: Number.MAX_SAFE_INTEGER, sizeBytes: 2 }))
  const overflow = polyfsMetadataFixture([{ path: 'overflow', start: 0xffffffffffffffffn, size: 1n }])
  assert.throws(() => parsePolyfsFilesFromMdu0(overflow))
})

test('active paths are unique while tombstones and byte-distinct names remain valid', () => {
  assert.throws(() => parsePolyfsFilesFromMdu0(polyfsMetadataFixture([
    { path: 'dir/é.txt', start: 0n, size: 31n }, { path: 'dir/é.txt', start: 31n, size: 1n },
  ])), /duplicate active file path/)
  const paths = ['', '', 'é', 'e\u0301', 'a/b', 'a//b', 'a/./b', 'A/b']
  assert.deepEqual(parsePolyfsFilesFromMdu0(polyfsMetadataFixture(paths.map((path) => ({ path })))).map((file) => file.path), paths.slice(2))
})

test('paths preserve exact UTF-8 bytes and reject lossy names', () => {
  for (const path of ['é'.repeat(116), 'a'.repeat(232), 'a//./b', '\ufefffile']) {
    assert.equal(validatePolyfsRecordPath(path), path)
    assert.equal(parsePolyfsFilesFromMdu0(polyfsMetadataFixture([{ path }]))[0].path, path)
  }
  for (const path of ['a'.repeat(233), 'é'.repeat(117), ' x', 'x\u0085', '../x', 'a/../b', '/x', 'a\\b', 'x\0y', '\ud800']) assert.throws(() => validatePolyfsRecordPath(path))
})
