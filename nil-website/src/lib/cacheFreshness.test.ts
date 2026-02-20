import { test } from 'node:test'
import assert from 'node:assert'
import { evaluateCacheFreshness, normalizeManifestRoot } from './cacheFreshness'

test('normalizeManifestRoot normalizes casing and 0x prefix', () => {
  assert.strictEqual(normalizeManifestRoot('ABCDEF'), '0xabcdef')
  assert.strictEqual(normalizeManifestRoot('0xAbCd'), '0xabcd')
  assert.strictEqual(normalizeManifestRoot('  '), '')
  assert.strictEqual(normalizeManifestRoot(null), '')
})

test('evaluateCacheFreshness reports unknown when chain manifest is missing', () => {
  const result = evaluateCacheFreshness('0x11', '')
  assert.deepStrictEqual(result, {
    status: 'unknown',
    reason: 'chain_manifest_missing',
    localManifestRoot: '0x11',
    chainManifestRoot: '',
  })
})

test('evaluateCacheFreshness reports unknown when local manifest is missing', () => {
  const result = evaluateCacheFreshness('', '0x22')
  assert.deepStrictEqual(result, {
    status: 'unknown',
    reason: 'local_manifest_missing',
    localManifestRoot: '',
    chainManifestRoot: '0x22',
  })
})

test('evaluateCacheFreshness reports fresh when roots match', () => {
  const result = evaluateCacheFreshness('AABB', '0xaabb')
  assert.deepStrictEqual(result, {
    status: 'fresh',
    reason: 'fresh',
    localManifestRoot: '0xaabb',
    chainManifestRoot: '0xaabb',
  })
})

test('evaluateCacheFreshness reports stale on mismatch', () => {
  const result = evaluateCacheFreshness('0xaaaa', '0xbbbb')
  assert.deepStrictEqual(result, {
    status: 'stale',
    reason: 'stale_manifest_mismatch',
    localManifestRoot: '0xaaaa',
    chainManifestRoot: '0xbbbb',
  })
})
