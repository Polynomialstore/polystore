import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { fetchActiveGenerationV3, fetchLatestNonceV3, fetchSessionIDByNonceV3, parseFrozenSessionV3, planV3Chunks, preserveV3BrowserTransactionKey, RETRIEVAL_V3_SETUP, sameFrozenRetrievalRequestV3, type FrozenGenerationV3, type FrozenSessionV3 } from './retrievalV3'

const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))
const b64 = (n: number, length = 32) => Buffer.alloc(length, n).toString('base64')
const providers = Array.from({ length: 12 }, (_, i) => address(i + 2))

function authority(): FrozenGenerationV3 {
  return { chainId: 'test-1', height: 9n, dealId: 7n, generation: 2n, owner: address(1), dealEnd: 100n,
    setupDigest: RETRIEVAL_V3_SETUP, providers, totalMdus: 3n, witnessMdus: 1n, metadataMdus: 2n, userMdus: 1n,
    integrityLeafCount: 96n, polyfsRoot: `0x${'11'.repeat(32)}`, integrityRoot: `0x${'22'.repeat(32)}`, retrievalPolicyMode: 5 }
}

test('active v3 generation accepts production decimal int64 JSON and exact admitted authority', async () => {
  const height = 9_007_199_254_740_994n
  const a = authority()
  const admitted = { admitted: { deal_id: '7', generation: '2', owner: a.owner, chain_id: a.chainId,
    polyfs_root: b64(0x11), integrity_root: b64(0x22), setup_digest: Buffer.from(RETRIEVAL_V3_SETUP.slice(2), 'hex').toString('base64'),
    total_mdus: '3', witness_mdus: '1', metadata_mdus: '2', user_mdus: '1', integrity_leaf_count: '96', size: '1024',
    accepted_slots_mask: 4095, proposed_height: '9007199254740993', providers } }
  const deal = { deal: { id: '7', current_gen: '2', owner: a.owner, manifest_root: b64(0x11), total_mdus: '3', witness_mdus: '1',
    end_block: '9007199254741999', redundancy_mode: 2, mode2_profile: { k: 8, m: 4 }, retrieval_policy: { mode: 'RETRIEVAL_POLICY_MODE_PUBLIC' },
    mode2_slots: providers.map((provider, slot) => ({ slot, provider, status: 'SLOT_STATUS_ACTIVE' })) } }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const requested = new Headers(init?.headers).get('x-cosmos-block-height')
    if (url.endsWith('/generation-v3')) return Response.json(admitted, { headers: { 'x-cosmos-block-height': height.toString() } })
    assert.equal(requested, height.toString())
    if (url.endsWith('/params')) return Response.json({ params: { retrieval_v3_activation_height: '1' } }, { headers: { 'x-cosmos-block-height': height.toString() } })
    return Response.json(deal, { headers: { 'x-cosmos-block-height': height.toString() } })
  }) as typeof fetch
  const result = await fetchActiveGenerationV3('https://lcd.example', 'test-1', '7', undefined, fetchFn)
  assert.equal(result?.height, height)
  assert.equal(result?.integrityRoot, a.integrityRoot)
  assert.equal(result?.retrievalPolicyMode, 5)
})

test('v3 nonce lookups preserve uint64 values and distinguish absence', async () => {
  const owner = address(1), id = b64(0x44)
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(url)
    if (url.endsWith('/nonce')) return Response.json({ found: true, nonce: '18446744073709551615' }, { headers: { 'x-cosmos-block-height': '21' } })
    return Response.json({ session_id: id }, { headers: { 'x-cosmos-block-height': '21' } })
  }) as typeof fetch
  assert.deepEqual(await fetchLatestNonceV3('https://lcd.example', owner, 7n, undefined, fetchFn), { found: true, nonce: (1n << 64n) - 1n, height: 21n })
  assert.equal(await fetchSessionIDByNonceV3('https://lcd.example', owner, 7n, 9n, undefined, fetchFn), `0x${'44'.repeat(32)}`)
  assert.match(calls[0], /by-owner\/nil1.*\/deals\/7\/nonce$/)
  const missing = (async () => new Response('', { status: 404, headers: { 'x-cosmos-block-height': '21' } })) as typeof fetch
  assert.equal(await fetchSessionIDByNonceV3('https://lcd.example', owner, 7n, 9n, undefined, missing), null)
})

