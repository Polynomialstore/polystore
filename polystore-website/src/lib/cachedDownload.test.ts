import assert from 'node:assert'
import { test } from 'node:test'
import { bech32 } from 'bech32'

import {
  cachedDownloadAuthority,
  hasVerifiedCachedDownload,
  preferVerifiedCache,
  readVerifiedCachedDownload,
  type CachedDownloadInput,
  type CachedDownloadStorage,
  type CachedDownloadVerifier,
  verifiedCachedDownloadAvailability,
} from './cachedDownload'
import { RAW_MDU_CAPACITY, readPolyfsFileFromVerifiedLayout } from './polyfsOpfsFetch'
import type { CompleteSlabGeneration, SlabMetadata } from './storage/OpfsAdapter'

const root = `0x${'ab'.repeat(32)}`
const otherRoot = `0x${'cd'.repeat(32)}`
const evmOwner = `0x${'12'.repeat(20)}`
const chainOwner = bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(0x12)))
const file = { path: 'report.txt', start_offset: 0, size_bytes: 4, flags: 0 }
const authority = cachedDownloadAuthority({ cid: root, total_mdus: '3', witness_mdus: '1', redundancy_mode: 2, mode2_profile: { k: 8, m: 4 } })!
const completeMdu = new Uint8Array(8 * 1024 * 1024)
completeMdu.set([1, 2, 3, 4], 28)
const input: CachedDownloadInput = {
  dealId: '7',
  manifestRoot: root,
  owner: chainOwner,
  viewerOwners: [evmOwner],
  file,
  authority,
}

const verifier: CachedDownloadVerifier = {
  verifyMetadata: async () => [{ path: file.path, start_offset: BigInt(file.start_offset), size_bytes: BigInt(file.size_bytes), flags: file.flags }],
  verifyWitness: async (bytes) => bytes,
  readCommitments: async (pin) => new Uint8Array(pin.leafCount * 48),
  verifyMdu: async (_pin, bytes) => bytes,
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
    readMdu: async (index) => index >= 0 && index <= 2 ? completeMdu.slice() : null,
    mduSize: async (index) => index >= 0 && index <= 2 ? completeMdu.byteLength : null,
    ...overrides,
  }
}

function storage(candidate: CompleteSlabGeneration | null): CachedDownloadStorage {
  return { openGeneration: async () => candidate }
}

test('cache authority accepts only exact current Mode 2 chain geometry', () => {
  assert.deepEqual(authority, {
    root, layout: 2, k: 8, m: 4, rows: 8, leafCount: 96,
    metadataMdus: 2n, userMdus: 1n, totalMdus: 3n,
  })
  assert.equal(cachedDownloadAuthority({ cid: root, total_mdus: '3', witness_mdus: '1', redundancy_mode: 1, mode2_profile: { k: 8, m: 4 } }), null)
  assert.equal(cachedDownloadAuthority({ cid: root, total_mdus: '3', witness_mdus: '0', redundancy_mode: 2, mode2_profile: { k: 8, m: 4 } }), null)
  assert.equal(cachedDownloadAuthority({ cid: root, total_mdus: '3', witness_mdus: '1', redundancy_mode: 2, mode2_profile: { k: 3, m: 1 } }), null)
})

test('verified complete current-generation cache bypasses paid network retrieval while v2 is inactive', async () => {
  let networkCalls = 0
  const result = await preferVerifiedCache(
    () => readVerifiedCachedDownload(input, storage(generation()), verifier),
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
    readMdu: async (index) => index === 2 ? mdu : index < 2 ? completeMdu.slice() : null,
  })
  assert.deepEqual(await readVerifiedCachedDownload(input, storage(candidate), verifier), new Uint8Array([1, 2, 3, 4]))
})

test('partial cache falls back to the secured-network availability gate', async () => {
  let networkCalls = 0
  const partial = generation({
    mduSize: async () => null,
    readMdu: async (index) => index < 2 ? completeMdu.slice() : null,
  })
  await assert.rejects(
    preferVerifiedCache(
      () => readVerifiedCachedDownload(input, storage(partial), verifier),
      'secured retrieval inactive',
      async () => { networkCalls++; return 'paid' },
    ),
    /secured retrieval inactive/,
  )
  assert.equal(networkCalls, 0)
})

