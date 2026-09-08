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

test('generation-scoped witness cache survives worker transfers, reuses admission and evicts after two entries', async () => {
  const { createRecoveryCommitmentReader } = await import('./retrievalRecovery')
  const p = { ...pin, k: 1, m: 255, rows: 64, leafCount: 16384, userMdus: 40n, metadataMdus: 5n, root: `0x${'11'.repeat(32)}`, generation: 1n } as PinnedGeneration
  const mdu0 = new Uint8Array(8388608)
  for (let index = 1; index <= 4; index++) mdu0[(index - 1) * 32] = index
  const fetched: bigint[] = [], admitted: number[] = []
  const reader = {
    fetch: async (index: bigint) => { fetched.push(index); const bytes = new Uint8Array(8388608); bytes[0] = Number(index); return bytes },
    verifyWitness: async (bytes: Uint8Array, cell: Uint8Array) => { assert.equal(bytes[0], cell[0], 'wrong generation root'); admitted.push(bytes[0]); return bytes },
    readCommitments: async (_pin: PinnedGeneration, _ordinal: bigint, witness: { index: bigint; bytes: Uint8Array }[]) => {
      // Real worker-client transfers these buffers; cached admission must keep
      // its own bytes and not become an empty detached buffer after first use.
      for (const entry of witness) { assert.equal(entry.bytes[0], Number(entry.index)); structuredClone(entry.bytes, { transfer: [entry.bytes.buffer] }); assert.equal(entry.bytes.length, 0) }
      return new Uint8Array(48)
    },
  }
  const read = createRecoveryCommitmentReader(p, mdu0, reader)
  // Altering the caller's buffer cannot replace the roots pinned by this reader.
  mdu0[0] = 42
  for (const ordinal of [0n, 1n, 11n, 22n, 0n]) await read(ordinal)
  assert.deepEqual(fetched, [1n, 2n, 3n, 1n]); assert.deepEqual(admitted, [1, 2, 3, 1])
  const changed = createRecoveryCommitmentReader({ ...p, generation: 2n, root: `0x${'22'.repeat(32)}` }, mdu0, reader)
  await assert.rejects(changed(0n), /wrong generation root/)
  assert.equal(fetched.length, 5, 'another generation cannot reuse old authenticated bytes')
})
