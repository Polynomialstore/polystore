import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { planRetrievalWindows, parsePinnedGeneration, u64, type PinnedGeneration } from './retrieval'

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
  for (const mutation of [ { id: 9007199254740993 }, { total_mdus: '65538' }, { manifest_root: 'bad' }, { mode2_profile: { k: 3, m: 1 } } ]) {
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
