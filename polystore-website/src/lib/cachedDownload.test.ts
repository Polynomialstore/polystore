import assert from 'node:assert'
import { test } from 'node:test'
import { bech32 } from 'bech32'

import {
  hasVerifiedCachedDownload,
  preferVerifiedCache,
  readVerifiedCachedDownload,
  type CachedDownloadInput,
  type CachedDownloadStorage,
  verifiedCachedDownloadAvailability,
} from './cachedDownload'
import { readPolyfsFileFromVerifiedLayout } from './polyfsOpfsFetch'
import type { CompleteSlabGeneration, SlabMetadata } from './storage/OpfsAdapter'

const root = `0x${'ab'.repeat(48)}`
const otherRoot = `0x${'cd'.repeat(48)}`
const evmOwner = `0x${'12'.repeat(20)}`
const chainOwner = bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(0x12)))
const file = { path: 'report.txt', start_offset: 0, size_bytes: 4, flags: 0 }
const completeMdu = new Uint8Array(8 * 1024 * 1024)
completeMdu.set([1, 2, 3, 4], 28)
const input: CachedDownloadInput = {
  dealId: '7',
  manifestRoot: root,
  owner: chainOwner,
  viewerOwners: [evmOwner],
  file,
}

function metadata(overrides: Partial<SlabMetadata> = {}): SlabMetadata {
  return {
    schema_version: 1,
    generation_id: root.slice(2),
    deal_id: '7',
    manifest_root: root,
    owner: evmOwner,
    source: 'browser_mode2_commit',
    created_at: '2026-09-09T00:00:00Z',
    last_validated_at: null,
    witness_mdus: 1,
    user_mdus: 1,
    total_mdus: 3,
    file_records: [file],
    ...overrides,
  }
}

function generation(overrides: Partial<CompleteSlabGeneration> = {}): CompleteSlabGeneration {
  return {
    manifestRoot: root,
    readManifestRoot: async () => root,
    readMetadata: async () => metadata(),
    readMdu: async (index) => index === 2 ? completeMdu : null,
    mduSize: async (index) => index === 2 ? completeMdu.byteLength : null,
    ...overrides,
  }
}

function storage(candidate: CompleteSlabGeneration | null): CachedDownloadStorage {
  return { openGeneration: async () => candidate }
}

test('verified complete current-generation cache bypasses paid network retrieval while v2 is inactive', async () => {
  let networkCalls = 0
  const result = await preferVerifiedCache(
    () => readVerifiedCachedDownload(input, storage(generation())),
    'secured retrieval inactive',
    async () => { networkCalls++; return 'paid' },
  )
  assert.equal(result.source, 'cache')
  assert.equal(networkCalls, 0)
  if (result.source === 'cache') assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3, 4]))
})

test('availability checks sizes without reading or allocating cached payloads', async () => {
  let payloadReads = 0
  const candidate = generation({
    mduSize: async () => 8 * 1024 * 1024,
    readMdu: async () => { payloadReads++; return null },
  })
  assert.equal(await hasVerifiedCachedDownload(input, storage(candidate)), true)
  assert.equal(payloadReads, 0)
})

test('a file listing opens and parses one pinned generation', async () => {
  let opens = 0
  let metadataReads = 0
  let sizeReads = 0
  const second = { path: 'second.txt', start_offset: 4, size_bytes: 4, flags: 0 }
  const candidate = generation({
    readMetadata: async () => { metadataReads++; return metadata({ file_records: [file, second] }) },
    mduSize: async () => { sizeReads++; return completeMdu.byteLength },
  })
  const availability = await verifiedCachedDownloadAvailability([
    input,
    { ...input, file: second },
  ], { openGeneration: async () => { opens++; return candidate } })
  assert.deepEqual(availability, { 'report.txt': true, 'second.txt': true })
  assert.equal(opens, 1)
  assert.equal(metadataReads, 1)
  assert.equal(sizeReads, 1)
})

test('complete committed MDU bytes are decoded from the pinned generation', async () => {
  const mdu = new Uint8Array(8 * 1024 * 1024)
  mdu.set([1, 2, 3, 4], 28)
  const candidate = generation({
    mduSize: async () => mdu.byteLength,
    readMdu: async (index) => index === 2 ? mdu : null,
  })
  assert.deepEqual(await readVerifiedCachedDownload(input, storage(candidate)), new Uint8Array([1, 2, 3, 4]))
})