test('stale root, unauthorised viewer, wrong authenticated file, transformed file, and missing generation are rejected', async () => {
  const cases: Array<CachedDownloadStorage> = [
    storage(generation({ manifestRoot: otherRoot })),
    storage(generation({ readManifestRoot: async () => otherRoot })),
    storage(null),
  ]
  for (const candidate of cases) assert.equal(await readVerifiedCachedDownload(input, candidate, verifier), null)
  assert.equal(await readVerifiedCachedDownload({ ...input, viewerOwners: [`0x${'34'.repeat(20)}`] }, storage(generation()), verifier), null)
  assert.equal(await readVerifiedCachedDownload(input, storage(generation()), {
    ...verifier,
    verifyMetadata: async () => [{ path: 'other.txt', start_offset: 0n, size_bytes: 4n, flags: 0 }],
  }), null)
  const transformed = { ...file, flags: 2 }
  assert.equal(await readVerifiedCachedDownload(
    { ...input, file: transformed },
    storage(generation()), { ...verifier, verifyMetadata: async () => [{ path: file.path, start_offset: 0n, size_bytes: 4n, flags: 2 }] },
  ), null)
})

test('same-size MDU corruption, mutated FAT, and mutated witness fall back instead of serving bytes', async () => {
  const corrupted = completeMdu.slice()
  corrupted[28] ^= 1
  const cases: CachedDownloadVerifier[] = [
    {
      ...verifier,
      verifyMdu: async (_pin, bytes) => {
        if (bytes[28] !== 1) throw new Error('data commitments mismatch')
        return bytes
      },
    },
    { ...verifier, verifyMetadata: async () => { throw new Error('metadata root mismatch') } },
    { ...verifier, verifyWitness: async () => { throw new Error('witness root mismatch') } },
  ]
  const generations = [
    generation({ readMdu: async (index) => index === 2 ? corrupted : completeMdu.slice() }),
    generation(),
    generation(),
  ]
  for (let i = 0; i < cases.length; i += 1) {
    let networkCalls = 0
    const result = await preferVerifiedCache(
      () => readVerifiedCachedDownload(input, storage(generations[i]), cases[i]),
      undefined,
      async () => { networkCalls += 1; return 'secured' },
    )
    assert.deepEqual(result, { source: 'network', result: 'secured' })
    assert.equal(networkCalls, 1)
  }
})

test('mutated advisory slab metadata cannot change authenticated downloaded bytes', async () => {
  const candidate = generation({ readMetadata: async () => metadata({
    owner: `0x${'34'.repeat(20)}`,
    file_records: [{ path: file.path, start_offset: 9, size_bytes: 999, flags: 0 }],
  }) })
  assert.deepEqual(await readVerifiedCachedDownload(input, storage(candidate), verifier), new Uint8Array([1, 2, 3, 4]))
})

