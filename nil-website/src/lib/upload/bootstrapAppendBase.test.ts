import test from 'node:test'
import assert from 'node:assert/strict'

import { bootstrapAppendBaseFromNetwork } from './bootstrapAppendBase'
import type { NilfsFileEntry } from '../../domain/nilfs'

test('bootstrapAppendBaseFromNetwork reconstructs user MDUs and MDU0 state from provider files', async () => {
  const rawMduCapacity = 8
  const files: NilfsFileEntry[] = [
    { path: 'tail.bin', size_bytes: 4, start_offset: 6, flags: 7, cache_present: true },
    { path: 'alpha.txt', size_bytes: 5, start_offset: 0, flags: 3, cache_present: true },
  ]
  const bytesByPath = new Map<string, Uint8Array>([
    ['alpha.txt', new TextEncoder().encode('HELLO')],
    ['tail.bin', new TextEncoder().encode('WXYZ')],
  ])
  const appended: Array<{ path: string; sizeBytes: number; startOffset: number; flags: number }> = []
  let initArgs: { userCount: number; commitmentsPerMdu: number } | null = null

  const result = await bootstrapAppendBaseFromNetwork({
    rawMduCapacity,
    commitmentsPerMdu: 96,
    listFiles: async () => files,
    fetchFileBytes: async (file) => {
      const payload = bytesByPath.get(file.path)
      assert.ok(payload, `missing payload for ${file.path}`)
      return payload
    },
    initMdu0Builder: async (userCount, commitmentsPerMdu) => {
      initArgs = { userCount, commitmentsPerMdu }
    },
    appendFileToMdu0: async (filePath, sizeBytes, startOffset, flags) => {
      appended.push({ path: filePath, sizeBytes, startOffset, flags })
    },
    getMdu0Bytes: async () => new Uint8Array([0xaa, 0xbb, 0xcc]),
    encodeToMdu: (rawMdu) => rawMdu.slice(),
  })

  assert.ok(result)
  assert.deepEqual(initArgs, { userCount: 2, commitmentsPerMdu: 96 })
  assert.equal(result.baseMdu0Bytes.length, 3)
  assert.equal(result.existingUserCount, 2)
  assert.equal(result.existingMaxEnd, 10)
  assert.equal(result.appendStartOffset, 16)
  assert.equal(result.existingUserMdus.length, 2)
  assert.deepEqual(
    appended,
    [
      { path: 'alpha.txt', sizeBytes: 5, startOffset: 0, flags: 3 },
      { path: 'tail.bin', sizeBytes: 4, startOffset: 6, flags: 7 },
    ],
  )

  const first = result.existingUserMdus[0]?.data
  const second = result.existingUserMdus[1]?.data
  const firstRaw = result.existingUserMdus[0]?.rawData
  const secondRaw = result.existingUserMdus[1]?.rawData
  assert.ok(first)
  assert.ok(second)
  assert.ok(firstRaw)
  assert.ok(secondRaw)
  assert.equal(new TextDecoder().decode(first.subarray(0, 5)), 'HELLO')
  assert.equal(new TextDecoder().decode(first.subarray(6, 8)), 'WX')
  assert.equal(new TextDecoder().decode(second.subarray(0, 2)), 'YZ')
  assert.equal(new TextDecoder().decode(firstRaw.subarray(0, 5)), 'HELLO')
  assert.equal(new TextDecoder().decode(firstRaw.subarray(6, 8)), 'WX')
  assert.equal(new TextDecoder().decode(secondRaw.subarray(0, 2)), 'YZ')
})

test('bootstrapAppendBaseFromNetwork returns null when provider has no committed files', async () => {
  const result = await bootstrapAppendBaseFromNetwork({
    rawMduCapacity: 8,
    commitmentsPerMdu: 48,
    listFiles: async () => [],
    fetchFileBytes: async () => new Uint8Array(),
    initMdu0Builder: async () => undefined,
    appendFileToMdu0: async () => undefined,
    getMdu0Bytes: async () => new Uint8Array(),
    encodeToMdu: (rawMdu) => rawMdu,
  })

  assert.equal(result, null)
})

test('bootstrapAppendBaseFromNetwork rejects retrieval size mismatches', async () => {
  await assert.rejects(
    () =>
      bootstrapAppendBaseFromNetwork({
        rawMduCapacity: 8,
        commitmentsPerMdu: 48,
        listFiles: async () => [
          {
            path: 'broken.bin',
            size_bytes: 5,
            start_offset: 0,
            flags: 0,
            cache_present: true,
          },
        ],
        fetchFileBytes: async () => new Uint8Array([1, 2, 3]),
        initMdu0Builder: async () => undefined,
        appendFileToMdu0: async () => undefined,
        getMdu0Bytes: async () => new Uint8Array(),
        encodeToMdu: (rawMdu) => rawMdu,
      }),
    /bootstrap retrieval size mismatch/,
  )
})
