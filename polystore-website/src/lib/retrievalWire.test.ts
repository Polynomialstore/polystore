import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { encodeSessionBatch, parseRetrievalEnvelope, parseRetrievalEnvelopeV3, parseWindowProof, verifyRetrievalDataV3, verifyRetrievalMetadataV3, verifyRetrievalWindow, type RetrievalV3ChunkAuthority } from './retrievalWire'
import { hex, type FrozenSession } from './retrieval'
import init, { PolyStoreWasm } from './polystoreCoreRuntime.js'

const root = new URL('../../../', import.meta.url)
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
async function fixture() {
  const binary = await readFile(new URL('polystore_core/tests/testdata/session-batch-input.bin', root))
  let at = 106
  const take = (n: number) => { const out = binary.subarray(at, at + n); at += n; return out }
  const proofs = Array.from({ length: binary.readUInt16BE(4) }, () => {
    const mdu_index = Number(take(8).readBigUInt64BE()), blob_index = take(4).readUInt32BE()
    const p = { mdu_index, ...(blob_index ? { blob_index } : {}), mdu_root_fr: b64(take(32)), root_table_du_commitment: b64(take(48)), manifest_opening: b64(take(48)),
      blob_commitment: b64(take(48)), z_value: b64(take(32)), y_value: b64(take(32)), kzg_opening_proof: b64(take(48)), root_table_du_merkle_path: [] as string[], merkle_path: [] as string[] }
    const roots = take(2).readUInt16BE(), blobs = take(2).readUInt16BE()
    p.root_table_du_merkle_path = Array.from({ length: roots }, () => b64(take(32)))
    p.merkle_path = Array.from({ length: blobs }, () => b64(take(32)))
    return p
  })
  assert.equal(at, binary.length)
  const session = { sessionId: `0x${'22'.repeat(32)}`, contextHash: binary.subarray(42, 74), seed: binary.subarray(74, 106), context: new Uint8Array(),
    pin: { root: hex(binary.subarray(10, 42)), leafCount: binary.readUInt32BE(6) }, window: { blobCount: proofs.length, mduIndex: BigInt(proofs[0].mdu_index), startBlobIndex: 0 },
    height: 12n, openedHeight: 10n, expiry: 20n } as unknown as FrozenSession
  const metadata = { version: 2, session_id: session.sessionId, context_hash: hex(session.contextHash), manifest_root: session.pin.root,
    start_mdu_index: session.window.mduIndex.toString(), start_blob_index: 0, blob_count: String(proofs.length), total_bytes: String(proofs.length * 131072), proofs }
  const bytes = new Uint8Array(proofs.length * 131072)
  return { binary, session, metadata, bytes }
}
function response(metadata: unknown, bytes: Uint8Array, extras = '') {
  const prefix = Buffer.from(`--secure-window\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--secure-window\r\nContent-Disposition: form-data; name="bytes"; filename="blobs.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  return new Response(Buffer.concat([prefix, bytes, Buffer.from(`\r\n--secure-window--\r\n${extras}`)]), { headers: { 'content-type': 'multipart/form-data; boundary=secure-window; version=2' } })
}
function responseV3(metadata: unknown, bytes: Uint8Array) {
  const prefix = Buffer.from(`--secure-v3\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--secure-v3\r\nContent-Disposition: form-data; name="bytes"; filename="blobs.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  return new Response(Buffer.concat([prefix, bytes, Buffer.from('\r\n--secure-v3--\r\n')]), { headers: { 'content-type': 'multipart/form-data; boundary=secure-v3; version=3' } })
}

test('bounded C5 decoder encodes the independent PSB1 bytes exactly', async () => {
  const f = await fixture()
  const envelope = await parseRetrievalEnvelope(response(f.metadata, f.bytes), f.session)
  const batch = encodeSessionBatch(envelope.proofs, Buffer.from(f.session.pin.root.slice(2), 'hex'), f.session.contextHash, f.session.seed!, f.session.pin.leafCount)
  assert.deepEqual(Buffer.from(batch), f.binary)
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', root)))
  assert.equal(wasm.verify_polyfs_session_batch(batch), true)
  // This independent batch fixture deliberately uses an artificial context hash;
  // it must not be promoted to an authenticated consumer challenge.
  assert.throws(() => verifyRetrievalWindow(f.session, envelope, wasm, PolyStoreWasm))
  wasm.free()
})

test('C5 rejects wrong sessions, extras, truncated bytes and malformed proofs', async () => {
  const f = await fixture()
  for (const override of [{ session_id: `0x${'33'.repeat(32)}` }, { blob_count: 8 }, { start_mdu_index: '04097' }, { start_blob_index: -1 }, { version: 1 }, { total_bytes: '1' }, { proofs: [] }, { untrusted_payee: 'someone' }]) {
    await assert.rejects(parseRetrievalEnvelope(response({ ...f.metadata, ...override }, f.bytes), f.session))
  }
  await assert.rejects(parseRetrievalEnvelope(response(f.metadata, f.bytes.subarray(1)), f.session), /part size/)
  await assert.rejects(parseRetrievalEnvelope(response(f.metadata, f.bytes, 'ignored'), f.session), /framing/)
  const long = response(f.metadata, f.bytes); long.headers.set('content-length', '999999999')
  await assert.rejects(parseRetrievalEnvelope(long, f.session), /limit/)
  const p = f.metadata.proofs[0]
  for (const override of [{ mdu_index: '4097' }, { mdu_index: 0 }, { blob_index: null }, { blob_index: 96 }, { z_value: '' }, { merkle_path: [] }, { root_table_du_merkle_path: [...p.root_table_du_merkle_path, p.root_table_du_merkle_path[0]] }]) {
    assert.throws(() => parseWindowProof({ ...p, ...override }, 96))
  }
})

test('real native window verifies authoritative C2, fresh openings and every received blob', async () => {
  const { parseFrozenSession } = await import('./retrieval')
  const query = JSON.parse(await readFile(new URL('testdata/retrieval-window-v2/session.json', root), 'utf8'))
  const metadata = JSON.parse(await readFile(new URL('testdata/retrieval-window-v2/metadata.json', root), 'utf8'))
  const bytes = await readFile(new URL('testdata/retrieval-window-v2/window.bin', root))
  const pin = { chainId: 'test-1', height: 9n, dealId: 9007199254740993n, generation: 7n, root: metadata.manifest_root,
    owner: query.session.owner, endHeight: 100n, layout: 2 as const, k: 8, m: 4, rows: 8, leafCount: 96, metadataMdus: 2n, userMdus: 1n, totalMdus: 3n, assignments: [] }
  const window = { mduIndex: 2n, slot: 1, provider: query.session.provider, startBlobIndex: 8, blobCount: 2, slices: [] }
  const expected = { sessionId: metadata.session_id, pin, window, owner: query.session.owner, payee: query.session.authorized_proof_provider, funding: 1 as const }
  const session = parseFrozenSession(query, 12n, expected)
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', root)))
  try {
    const envelope = await parseRetrievalEnvelope(response(metadata, bytes), session)
    assert.deepEqual(Buffer.from(verifyRetrievalWindow(session, envelope, wasm, PolyStoreWasm)), bytes)
    const corrupt = Uint8Array.from(bytes); corrupt[32 * 5 + 31] ^= 1
    assert.throws(() => verifyRetrievalWindow(session, { ...envelope, bytes: corrupt }, wasm, PolyStoreWasm), /received bytes/)
    const swapped = { ...envelope, proofs: envelope.proofs.slice().reverse() }
    assert.throws(() => verifyRetrievalWindow(session, swapped, wasm, PolyStoreWasm), /challenge/)
    assert.throws(() => parseFrozenSession(query, 12n, { ...expected, payee: expected.owner }), /request/)
    assert.throws(() => parseFrozenSession(query, 51n, expected), /request/)
    assert.throws(() => parseFrozenSession({ ...query, session: { ...query.session, deal_id: Number('9007199254740993') } }, 12n, expected), /uint64/)
  } finally { wasm.free() }
})

test('canonical native MDU0 authenticates the same generation before paid open', async () => {
  const { gunzipSync } = await import('node:zlib')
  const { verifyRetrievalMetadata } = await import('./retrievalWire')
  const metadata = JSON.parse(await readFile(new URL('testdata/retrieval-window-v2/metadata.json', root), 'utf8'))
  const bytes = gunzipSync(await readFile(new URL('testdata/retrieval-window-v2/mdu_0.bin.gz', root)))
  assert.equal(bytes.length, 8388608)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '6196750acd73cd9a7f04b53c4dc2d5993483a128251c9b1d1e69558fabdb42e0')
  const pin = { root: metadata.manifest_root, userMdus: 1n } as FrozenSession['pin']
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', root)))
  try {
    const records = verifyRetrievalMetadata(bytes, pin, wasm)
    assert.ok(records.some((r) => r.path && r.size_bytes > 0n))
    const bad = Uint8Array.from(bytes); bad[31] ^= 1
    assert.throws(() => verifyRetrievalMetadata(bad, pin, wasm), /generation/)
    assert.throws(() => verifyRetrievalMetadata(bytes, { ...pin, userMdus: 0n }, wasm), /extent/)
  } finally { wasm.free() }
})

