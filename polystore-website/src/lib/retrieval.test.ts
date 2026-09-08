import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { bech32 } from 'bech32'
import { parseFrozenSession, planRetrievalWindows, parsePinnedGeneration, u64, type PinnedGeneration } from './retrieval'
import { waitForRetrievalChallenge } from './retrievalFlow'

const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))
const deal = () => ({ id: '9007199254740993', manifest_root: btoa('\x01'.repeat(32)), owner: address(1),
  current_gen: '2', total_mdus: '135', witness_mdus: '1', end_block: '10000', redundancy_mode: 2,
  mode2_profile: { k: 8, m: 4 }, mode2_slots: Array.from({ length: 12 }, (_, slot) => ({ slot, provider: address(slot + 2), status: 'SLOT_STATUS_ACTIVE' })) })
const pin = (): PinnedGeneration => parsePinnedGeneration({ deal: deal() }, 'test-1', 10n, 9007199254740993n)

test('secured planner preserves exact 1KiB and 1GiB coverage with bounded per-MDU slots', () => {
  const generation = pin()
  const collect = (start: bigint, size: bigint) => Array.from(planRetrievalWindows(generation, { start_offset: start, size_bytes: size, flags: 0, path: 'file' }, 0n, size))
  const small = collect(0n, 1024n)
  assert.equal(small.length, 1)
  assert.equal(small[0].blobCount, 1)
  assert.equal(small[0].slices[0].length, 1024)
  assert.equal(collect(126976n - 512n, 1024n).length, 2)
  const windows = collect(0n, 1n << 30n)
  assert.equal(windows.length, 1064)
  assert.equal(windows.reduce((sum, w) => sum + w.blobCount, 0), 8457)
  assert.equal(new Set(windows.map((w) => w.mduIndex)).size, 133)
  const slices = windows.flatMap((w) => w.slices).sort((a, b) => a.outputOffset < b.outputOffset ? -1 : 1)
  let offset = 0n
  for (const slice of slices) { assert.equal(slice.outputOffset, offset); offset += BigInt(slice.length) }
  assert.equal(offset, 1n << 30n)
  for (const w of windows) {
    assert.ok(w.startBlobIndex >= w.slot * 8)
    assert.ok(w.startBlobIndex + w.blobCount <= (w.slot + 1) * 8)
    assert.equal(w.slices.length, w.blobCount)
  }
})

test('authority and planner reject malformed, lossy, unavailable and transformed input before funding', () => {
  assert.equal(u64('9007199254740993'), 9007199254740993n)
  for (const invalid of [1, '01', '-1', '1.1', '18446744073709551616', null]) assert.throws(() => u64(invalid))
  for (const mutation of [ { id: Number('9007199254740993') }, { total_mdus: '65538' }, { manifest_root: 'bad' }, { mode2_profile: { k: 3, m: 1 } } ]) {
    assert.throws(() => parsePinnedGeneration({ deal: { ...deal(), ...mutation } }, 'test-1', 10n, 9007199254740993n))
  }
  const generation = pin()
  for (const flags of [1, 2, 4, 128]) assert.throws(() => [...planRetrievalWindows(generation, { start_offset: 0n, size_bytes: 10n, flags, path: 'file' }, 0n, 10n)])
  assert.throws(() => [...planRetrievalWindows(generation, { start_offset: 0n, size_bytes: 10n, flags: 0, path: 'file' }, 9n, 2n)])
})

test('trusted LCD query requires exact committed height and bounds/cancels response streams', async () => {
  const { fetchPinnedGeneration, readBoundedResponse } = await import('./retrieval')
  for (const height of [null, '0', '01', '-1', '18446744073709551616']) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const response = new Response(body, { headers: height === null ? {} : { 'x-cosmos-block-height': height } })
    await assert.rejects(fetchPinnedGeneration('https://trusted.example', 'test-1', '9007199254740993', undefined, (async () => response) as typeof fetch), /height/)
    assert.equal(cancelled, true)
  }
  const fetchFn = (async (url: string) => { assert.equal(url, 'https://trusted.example/polystorechain/polystorechain/v1/deals/9007199254740993'); return Response.json({ deal: deal() }, { headers: { 'x-cosmos-block-height': '10' } }) }) as typeof fetch
  assert.equal((await fetchPinnedGeneration('https://trusted.example/', 'test-1', '9007199254740993', undefined, fetchFn)).dealId, 9007199254740993n)
  let cancelled = false
  const oversized = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)) }, cancel() { cancelled = true } }))
  await assert.rejects(readBoundedResponse(oversized, 3), /limit/); assert.equal(cancelled, true)
  cancelled = false
  const controller = new AbortController()
  const pending = readBoundedResponse(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })), 3, controller.signal)
  controller.abort(new Error('cancelled retrieval'))
  await assert.rejects(pending, /cancelled retrieval/); assert.equal(cancelled, true)
})