function rawSession() {
  const a = authority(), file = { path: 'file.bin', start_offset: 0n, size_bytes: 1024n, flags: 0 }
  return { a, file, response: { anchor_seed: null, session: {
    session_id: b64(0x33), context_hash: b64(0x44), plan_hash: b64(0x55), deal_id: '7', generation: '2', owner: a.owner, payer: a.owner,
    polyfs_root: b64(0x11), integrity_root: b64(0x22), setup_digest: Buffer.from(RETRIEVAL_V3_SETUP.slice(2), 'hex').toString('base64'),
    file_record_index: 3, file_start_offset: '0', file_length: '1024', range_start: '0', range_length: '1024', metadata_mdus: '2', user_mdus: '1',
    first_blob: '0', last_blob: '0', population: '1', sample_count: '1', nonce: '4', price_denom: 'stake', price_per_blob: '2', base_fee: '3',
    completion_burn_bps: 2500, funding: 'RETRIEVAL_SESSION_FUNDING_REQUESTER', snapshot_height: '10', anchor_height: '11', first_response_height: '12',
    deadline_height: '90', deal_end_height: '100', opened_height: '10', updated_height: '10', accepted_sample_bitmap: b64(0, 17), acked_slots_mask: 0,
    settled_slots_mask: 0, refunded_slots_mask: 0, locked_fee: '2', chain_id: 'test-1', expired: false,
    obligations: [{ slot: 0, assigned_provider: providers[0], payee: providers[0], blob_count: '1', sample_count: '0', locked_fee: '2' }] } } }
}

test('pre-anchor v3 session accepts null seed and unmaterialized zero sample partition', async () => {
  const { a, file, response } = rawSession()
  const expected = { sessionId: `0x${'33'.repeat(32)}` as const, owner: a.owner, recordIndex: 3, file, rangeStart: 0n, rangeLength: 1024n, nonce: 4n,
    planHash: Buffer.alloc(32, 0x55), range: async () => { const out = new Uint8Array(24), view = new DataView(out.buffer); view.setBigUint64(0, 0n); view.setBigUint64(8, 0n); view.setBigUint64(16, 1n); return out },
    contextHash: async () => Buffer.alloc(32, 0x44), seed: async () => { throw new Error('seed must not run') }, challenges: async () => { throw new Error('challenges must not run') } }
  const parsed = await parseFrozenSessionV3(response, 10n, a, expected)
  assert.equal(parsed.anchorSeed, undefined)
  assert.equal(parsed.obligations[0].sampleCount, 0n)
  const altered = structuredClone(response); altered.session.last_blob = '1'
  await assert.rejects(parseFrozenSessionV3(altered, 10n, a, expected), /noncanonical v3 range/)
})

