import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { executeRetrievalV3, retrievalV3SlotEnd } from './retrievalV3Flow'
import { RETRIEVAL_V3_SETUP, type FrozenSessionV3 } from './retrievalV3'
import type { RetrievalDiagnostic } from './retrievalDiagnostics'

const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))

function session(): FrozenSessionV3 {
  const providers = Array.from({ length: 12 }, (_, i) => address(i + 2))
  const length = 65n * 126_976n
  return { authority: { chainId: 'test-1', height: 9n, dealId: 7n, generation: 2n, owner: address(1), dealEnd: 100n,
    setupDigest: RETRIEVAL_V3_SETUP, providers, totalMdus: 4n, witnessMdus: 1n, metadataMdus: 2n, userMdus: 2n,
    integrityLeafCount: 192n, polyfsRoot: `0x${'11'.repeat(32)}`, integrityRoot: `0x${'22'.repeat(32)}`, retrievalPolicyMode: 5 },
    height: 12n, sessionId: `0x${'33'.repeat(32)}`, contextHash: new Uint8Array(32), planHash: new Uint8Array(32), owner: address(1), payer: address(1),
    fileRecordIndex: 0, file: { path: 'file.bin', start_offset: 0n, size_bytes: length, flags: 0 }, rangeStart: 0n, rangeLength: length,
    first: 0n, last: 64n, population: 65n, sampleCount: 65n, nonce: 1n, priceDenom: 'stake', pricePerBlob: 1n, baseFee: 1n,
    completionBurnBps: 0, funding: 1, snapshot: 10n, anchor: 11n, firstResponse: 12n, deadline: 90n, dealEnd: 100n,
    obligations: [{ slot: 0, assigned: providers[0], payee: providers[0], blobCount: 9n, sampleCount: 9n, lockedFee: 9n }],
    acceptedBitmap: new Uint8Array(17), ackedMask: 0, settledMask: 0, refundedMask: 0, lockedFee: 9n, expired: false, context: new Uint8Array() }
}

test('v3 slot end uses the final matching systematic coordinate', () => {
  assert.equal(retrievalV3SlotEnd({ last: 8456n }, 1), 8449n)
  assert.equal(retrievalV3SlotEnd({ last: 8456n }, 0), 8456n)
})

test('v3 flow pipelines two verified chunks but durably advances in order before ACK', async () => {
  const initial = session(), events: string[] = [], cursors: Partial<Record<number, bigint>> = {}
  let active = initial, fetches = 0, observations = 0
  const result = await executeRetrievalV3(initial, { cursors, output: { async write() { events.push('write') }, async flush() { events.push('flush') } },
    advance(slot, through) { events.push(`cursor:${through}`); cursors[slot] = through }, refresh(value) { active = value } }, {
    async fetch(chunk) { fetches++; events.push(`fetch:${chunk.entries[chunk.entries.length - 1].t}`); return { metadata: {}, bytes: new Uint8Array(chunk.entries.length * 131_072) } as never },
    async verify(chunk) { events.push(`verify:${chunk.entries[chunk.entries.length - 1].t}`); return new Uint8Array(chunk.entries.length * 131_072) },
    async acknowledge(value, slot) { events.push(`ack:${slot}`); return { ...value, ackedMask: 1 } },
    async requestProof(value) { events.push('proof'); return { state: 'accepted', sessionId: value.sessionId, slot: 0, proofCount: 9, remaining: 0 } },
    async observe(value) { observations++; return value.ackedMask ? { ...value, settledMask: 1, lockedFee: 0n } : value },
  })
  assert.equal(fetches, 2)
  assert.equal(cursors[0], 64n)
  assert.ok(events.indexOf('fetch:64') < events.indexOf('cursor:56'), 'second chunk starts before the first durable cursor')
  assert.ok(events.indexOf('cursor:64') < events.indexOf('ack:0'))
  assert.equal(active.lockedFee, 0n)
  assert.equal(result.session.settledMask, 1)
  assert.equal(observations, 2, 'fresh chain state is observed after proof submission')
})