test('native v3 WASM matches shared context, FAT and odd-tree integrity vectors', async () => {
  const golden = JSON.parse(await readFile(new URL('polystorechain/pkg/retrievalchallenge/testdata/large-session-v3-golden.json', root), 'utf8'))
  await init({ module_or_path: await readFile(new URL('polystore-website/public/wasm/polystore_core_bg.wasm', root)) })
  const wasm = new PolyStoreWasm(await readFile(new URL('polystorechain/trusted_setup.txt', root)))
  const bytes = (value: string) => Buffer.from(value, 'hex')
  try {
    const transcript = golden.small_transcript
    const range = PolyStoreWasm.checked_retrieval_v3_range(0n, BigInt(transcript.range_length), 0n, BigInt(transcript.range_length), 1n)
    const rangeView = new DataView(range.buffer, range.byteOffset, range.byteLength)
    assert.deepEqual([rangeView.getBigUint64(0), rangeView.getBigUint64(8), rangeView.getBigUint64(16)], [0n, 16n, 17n])
    for (const candidate of golden.ranges) {
      const start = BigInt(candidate.start), length = BigInt(candidate.length)
      const last = (start + length - 1n) / 126976n
      const checked = PolyStoreWasm.checked_retrieval_v3_range(start, length, 0n, length, last / 64n + 1n)
      const checkedView = new DataView(checked.buffer, checked.byteOffset, checked.byteLength)
      assert.equal(checkedView.getBigUint64(16), BigInt(candidate.population))
    }
    const providers = Uint8Array.from({ length: 160 }, (_, i) => 0x40 + Math.floor(i / 20))
    const oneBlobPlan = PolyStoreWasm.retrieval_v3_plan(0n, 0n, 1n, providers)
    const planDomainBytes = new TextEncoder().encode('polystore/retrieval-plan/v3').length
    const obligationOffset = 4 + planDomainBytes + 24
    const oneBlobView = new DataView(oneBlobPlan.buffer, oneBlobPlan.byteOffset, oneBlobPlan.byteLength)
    assert.equal(oneBlobView.getUint32(obligationOffset), 1)
    assert.equal(oneBlobView.getUint32(obligationOffset + 4), 0)
    const plan = PolyStoreWasm.retrieval_v3_plan(0n, 16n, 17n, providers)
    assert.equal(hex(plan), `0x${transcript.plan_hex}`)
    assert.equal(hex(PolyStoreWasm.retrieval_v3_session_id('polystore-test-1', Uint8Array.from({ length: 20 }, () => 0x11), 42n, 7n, 3, 0n,
      BigInt(transcript.range_length), bytes(transcript.plan_hash), 9n)), `0x${transcript.session_id}`)
    const obligation = transcript.obligations[0]
    assert.equal(hex(PolyStoreWasm.retrieval_v3_obligation_ack_hash('polystore-test-1', bytes(transcript.session_id), bytes(transcript.context_hash),
      bytes(transcript.plan_hash), obligation.slot, bytes(obligation.assigned), bytes(obligation.payee), BigInt(obligation.blob_count),
      BigInt(obligation.blob_count * 131072), bytes(golden.integrity.root))), `0x${transcript.ack_first_obligation_hash}`)
    assert.throws(() => PolyStoreWasm.checked_retrieval_v3_range(0n, 1n, 0n, 0n, 1n))
    assert.throws(() => PolyStoreWasm.checked_retrieval_v3_range(0 as unknown as bigint, 1n, 0n, 1n, 1n))
    assert.throws(() => PolyStoreWasm.checked_retrieval_v3_range(1n << 64n, 1n, 0n, 1n, 1n))
    assert.throws(() => PolyStoreWasm.retrieval_v3_plan(0n, 16n, 17n, providers.subarray(1)))
    assert.throws(() => PolyStoreWasm.retrieval_v3_session_id('polystore-test-1', new Uint8Array(19), 42n, 7n, 3, 0n, 1n, bytes(transcript.plan_hash), 9n))
    assert.throws(() => PolyStoreWasm.retrieval_v3_obligation_ack_hash('polystore-test-1', bytes(transcript.session_id), bytes(transcript.context_hash),
      bytes(transcript.plan_hash), obligation.slot, bytes(obligation.assigned), bytes(obligation.payee), BigInt(obligation.blob_count), 1n, bytes(golden.integrity.root)))
    const context = bytes(transcript.context_hex)
    assert.equal(hex(PolyStoreWasm.retrieval_v3_context_hash(context)), `0x${transcript.context_hash}`)
    assert.throws(() => PolyStoreWasm.retrieval_v3_context_hash(context.subarray(0, context.length - 1)))
    assert.throws(() => PolyStoreWasm.retrieval_v3_context_hash(Buffer.concat([context, Buffer.from([0])])))
    for (const name of ['small', 'offset', 'large']) {
      const candidate = golden[`${name}_transcript`]
      const candidateContext = bytes(candidate.context_hex)
      assert.equal(hex(PolyStoreWasm.retrieval_v3_context_hash(candidateContext)), `0x${candidate.context_hash}`)
      const seed = PolyStoreWasm.retrieval_v3_seed(candidateContext, bytes(candidate.anchor_hash))
      assert.equal(hex(seed), `0x${candidate.seed}`)
      const challenges = PolyStoreWasm.derive_retrieval_v3_challenges(candidateContext, seed)
      assert.equal(challenges.length, candidate.sample_count * 72)
      const view = new DataView(challenges.buffer, challenges.byteOffset, challenges.byteLength)
      if (name === 'large') {
        const positions = Array.from({ length: candidate.sample_count }, (_, i) => challenges.subarray(i * 72 + 8, i * 72 + 16))
        assert.equal(createHash('sha256').update(Buffer.concat(positions)).digest('hex'), golden.large_sample.positions_sha256)
        assert.deepEqual(positions.slice(0, 8).map((position) => Number(new DataView(position.buffer, position.byteOffset, 8).getBigUint64(0))), golden.large_sample.first_eight)
      } else {
        golden[`${name}_samples`].forEach((sample: Record<string, number | string>, i: number) => {
          const at = i * 72
          assert.deepEqual([view.getBigUint64(at), view.getBigUint64(at + 8), view.getBigUint64(at + 16), view.getBigUint64(at + 24), view.getUint32(at + 32), view.getUint32(at + 36)],
            [BigInt(sample.ordinal), BigInt(sample.position), BigInt(sample.t), BigInt(sample.mdu_index), sample.leaf_index, sample.slot])
          assert.equal(hex(challenges.subarray(at + 40, at + 72)), `0x${sample.z}`)
        })
      }
    }
    const header = bytes(golden.fat_header.header_hex)
    assert.equal(wasm.verify_fat_v3_header(header, bytes(golden.integrity.root), 96n), 2)
    assert.throws(() => wasm.verify_fat_v3_header(header, bytes(golden.integrity.root), -1n))
    const patterns = golden.integrity.patterns.map((name: string) => {
      const blob = new Uint8Array(131072)
      if (name === 'valid_incrementing') for (let i = 0; i < 4096; i++) for (let j = 0; j < 31; j++) blob[i * 32 + 1 + j] = (i + j) & 255
      if (name === 'valid_ff') for (let i = 0; i < 4096; i++) blob.fill(255, i * 32 + 1, i * 32 + 32)
      return blob
    })
    golden.integrity.paths.forEach((path: string[], i: number) => {
      const flat = Buffer.concat(path.map(bytes))
      assert.equal(wasm.verify_integrity_v3_blob(10n, i, BigInt(i), 3n, patterns[i], flat, bytes(golden.integrity.root)), true)
    })
    const oddPath = Buffer.concat(golden.integrity.paths[2].map(bytes))
    assert.equal(wasm.verify_integrity_v3_blob(10n, 2, 2n, 3n, patterns[2], oddPath.subarray(0, oddPath.length - 32), bytes(golden.integrity.root)), false)
    assert.equal(wasm.verify_integrity_v3_blob(10n, 2, 2n, 3n, patterns[2], Buffer.concat([oddPath, oddPath.subarray(0, 32)]), bytes(golden.integrity.root)), false)
    const corrupted = patterns[2].slice(); corrupted[65_537] ^= 1
    assert.equal(wasm.verify_integrity_v3_blob(10n, 2, 2n, 3n, corrupted, Buffer.concat(golden.integrity.paths[2].map(bytes)), bytes(golden.integrity.root)), false)
    assert.throws(() => wasm.verify_integrity_v3_blob(10n, 0, 0n, 3n, patterns[0], new Uint8Array(31), bytes(golden.integrity.root)))
  } finally { wasm.free() }
})