test('v3 session rejects state without materialized samples and bits outside the sample partition', async () => {
  const { a, file, response } = rawSession()
  const expected = { sessionId: `0x${'33'.repeat(32)}` as const, owner: a.owner, recordIndex: 3, file, rangeStart: 0n, rangeLength: 1024n, nonce: 4n,
    planHash: Buffer.alloc(32, 0x55), range: async () => { const out = new Uint8Array(24), view = new DataView(out.buffer); view.setBigUint64(0, 0n); view.setBigUint64(8, 0n); view.setBigUint64(16, 1n); return out },
    contextHash: async () => Buffer.alloc(32, 0x44), seed: async () => { throw new Error('seed must not run') }, challenges: async () => { throw new Error('challenges must not run') } }
  const unmaterialized = structuredClone(response)
  unmaterialized.session.accepted_sample_bitmap = Buffer.concat([Buffer.from([1]), Buffer.alloc(16)]).toString('base64')
  await assert.rejects(parseFrozenSessionV3(unmaterialized, 10n, a, expected), /noncanonical v3 plan/)
  const outside = structuredClone(response)
  outside.session.obligations[0].sample_count = '1'
  outside.session.accepted_sample_bitmap = Buffer.concat([Buffer.from([2]), Buffer.alloc(16)]).toString('base64')
  await assert.rejects(parseFrozenSessionV3(outside, 10n, a, expected), /noncanonical v3 plan/)
})

test('v3 refresh pins context economics while allowing an unmaterialized direct refund', async () => {
  const { a, file, response } = rawSession()
  const expected = { sessionId: `0x${'33'.repeat(32)}` as const, owner: a.owner, recordIndex: 3, file, rangeStart: 0n, rangeLength: 1024n, nonce: 4n,
    planHash: Buffer.alloc(32, 0x55), frozenContextHash: Buffer.alloc(32, 0x44), deadline: 90n, funding: 2 as const,
    range: async () => { const out = new Uint8Array(24), view = new DataView(out.buffer); view.setBigUint64(0, 0n); view.setBigUint64(8, 0n); view.setBigUint64(16, 1n); return out },
    contextHash: async () => Buffer.alloc(32, 0x44), seed: async () => { throw new Error('seed must not run') }, challenges: async () => { throw new Error('challenges must not run') } }
  const refunded = structuredClone(response)
  refunded.session.refunded_slots_mask = 1
  refunded.session.locked_fee = '0'
  refunded.session.expired = true
  assert.equal((await parseFrozenSessionV3(refunded, 100n, a, expected)).refundedMask, 1)
  const altered = structuredClone(response)
  altered.session.price_per_blob = '4'
  altered.session.obligations[0].locked_fee = '4'
  altered.session.locked_fee = '4'
  altered.session.context_hash = b64(0x45)
  await assert.rejects(parseFrozenSessionV3(altered, 10n, a, { ...expected, contextHash: async () => Buffer.alloc(32, 0x45) }), /context/)
})

test('v3 recovery ignores observation height but retains exact request and transaction key', () => {
  const a = authority(), file = { path: 'one.bin', start_offset: 2n, size_bytes: 9n, flags: 0 }
  const request = { authority: a, recordIndex: 3, file, rangeStart: 1n, rangeLength: 4n }
  assert.equal(sameFrozenRetrievalRequestV3(request, { ...request, authority: { ...a, height: 99n } }), true)
  assert.equal(sameFrozenRetrievalRequestV3(request, { ...request, file: { ...file, path: 'two.bin' } }), false)
  const initial = { browserTransactionKey: 'open-v3:owner-deal' } as FrozenSessionV3
  assert.equal(preserveV3BrowserTransactionKey(initial, {} as FrozenSessionV3).browserTransactionKey, 'open-v3:owner-deal')
})

test('v3 chunk plan remains bounded and covers asymmetric systematic slots exactly', () => {
  const a = authority(), session = { authority: { ...a, metadataMdus: 2n, userMdus: 134n }, sessionId: `0x${'33'.repeat(32)}` as const,
    contextHash: new Uint8Array(32), first: 0n, last: 8456n }
  let count = 0, entries = 0
  for (const chunk of planV3Chunks(session)) { count++; entries += chunk.entries.length; assert.ok(chunk.entries.length <= 8) }
  assert.equal(count, 1064)
  assert.equal(entries, 8457)
  const slot1 = Array.from(planV3Chunks(session, 1)).flatMap((chunk) => chunk.entries.map((entry) => entry.t))
  assert.equal(slot1[slot1.length - 1], 8449n)
})