test('prefetched rejection is handled and drained without ACK or cursor beyond durable bytes', async () => {
  const initial = session(), cursors: Partial<Record<number, bigint>> = {}
  let releaseFirst!: () => void, acknowledgements = 0
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const run = executeRetrievalV3(initial, { cursors, output: { async write() {}, async flush() {} }, advance(slot, through) { cursors[slot] = through }, refresh() {} }, {
    async fetch(chunk) { if (chunk.entries[0].t === 64n) throw new Error('second chunk unavailable'); await first; return {} as never },
    async verify(chunk) { return new Uint8Array(chunk.entries.length * 131_072) },
    async acknowledge(value) { acknowledgements++; return value }, async requestProof(value) { return { state: 'unknown', sessionId: value.sessionId } }, async observe(value) { return value },
  })
  await Promise.resolve(); releaseFirst()
  await assert.rejects(run, /second chunk unavailable/)
  assert.equal(cursors[0], 56n)
  assert.equal(acknowledgements, 0)
})

test('write failure cancels and drains the prefetched request', async () => {
  const initial = session()
  let canceled = false
  const run = executeRetrievalV3(initial, { cursors: {}, output: { async write() { throw new Error('disk full') }, async flush() {} }, advance() {}, refresh() {} }, {
    async fetch(chunk, signal) {
      if (chunk.entries[0].t !== 64n) return {} as never
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { canceled = true; reject(signal.reason) }, { once: true }))
    },
    async verify(chunk) { return new Uint8Array(chunk.entries.length * 131_072) }, async acknowledge(value) { return value },
    async requestProof(value) { return { state: 'unknown', sessionId: value.sessionId } }, async observe(value) { return value },
  })
  await assert.rejects(run, /disk full/)
  assert.equal(canceled, true)
})

test('fully settled durable output reopens without fetch, ACK, or provider proof', async () => {
  const initial = { ...session(), ackedMask: 1, settledMask: 1, lockedFee: 0n }
  let calls = 0
  const result = await executeRetrievalV3(initial, { cursors: { 0: 64n }, output: { async write() {}, async flush() {} }, advance() {}, refresh() {} }, {
    async fetch() { calls++; throw new Error('must not fetch') }, async verify() { calls++; throw new Error('must not verify') },
    async acknowledge(value) { calls++; return value }, async requestProof(value) { calls++; return { state: 'unknown', sessionId: value.sessionId } },
    async observe(value) { return value },
  })
  assert.equal(calls, 0)
  assert.equal(result.session.lockedFee, 0n)
})

test('chunk progress follows verification, successful writes, flush and checkpoint; failures never claim later progress', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window') })
  for (const failure of ['none', 'verify', 'write', 'flush', 'cursor']) {
    const events: RetrievalDiagnostic[] = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __polystoreRetrievalDiagnostic: (event: RetrievalDiagnostic) => events.push(event) } })
    const initial = session()
    initial.last = 0n; initial.rangeLength = 1024n
    const step = (phase: string) => { if (failure === phase) throw new Error(phase) }
    const run = executeRetrievalV3(initial, { cursors: {}, output: { async write() { step('write') }, async flush() { step('flush') } },
      advance() { step('cursor') }, refresh() {} }, {
      async fetch() { return {} as never }, async verify() { step('verify'); return new Uint8Array(131_072) },
      async acknowledge(value) { return { ...value, ackedMask: 1, settledMask: 1, lockedFee: 0n } },
      async requestProof() { throw new Error('already settled') }, async observe(value) { return value },
    })
    if (failure === 'none') await run
    else await assert.rejects(run, new RegExp(failure))
    const progress = events.filter((e) => ['verified_write', 'flushed', 'verified_chunk', 'acked_obligation'].includes(e.phase))
    assert.deepEqual(progress.map((e) => e.phase), failure === 'none' ? ['verified_write', 'flushed', 'verified_chunk', 'acked_obligation'] :
      failure === 'cursor' ? ['verified_write', 'flushed'] : failure === 'flush' ? ['verified_write'] : [])
    assert.ok(progress.every((e) => e.sessionId === initial.sessionId && e.slot === 0))
    assert.ok(progress.filter((e) => e.phase !== 'acked_obligation').every((e) => e.chunkId === '0:0:0'))
    if (failure === 'none') {
      assert.equal(progress[0].bytes, 1024)
      assert.equal(progress[0].offset, 0)
      assert.ok(events.findIndex((e) => e.phase === 'browser_verify' && e.edge === 'end') < events.indexOf(progress[0]))
    }
  }
})