test('partial cache falls back to the secured-network availability gate', async () => {
  let networkCalls = 0
  const partial = generation({
    mduSize: async () => null,
  })
  await assert.rejects(
    preferVerifiedCache(
      () => readVerifiedCachedDownload(input, storage(partial)),
      'secured retrieval inactive',
      async () => { networkCalls++; return 'paid' },
    ),
    /secured retrieval inactive/,
  )
  assert.equal(networkCalls, 0)
})

test('stale root, wrong owner, wrong deal, wrong file, transformed file, and missing generation are rejected', async () => {
  const cases: Array<CachedDownloadStorage> = [
    storage(generation({ manifestRoot: otherRoot })),
    storage(generation({ readManifestRoot: async () => otherRoot })),
    storage(generation({ readMetadata: async () => metadata({ manifest_root: otherRoot }) })),
    storage(generation({ readMetadata: async () => metadata({ owner: `0x${'34'.repeat(20)}` }) })),
    storage(generation({ readMetadata: async () => metadata({ deal_id: '8' }) })),
    storage(generation({ readMetadata: async () => metadata({ file_records: [{ ...file, path: 'other.txt' }] }) })),
    storage(generation({ readMetadata: async () => metadata({ file_records: [{ ...file, flags: 2 }] }) })),
    storage(generation({ readMetadata: async () => metadata({ witness_mdus: 1.5, total_mdus: 3.5 }) })),
    storage(null),
  ]
  for (const candidate of cases) assert.equal(await readVerifiedCachedDownload(input, candidate), null)
  const transformed = { ...file, flags: 2 }
  assert.equal(await readVerifiedCachedDownload(
    { ...input, file: transformed },
    storage(generation({ readMetadata: async () => metadata({ file_records: [transformed] }) })),
  ), null)
})

test('cache hits do not alter pending settlement state', async () => {
  const checkpoint = { unsettled: 2, warning: 'Provider settlement pending' }
  await preferVerifiedCache(
    () => readVerifiedCachedDownload(input, storage(generation())),
    undefined,
    async () => { checkpoint.unsettled = 0; checkpoint.warning = ''; return 'network' },
  )
  assert.deepEqual(checkpoint, { unsettled: 2, warning: 'Provider settlement pending' })
})

test('a generation replacement during reads cannot mix the new generation into the download', async () => {
  let active = generation({
    manifestRoot: otherRoot,
    readManifestRoot: async () => otherRoot,
    readMetadata: async () => metadata({ manifest_root: otherRoot }),
    readMdu: async () => new Uint8Array(completeMdu.byteLength).fill(9),
  })
  const pinned = generation({
    readManifestRoot: async () => {
      active = generation({ manifestRoot: otherRoot })
      return root
    },
  })
  let opens = 0
  const replacingStorage: CachedDownloadStorage = {
    openGeneration: async () => {
      opens++
      return opens === 1 ? pinned : active
    },
  }
  assert.deepEqual(await readVerifiedCachedDownload(input, replacingStorage), new Uint8Array([1, 2, 3, 4]))
  assert.equal(opens, 1)
})

test('gateway-style metadata/root rebinding over an older complete generation fails closed', async () => {
  const rebound = generation({
    manifestRoot: root,
    readManifestRoot: async () => otherRoot,
    readMetadata: async () => metadata({ manifest_root: otherRoot, generation_id: otherRoot.slice(2) }),
  })
  assert.equal(await hasVerifiedCachedDownload({ ...input, manifestRoot: otherRoot }, storage(rebound)), false)
})

test('cache miss uses secured network only when it is available', async () => {
  let networkCalls = 0
  const result = await preferVerifiedCache(
    () => readVerifiedCachedDownload(input, storage(null)),
    undefined,
    async () => { networkCalls++; return 'paid' },
  )
  assert.deepEqual(result, { source: 'network', result: 'paid' })
  assert.equal(networkCalls, 1)
})

test('verified-layout reader rejects a short local MDU instead of zero-padding it', async () => {
  await assert.rejects(
    readPolyfsFileFromVerifiedLayout({
      dealId: '7', file, allFiles: [file], witnessMdus: 1, userMdus: 1, totalMdus: 3,
    }, async () => new Uint8Array([0, 1, 2, 3, 4])),
    /incomplete/,
  )
})