test('cache hits do not alter pending settlement state', async () => {
  const checkpoint = { unsettled: 2, warning: 'Provider settlement pending' }
  await preferVerifiedCache(
    () => readVerifiedCachedDownload(input, storage(generation()), verifier),
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
  assert.deepEqual(await readVerifiedCachedDownload(input, replacingStorage, verifier), new Uint8Array([1, 2, 3, 4]))
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

test('production WASM authenticates a two-MDU cached download before returning its bytes', { timeout: 120_000 }, async () => {
  const [{ readFile }, { default: init, PolyStoreWasm, WasmMdu0Builder }, recovery, wire] = await Promise.all([
    import('node:fs/promises'),
    import('./polystoreCoreRuntime.js'),
    import('./retrievalRecovery'),
    import('./retrievalWire'),
  ])
  const repoRoot = new URL('../../../', import.meta.url)
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', repoRoot)) })
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', repoRoot)))
  const raw = new Uint8Array(RAW_MDU_CAPACITY + 4)
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 17 + 3) % 251
  const encode = (payload: Uint8Array) => {
    const encoded = new Uint8Array(8 * 1024 * 1024)
    for (let i = 0; i < payload.length; i += 31) {
      const chunk = payload.subarray(i, i + 31)
      encoded.set(chunk, Math.floor(i / 31) * 32 + 32 - chunk.length)
    }
    return encoded
  }
  const userMdus = [encode(raw.subarray(0, RAW_MDU_CAPACITY)), encode(raw.subarray(RAW_MDU_CAPACITY))]
  const commitments = userMdus.map((encoded) => {
    const expanded = wasm.expand_mdu_rs_flat_uncommitted(encoded, 2, 1) as { shards_flat: Uint8Array | number[] }
    const flat = expanded.shards_flat instanceof Uint8Array ? expanded.shards_flat : Uint8Array.from(expanded.shards_flat)
    const list = new Uint8Array(96 * 48)
    for (let leaf = 0; leaf < 96; leaf += 1) list.set(wasm.commit_received_blob(flat.subarray(leaf * 131072, (leaf + 1) * 131072)), leaf * 48)
    return list
  })
  const witness = encode(Uint8Array.from([...commitments[0], ...commitments[1]]))
  const witnessRoot = Uint8Array.from(wasm.commit_mdu(witness).mdu_root)
  const userRoots = commitments.map((list) => {
    const value = wasm.compute_mdu_root(list)
    return value instanceof Uint8Array ? value : Uint8Array.from(value as ArrayLike<number>)
  })
  const builder = WasmMdu0Builder.new_with_commitments(2n, 96n)
  builder.set_root(0n, witnessRoot)
  userRoots.forEach((value, index) => builder.set_root(BigInt(index + 1), value))
  builder.append_file('verified.bin', BigInt(raw.length), 0n)
  const mdu0 = builder.bytes()
  builder.free()
  const manifestRoot = `0x${Buffer.from(wasm.commit_mdu(mdu0).mdu_root).toString('hex')}`
  const realAuthority = cachedDownloadAuthority({ cid: manifestRoot, total_mdus: '4', witness_mdus: '1', redundancy_mode: 2, mode2_profile: { k: 2, m: 1 } })!
  const realFile = { path: 'verified.bin', start_offset: 0, size_bytes: raw.length, flags: 0 }
  const phases = { metadataMs: 0, witnessMs: 0, commitmentsMs: 0, dataMs: 0 }
  const measured = async <T>(phase: keyof typeof phases, operation: () => T | Promise<T>): Promise<T> => {
    const started = performance.now()
    try { return await operation() } finally { phases[phase] += performance.now() - started }
  }
  const realVerifier: CachedDownloadVerifier = {
    verifyMetadata: (bytes, pin) => measured('metadataMs', () => wire.verifyRetrievalMetadata(bytes, pin, wasm)),
    verifyWitness: (bytes, cell) => measured('witnessMs', () => { recovery.verifyWitnessMdu(bytes, cell, wasm); return bytes }),
    readCommitments: (pin, ordinal, bytes, cell) => measured('commitmentsMs', () => recovery.readUserCommitments(pin, ordinal, bytes, cell, wasm)),
    verifyMdu: (pin, bytes, list) => measured('dataMs', () => { recovery.verifyRecoveredMdu(pin, bytes, list, wasm); return bytes }),
  }
  const mutatedFat = mdu0.slice()
  const fatPathOffset = 16 * 128 * 1024 + Math.floor(152 / 31) * 32 + 1 + 152 % 31
  mutatedFat[fatPathOffset] ^= 1
  assert.throws(() => wire.verifyRetrievalMetadata(mutatedFat, realAuthority, wasm), /generation/)
  const mutatedWitness = witness.slice(); mutatedWitness[31] ^= 1
  assert.throws(() => recovery.verifyWitnessMdu(mutatedWitness, mdu0.subarray(0, 32), wasm), /root/)
  const mutatedUser = userMdus[0].slice(); mutatedUser[31] ^= 1
  assert.throws(() => recovery.verifyRecoveredMdu(realAuthority, mutatedUser, commitments[0], wasm), /commitments/)
  const realGeneration = generation({
    manifestRoot,
    readManifestRoot: async () => manifestRoot,
    readMetadata: async () => metadata({
      generation_id: manifestRoot.slice(2), manifest_root: manifestRoot,
      witness_mdus: 1, user_mdus: 2, total_mdus: 4, file_records: [realFile],
    }),
    readMdu: async (index) => [mdu0, witness, ...userMdus][index]?.slice() ?? null,
    mduSize: async (index) => index >= 0 && index < 4 ? 8 * 1024 * 1024 : null,
  })
  const started = performance.now()
  try {
    const downloaded = await readVerifiedCachedDownload({
      dealId: '7', manifestRoot, owner: chainOwner, viewerOwners: [evmOwner], file: realFile, authority: realAuthority,
    }, storage(realGeneration), realVerifier)
    assert.deepEqual(downloaded, raw)
    const measurement = {
      physicalMibVerified: 16,
      outputBytes: raw.length,
      ...Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, Number(value.toFixed(1))])),
      totalMs: Number((performance.now() - started).toFixed(1)),
    }
    console.log(`cached-download-verification ${JSON.stringify(measurement)}`)
  } finally {
    wasm.free()
  }
})
