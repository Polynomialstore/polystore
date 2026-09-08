import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveMode2AppendBase } from './resolveAppendBase'

test('resolveMode2AppendBase prefers fresh local slab state', async () => {
  const logs: string[] = []
  let bootstrapCalls = 0

  const result = await resolveMode2AppendBase({
    localManifestRoot: '0xaaaa',
    chainManifestRoot: '0xaaaa',
    addLog: (message) => logs.push(message),
    formatBytes: (bytes) => `${bytes} bytes`,
    loadLocal: async () => ({
      baseMdu0Bytes: new Uint8Array([1]),
      existingUserMdus: [{ index: 0, data: new Uint8Array([2]) }],
      existingUserCount: 1,
      existingMaxEnd: 123,
      appendStartOffset: 1024,
    }),
    bootstrapFromNetwork: async () => {
      bootstrapCalls += 1
      return null
    },
  })

  assert.equal(result.source, 'local')
  assert.equal(result.appendStartOffset, 1024)
  assert.equal(bootstrapCalls, 0)
  assert.deepEqual(logs, ['> Mode 2 append: found 1 existing user MDUs; starting new file at 1024 bytes.'])
})

test('resolveMode2AppendBase preserves stale local slab and bootstraps from network', async () => {
  const logs: string[] = []
  let loadCalls = 0
  let bootstrapCalls = 0

  const result = await resolveMode2AppendBase({
    localManifestRoot: '0xaaaa',
    chainManifestRoot: '0xbbbb',
    addLog: (message) => logs.push(message),
    loadLocal: async () => {
      loadCalls += 1
      return null
    },
    bootstrapFromNetwork: async () => {
      bootstrapCalls += 1
      return {
        baseMdu0Bytes: new Uint8Array([9]),
        existingUserMdus: [{ index: 0, data: new Uint8Array([8]) }],
        existingUserCount: 1,
        existingMaxEnd: 456,
        appendStartOffset: 8192,
      }
    },
  })

  assert.equal(result.source, 'bootstrap')
  assert.equal(result.appendStartOffset, 8192)
  assert.equal(loadCalls, 0)
  assert.equal(bootstrapCalls, 1)
  assert.deepEqual(logs, [
    '> Mode 2 append: local slab manifest 0xaaaa is stale; bootstrapping from current committed root 0xbbbb.',
    '> Mode 2 append: bootstrapped 1 committed user MDUs from provider retrieval.',
  ])
})

test('resolveMode2AppendBase falls back to bootstrap after local load failure', async () => {
  const logs: string[] = []

  const result = await resolveMode2AppendBase({
    localManifestRoot: '',
    chainManifestRoot: '0xbbbb',
    addLog: (message) => logs.push(message),
    loadLocal: async () => {
      throw new Error('missing local MDU: mdu_2.bin')
    },
    bootstrapFromNetwork: async () => ({
      baseMdu0Bytes: new Uint8Array([7]),
      existingUserMdus: [{ index: 0, data: new Uint8Array([6]) }],
      existingUserCount: 1,
      existingMaxEnd: 789,
      appendStartOffset: 4096,
    }),
  })

  assert.equal(result.source, 'bootstrap')
  assert.deepEqual(logs, [
    '> Mode 2 append: failed to load existing slab (missing local MDU: mdu_2.bin).',
    '> Mode 2 append: bootstrapped 1 committed user MDUs from provider retrieval.',
  ])
})

test('resolveMode2AppendBase returns empty when no chain manifest exists', async () => {
  let bootstrapCalls = 0

  const result = await resolveMode2AppendBase({
    localManifestRoot: '',
    chainManifestRoot: '',
    loadLocal: async () => null,
    bootstrapFromNetwork: async () => {
      bootstrapCalls += 1
      return null
    },
  })

  assert.equal(result.source, 'empty')
  assert.equal(result.baseMdu0Bytes, null)
  assert.equal(result.existingUserCount, 0)
  assert.equal(bootstrapCalls, 0)
})

test('resolveMode2AppendBase rejects when committed chain root exists but bootstrap yields no append base', async () => {
  await assert.rejects(
    () =>
      resolveMode2AppendBase({
        localManifestRoot: '',
        chainManifestRoot: '0xcccc',
        loadLocal: async () => null,
        bootstrapFromNetwork: async () => null,
      }),
    /remote bootstrap did not produce an append base/,
  )
})