test('v3 multipart binds every complete blob to frozen coordinates before return', async () => {
  const authority: RetrievalV3ChunkAuthority = {
    sessionId: `0x${'11'.repeat(32)}`, contextHash: Uint8Array.from({ length: 32 }, () => 0x22), polyfsRoot: `0x${'33'.repeat(32)}`,
    integrityRoot: `0x${'44'.repeat(32)}`, integrityLeafCount: 96n, metadataMdus: 2n, userMdus: 1n,
    slot: 0, mduIndex: 2n, startBlobIndex: 0,
    entries: [{ t: 0n, mduIndex: 2n, leafIndex: 0, integrityPosition: 0n }, { t: 8n, mduIndex: 2n, leafIndex: 1, integrityPosition: 1n }],
  }
  const path = [`0x${'55'.repeat(32)}`]
  const metadata = { version: 3, session_id: authority.sessionId, context_hash: hex(authority.contextHash), polyfs_root: authority.polyfsRoot,
    integrity_root: authority.integrityRoot, slot: 0, mdu_index: '2', start_blob_index: 0, blob_count: '2', total_bytes: '262144',
    entries: authority.entries.map((entry) => ({ t: String(entry.t), mdu_index: String(entry.mduIndex), leaf_index: entry.leafIndex, integrity_position: String(entry.integrityPosition), integrity_path: path })) }
  const bytes = new Uint8Array(2 * 131072); bytes[0] = 7; bytes[131072] = 9
  const envelope = await parseRetrievalEnvelopeV3(responseV3(metadata, bytes), authority)
  let calls = 0
  const crypto = { commit_received_blob: () => new Uint8Array(), compute_mdu_root: () => new Uint8Array(), verify_polyfs_session_batch: () => false,
    verify_fat_v3_header: () => 0, verify_integrity_v3_blob: (_mdu: bigint, _leaf: number, _position: bigint, _count: bigint, blob: Uint8Array) => { calls++; return blob[0] === (calls === 1 ? 7 : 9) } }
  assert.deepEqual(verifyRetrievalDataV3(authority, envelope, crypto), bytes)
  assert.equal(calls, 2)
  const corrupted = { ...envelope, bytes: envelope.bytes.slice() }; corrupted.bytes[131072] ^= 1; calls = 0
  assert.throws(() => verifyRetrievalDataV3(authority, corrupted, crypto), /integrity/)
  assert.throws(() => verifyRetrievalDataV3({ ...authority, entries: [] }, { bytes: new Uint8Array(), entries: [] }, crypto), /authority/)
  assert.throws(() => verifyRetrievalDataV3(authority, {
    ...envelope,
    entries: envelope.entries.map((entry, i) => i ? entry : { ...entry, integrityPath: Array(24).fill(new Uint8Array(32)) }),
  }, crypto), /path exceeds protocol depth/)
  await assert.rejects(parseRetrievalEnvelopeV3(responseV3({ ...metadata, entries: [{ ...metadata.entries[0], t: '8' }, metadata.entries[1]] }, bytes), authority), /authority/)
  await assert.rejects(parseRetrievalEnvelopeV3(response(metadata, bytes), authority), /content type/)
})

