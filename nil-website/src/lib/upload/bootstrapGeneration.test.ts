import test from 'node:test'
import assert from 'node:assert/strict'

import { materializeBootstrapGeneration } from './bootstrapGeneration'

const rootByte = (value: number) => new Uint8Array(32).fill(value)
const blobByte = (value: number) => new Uint8Array([value, value + 1, value + 2])

test('materializeBootstrapGeneration builds witness/mdus/manifest and verifies root', async () => {
  const calls: Array<string> = []
  const setRoots: Array<{ index: number; root: number }> = []

  const result = await materializeBootstrapGeneration({
    baseMdu0Bytes: new Uint8Array([9, 9, 9]),
    existingUserMdus: [
      { index: 1, data: new Uint8Array([2, 2]) },
      { index: 0, data: new Uint8Array([1, 1]) },
    ],
    expectedManifestRoot: `0x${'07'.repeat(32)}`,
    rsK: 2,
    rsM: 1,
    rawMduCapacity: 4,
    encodeToMdu: (raw) => new Uint8Array([...raw, 0xee]),
    loadMdu0Builder: async (_data, maxUserMdus, commitmentsPerMdu) => {
      calls.push(`load:${maxUserMdus}:${commitmentsPerMdu}`)
    },
    setMdu0Root: async (index, root) => {
      setRoots.push({ index, root: root[0] ?? 0 })
    },
    getMdu0Bytes: async () => {
      calls.push('getMdu0')
      return new Uint8Array([0xaa, 0xbb])
    },
    expandMduRs: async (data) => ({
      witness_flat: new Uint8Array([data[0] ?? 0, data[0] ?? 0, data[0] ?? 0]),
      mdu_root: rootByte((data[0] ?? 0) + 10),
      shards: [blobByte((data[0] ?? 0) + 20), blobByte((data[0] ?? 0) + 30), blobByte((data[0] ?? 0) + 40)],
    }),
    shardFile: async (data) => ({
      mdu_root: rootByte(data[0] ?? 0),
    }),
    computeManifest: async (roots) => {
      calls.push(`manifest:${roots.length / 32}`)
      return {
        root: rootByte(7),
        blob: new Uint8Array([7, 7, 7, 7]),
      }
    },
  })

  assert.equal(result.manifestRoot, `0x${'07'.repeat(32)}`)
  assert.deepEqual(Array.from(result.manifestBlob), [7, 7, 7, 7])
  assert.deepEqual(Array.from(result.mdu0Bytes), [0xaa, 0xbb])
  assert.equal(result.witnessCount, 2)
  assert.deepEqual(result.witnessMdus.map((mdu) => mdu.index), [1, 2])
  assert.deepEqual(result.userMdus.map((mdu) => mdu.index), [0, 1])
  assert.deepEqual(
    setRoots,
    [
      { index: 0, root: 1 },
      { index: 1, root: 2 },
      { index: 2, root: 11 },
      { index: 3, root: 12 },
    ],
  )
  assert.deepEqual(calls, ['load:2:96', 'getMdu0', 'manifest:5'])
  assert.deepEqual(
    result.shardSets.map((set) => ({ index: set.index, shard0: set.shards[0]?.data[0] })),
    [
      { index: 0, shard0: 21 },
      { index: 1, shard0: 22 },
    ],
  )
})

test('materializeBootstrapGeneration rejects manifest mismatches', async () => {
  await assert.rejects(
    () =>
      materializeBootstrapGeneration({
        baseMdu0Bytes: new Uint8Array([1]),
        existingUserMdus: [{ index: 0, data: new Uint8Array([1]) }],
        expectedManifestRoot: `0x${'09'.repeat(32)}`,
        rsK: 2,
        rsM: 1,
        rawMduCapacity: 8,
        encodeToMdu: (raw) => raw,
        loadMdu0Builder: async () => undefined,
        setMdu0Root: async () => undefined,
        getMdu0Bytes: async () => new Uint8Array([1]),
        expandMduRs: async () => ({
          witness_flat: new Uint8Array([1, 2, 3]),
          mdu_root: rootByte(2),
          shards: [new Uint8Array([1])],
        }),
        shardFile: async () => ({ mdu_root: rootByte(3) }),
        computeManifest: async () => ({ root: rootByte(4), blob: new Uint8Array([4]) }),
      }),
    /bootstrap manifest root mismatch/,
  )
})