test('paid retrieval gates activation at the same committed height as its generation', async () => {
  const { fetchActiveRetrievalGeneration, fetchRetrievalAvailability } = await import('./retrieval')
  for (const activation of [undefined, '0', '11', '10', '1', '01', null, 1, '18446744073709551616']) {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const params = url.endsWith('/params')
      if (params) assert.equal(new Headers(init?.headers).get('x-cosmos-block-height'), '10')
      return Response.json(params ? { params: { retrieval_v2_activation_height: activation } } : { deal: deal() }, { headers: { 'x-cosmos-block-height': '10' } })
    }) as typeof fetch
    const result = fetchActiveRetrievalGeneration('https://trusted.example', 'test-1', '9007199254740993', undefined, fetchFn)
    if (activation === '10' || activation === '1') assert.equal((await result).height, 10n)
    else await assert.rejects(result, activation === '11' ? /block 11/ : activation === undefined || activation === '0' ? /until this network activates/ : /uint64/)
  }
  for (const actual of [null, '0', '9', '11']) {
    const fetchFn = (async () => Response.json({ params: { retrieval_v2_activation_height: '1' } }, { headers: actual ? { 'x-cosmos-block-height': actual } : {} })) as typeof fetch
    await assert.rejects(fetchRetrievalAvailability('https://trusted.example', 10n, undefined, fetchFn), /height/)
  }
})

test('session LCD query uses exact protobuf bytes and waits from null seed to committed challenge', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../testdata/retrieval-window-v2/session.json', import.meta.url), 'utf8'))
  const generation: PinnedGeneration = { chainId: 'test-1', height: 9n, dealId: 9007199254740993n, generation: 7n,
    root: `0x${Buffer.from(fixture.session.manifest_root, 'base64').toString('hex')}`, owner: fixture.session.owner,
    endHeight: 100n, layout: 2, k: 8, m: 4, rows: 8, leafCount: 96, metadataMdus: 2n, userMdus: 1n, totalMdus: 3n, assignments: [] }
  const window = { mduIndex: 2n, slot: 1, provider: fixture.session.provider, startBlobIndex: 8, blobCount: 2, slices: [] }
  for (const id of [Buffer.alloc(32, 1), Buffer.from('fbff'.repeat(16), 'hex')]) {
    const response = structuredClone(fixture)
    // The fixture's one-byte session domain precedes its 32 bytes of 0x01.
    const context = Buffer.from(response.challenge_context, 'base64'), at = context.indexOf(Buffer.alloc(33, 1)) + 1
    assert.ok(at > 0)
    id.copy(context, at)
    response.session.session_id = id.toString('base64')
    response.challenge_context = context.toString('base64')
    response.challenge_context_hash = createHash('sha256').update(context).digest('base64')
    let received: Buffer | undefined, queries = 0
    const server = createServer((request, result) => {
      const path = new URL(request.url!, 'http://localhost').pathname
      const prefix = '/polystorechain/polystorechain/v1/retrieval-sessions/'
      const segment = decodeURIComponent(path.slice(prefix.length))
      if (!path.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}=$/.test(segment)) { result.writeHead(400); result.end(); return }
      received = Buffer.from(segment, 'base64url')
      if (received.length !== 32 || !received.equals(id)) { result.writeHead(400); result.end(); return }
      queries++
      result.writeHead(200, { 'content-type': 'application/json', 'x-cosmos-block-height': queries === 1 ? '10' : '12' })
      result.end(JSON.stringify({ ...response, challenge_seed: queries === 1 ? null : response.challenge_seed }))
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address(); assert.ok(address && typeof address !== 'string')
      const sessionId = `0x${id.toString('hex')}`
      const expected = { sessionId, pin: generation, window, owner: fixture.session.owner, payee: fixture.session.authorized_proof_provider, funding: 1 as const }
      for (const seed of [undefined, '', null]) assert.equal(parseFrozenSession({ ...response, challenge_seed: seed }, 10n, expected).seed, null)
      for (const seed of [false, 0, 'bad', Buffer.alloc(31).toString('base64')]) assert.throws(() => parseFrozenSession({ ...response, challenge_seed: seed }, 12n, expected), /base64/)
      const session = await waitForRetrievalChallenge(`http://127.0.0.1:${address.port}`, expected, AbortSignal.timeout(5000))
      assert.equal(session.sessionId, sessionId); assert.deepEqual(received, id)
      assert.equal(queries, 2); assert.equal(session.height, 12n)
      assert.deepEqual(session.seed, new Uint8Array(Buffer.from(response.challenge_seed, 'base64')))
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  }
  assert.match(Buffer.from('fbff'.repeat(16), 'hex').toString('base64'), /\+/)
  assert.match(Buffer.from('fbff'.repeat(16), 'hex').toString('base64'), /\//)
})
