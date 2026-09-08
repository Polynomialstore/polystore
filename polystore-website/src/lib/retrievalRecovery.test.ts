import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverRetrievalMdu, recoveryWindows, witnessSpan, readUserCommitments, type RecoveryFlow } from './retrievalRecovery'
import { type FrozenSession, type PinnedGeneration } from './retrieval'
import type { RetrievalCrypto } from './retrievalWire'

const pin = { layout: 2, k: 2, m: 1, rows: 32, leafCount: 96, metadataMdus: 2n, userMdus: 1n,
  assignments: Array.from({ length: 3 }, (_, i) => ({ provider: `assigned${i}`, active: true })) } as unknown as PinnedGeneration
function harness(failure?: string) {
  const events: string[] = [], controller = new AbortController()
  let id = 0
  const flow: RecoveryFlow = {
    open: async (windows) => { events.push(`open:${windows.map((w) => w.slot)}`); return windows.map((window) => ({ window, sessionId: String(++id), payee: 'explicit-deputy' }) as unknown as FrozenSession) },
    fetchAndVerify: async (s) => { events.push(`proof:${s.sessionId}`); if (s.window.slot === 0) throw new Error('data slot unavailable'); return new Uint8Array(4194304) },
    reconstructAndVerify: async (shards) => {
      events.push('reconstruct'); assert.equal(shards[0], null); assert.equal(shards.filter(Boolean).length, 2)
      if (failure === 'commitment') throw new Error('inconsistent publisher data commitment')
      return new Uint8Array(8388608)
    },
    consumeAndFlush: async () => { events.push('persist'); if (failure === 'persist') throw new Error('disk full'); if (failure === 'cancel') controller.abort() },
    confirm: async (sessions) => { events.push(`ack:${sessions.map((s) => s.sessionId)}`); assert.ok(sessions.every((s) => s.payee === 'explicit-deputy')) },
  }
  return { flow, events, controller }
}
test('missing data uses a new funded parity session and acknowledges only verified persisted K inputs', async () => {
  const h = harness()
  await recoverRetrievalMdu(pin, 0n, h.flow)
  assert.deepEqual(h.events, ['open:0,1', 'proof:1', 'proof:2', 'open:2', 'proof:3', 'reconstruct', 'persist', 'ack:2,3'])
  for (const failure of ['commitment', 'persist', 'cancel']) {
    const h = harness(failure)
    await assert.rejects(recoverRetrievalMdu(pin, 0n, h.flow, h.controller.signal))
    assert.ok(!h.events.some((e) => e.startsWith('ack:')))
  }
  const h2 = harness(); h2.flow.open = async () => { throw new Error('submitted transaction status uncertain') }
  await assert.rejects(recoverRetrievalMdu(pin, 0n, h2.flow), /uncertain/)
  assert.deepEqual(h2.events, [])
})
test('recovery preflight rejects insufficient assignments, frozen witness extent and wrong session order', async () => {
  assert.throws(() => recoveryWindows({ ...pin, assignments: pin.assignments.map((a, i) => ({ ...a, active: i === 0 })) }, 0n), /before payment/)
  assert.throws(() => witnessSpan({ ...pin, metadataMdus: 1n }, 0n), /witness extent/)
  assert.throws(() => witnessSpan(pin, 1n), /geometry/)
  const h = harness(); h.flow.open = async (w) => w.slice().reverse().map((window) => ({ window }) as FrozenSession)
  await assert.rejects(recoverRetrievalMdu(pin, 0n, h.flow), /order/)
})

const rawMdu = 8126464
function pack(raw: Uint8Array) {
  const encoded = new Uint8Array(8388608)
  for (let i = 0; i < raw.length; i += 31) { const chunk = raw.subarray(i, i + 31); encoded.set(chunk, Math.floor(i / 31) * 32 + 32 - chunk.length) }
  return encoded
}
test('witness list extraction crosses scalars and MDUs using total extent, including right-aligned final payload', () => {
  // 16384 commitments occupy 786432 bytes per user; user 10 straddles W0/W1.
  const p = { ...pin, leafCount: 16384, userMdus: 11n, metadataMdus: 3n }
  const span = witnessSpan(p, 10n)
  assert.deepEqual(span.indices, [1n, 2n])
  const raw = Uint8Array.from({ length: Number(span.total) }, (_, i) => (i * 13 + 19) % 251)
  const witness = [{ index: 1n, bytes: pack(raw.subarray(0, rawMdu)) }, { index: 2n, bytes: pack(raw.subarray(rawMdu)) }]
  const expected = raw.subarray(Number(span.start), Number(span.end))
  const crypto = { compute_mdu_root: (bytes: Uint8Array) => { assert.deepEqual(bytes, expected); return new Uint8Array(32) } } as unknown as RetrievalCrypto
  assert.deepEqual(readUserCommitments(p, 10n, witness, new Uint8Array(32), crypto), expected)
  witness[1].bytes[0] = 1
  assert.throws(() => readUserCommitments(p, 10n, witness, new Uint8Array(32), crypto), /prefix/)
})
