import test from 'node:test'
import assert from 'node:assert/strict'

import { bootstrapAppendBaseFromMdus, bootstrapAppendBaseFromNetwork } from './bootstrapAppendBase'
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
  assert.equal(firstRaw.length, 8)
  assert.equal(secondRaw.length, 2)
})

test('bootstrapAppendBaseFromNetwork trims raw payloads to occupied committed bytes', async () => {
  const result = await bootstrapAppendBaseFromNetwork({
    rawMduCapacity: 8,
    commitmentsPerMdu: 96,
    listFiles: async () => [
      { path: 'zeros.bin', size_bytes: 3, start_offset: 2, flags: 0, cache_present: true },
    ],
    fetchFileBytes: async () => new Uint8Array([0, 0, 0]),
    initMdu0Builder: async () => undefined,
    appendFileToMdu0: async () => undefined,
    getMdu0Bytes: async () => new Uint8Array([1]),
    encodeToMdu: (rawMdu) => rawMdu.slice(),
  })

  assert.ok(result)
  assert.equal(result.existingUserMdus.length, 1)
  assert.equal(result.existingUserMdus[0]?.rawData?.length, 5)
  assert.deepEqual(Array.from(result.existingUserMdus[0]?.rawData ?? []), [0, 0, 0, 0, 0])
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

test('bootstrapAppendBaseFromMdus reconstructs append base from committed user mdus', () => {
  const rawMduCapacity = 8
  const mdu0 = new Uint8Array(8 * 1024 * 1024)
  const BLOB = 128 * 1024
  mdu0.set(new TextEncoder().encode('NILF'), 16 * BLOB)
  new DataView(mdu0.buffer).setUint32(16 * BLOB + 8, 1, true)
  const recordOffset = 16 * BLOB + 128
  new DataView(mdu0.buffer).setBigUint64(recordOffset, 0n, true)
  new DataView(mdu0.buffer).setBigUint64(recordOffset + 8, 10n, true)
  mdu0.set(new TextEncoder().encode('alpha.bin'), recordOffset + 24)

  const result = bootstrapAppendBaseFromMdus({
    rawMduCapacity,
    mdu0Bytes: mdu0,
    userMdus: [
      { index: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
      { index: 1, data: new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]) },
    ],
    decodeRawMdu: (mdu, rawValidLen) => mdu.slice(0, rawValidLen),
  })

  assert.ok(result)
  assert.equal(result.existingUserCount, 2)
  assert.equal(result.existingMaxEnd, 10)
  assert.equal(result.appendStartOffset, 16)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0]?.path, 'alpha.bin')
  assert.deepEqual(Array.from(result.existingUserMdus[0]?.rawData ?? []), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(Array.from(result.existingUserMdus[1]?.rawData ?? []), [9, 10])
})

test('bootstrapAppendBaseFromMdus rejects mismatched committed user mdu count', () => {
  const mdu0 = new Uint8Array(8 * 1024 * 1024)
  const BLOB = 128 * 1024
  mdu0.set(new TextEncoder().encode('NILF'), 16 * BLOB)
  new DataView(mdu0.buffer).setUint32(16 * BLOB + 8, 1, true)
  const recordOffset = 16 * BLOB + 128
  new DataView(mdu0.buffer).setBigUint64(recordOffset, 0n, true)
  new DataView(mdu0.buffer).setBigUint64(recordOffset + 8, 10n, true)
  mdu0.set(new TextEncoder().encode('alpha.bin'), recordOffset + 24)

  assert.throws(
    () =>
      bootstrapAppendBaseFromMdus({
        rawMduCapacity: 8,
        mdu0Bytes: mdu0,
        userMdus: [{ index: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }],
        decodeRawMdu: (mdu, rawValidLen) => mdu.slice(0, rawValidLen),
      }),
    /bootstrap MDU count mismatch/,
  )
})