test('v3 metadata authenticates the full MDU0 root before parsing FAT authority', () => {
  const bytes = new Uint8Array(8 * 1024 * 1024)
  let headerCalls = 0
  const crypto = { commit_received_blob: () => new Uint8Array(48), compute_mdu_root: () => new Uint8Array(32), verify_polyfs_session_batch: () => false,
    verify_fat_v3_header: () => { headerCalls++; throw new Error('untrusted FAT parsed') }, verify_integrity_v3_blob: () => false }
  const authority = { polyfsRoot: `0x${'01'.repeat(32)}` as const, integrityRoot: `0x${'02'.repeat(32)}` as const, integrityLeafCount: 96n, metadataMdus: 2n, userMdus: 1n }
  assert.throws(() => verifyRetrievalMetadataV3(bytes, authority, crypto), /generation/)
  assert.equal(headerCalls, 0)
  const max = { ...authority, userMdus: 65535n, integrityLeafCount: 65535n * 96n }
  assert.throws(() => verifyRetrievalMetadataV3(new Uint8Array(), max, crypto), /MDU0 size/)
  assert.throws(() => verifyRetrievalMetadataV3(new Uint8Array(), { ...max, userMdus: 65536n, integrityLeafCount: 65536n * 96n }, crypto), /authority/)
})
