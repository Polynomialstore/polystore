import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { encodeSessionBatch, parseRetrievalEnvelope, parseWindowProof, verifyRetrievalWindow } from './retrievalWire'
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
    assert.throws(() => parseFrozenSession({ ...query, session: { ...query.session, deal_id: 9007199254740993 } }, 12n, expected), /uint64/)
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
