import test from 'node:test'
import assert from 'node:assert/strict'
import { openRetrievalCheckpoint, retrievalCheckpointCursor, type RetrievalCheckpointState } from './retrievalCheckpoint'
import { settleBrowserTransaction, type RetrievalStore } from './retrievalTransactions'
import type { FrozenSession } from './retrieval'
const hash = `0x${'ab'.repeat(32)}` as const
const sessions = [{ sessionId: hash, pin: { dealId: 1n }, window: { mduIndex: 2n } }] as FrozenSession[]
function store(): RetrievalStore {
  const values = new Map<string, unknown>()
  return { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key, value) => { values.set(key, structuredClone(value)) }, remove: (key) => { values.delete(key) } }
}

test('a verified, flushed output survives uncertain ACK and retry resumes the same sessions without funding or rewriting', async () => {
  const storage = store(), initial = { id: 'existing-opfs-output', length: 8388608n, through: -1n }
  let cursor = retrievalCheckpointCursor(storage, 'file', initial)
  let writes = 0, sends = 0, receiptAvailable = false
  const output = new Uint8Array(4)
  // This is the production order: verification, write, flush, checkpoint, ACK.
  output.set([3, 1, 4, 2]); writes++
  cursor.prepare(0n, sessions)
  const transaction = { store: storage, key: 'ack', prepare: async () => ({ data: '0x1234' as const, intent: [hash] }),
    send: async () => { sends++; assert.deepEqual(storage.get<RetrievalCheckpointState>('file')?.pending?.sessions, sessions); return hash },
    receipt: async () => { if (!receiptAvailable) throw new Error('timeout'); return { status: 'success', transactionHash: hash, blockNumber: 9n } }, reconcile: async () => false,
  }
  await assert.rejects(settleBrowserTransaction(transaction), /outcome is unresolved/)
  // Reload the durable cursor and transaction. No new fetch, nonce, or write.
  cursor = retrievalCheckpointCursor(storage, 'file', storage.get<RetrievalCheckpointState>('file')!)
  assert.deepEqual(cursor.state.pending?.sessions, sessions)
  assert.equal(cursor.state.id, initial.id); assert.equal(cursor.state.through, -1n)
  receiptAvailable = true
  await settleBrowserTransaction(transaction)
  cursor.complete(0n, [{ sessionId: hash, state: 'committed' }])
  assert.equal(cursor.state.through, 0n); assert.equal(cursor.state.pending, undefined)
  assert.equal(sends, 1); assert.equal(writes, 1)
  assert.deepEqual(output, new Uint8Array([3, 1, 4, 2]))
})

test('checkpoint failure cannot acknowledge bytes or advance committed progress', () => {
  const storage = store(), initial = { id: 'opfs', length: 10n, through: -1n }
  const cursor = retrievalCheckpointCursor({ ...storage, put: () => { throw new Error('storage full') } }, 'file', initial)
  assert.throws(() => cursor.prepare(0n, sessions), /storage full/)
  assert.equal(cursor.state.pending, undefined)
  assert.throws(() => cursor.complete(0n, []), /missing verified/)
  assert.equal(cursor.state.through, -1n)
})

test('completed MDUs and unsettled provider status remain visible after cancellation and reload', () => {
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'opfs', length: 16n << 20n, through: -1n })
  cursor.prepare(0n, sessions)
  cursor.complete(0n, [{ sessionId: hash, state: 'pending', message: 'provider retained proof' }])
  const restored = retrievalCheckpointCursor(storage, 'file', storage.get<RetrievalCheckpointState>('file')!)
  assert.equal(restored.state.through, 0n); assert.equal(restored.state.confirmed, 1)
  assert.equal(restored.state.unsettled, 1); assert.equal(restored.state.firstSettlementIssue?.message, 'provider retained proof')
  assert.throws(() => restored.prepare(0n, sessions), /cleanup is pending/)
  restored.cleaned()
  assert.throws(() => restored.prepare(0n, sessions), /invalid verified/)
  restored.prepare(1n, sessions)
  assert.throws(() => restored.prepare(2n, sessions), /unreconciled/)
  assert.equal(restored.state.through, 0n)
})

test('a lost proof POST preserves the pending wave; retry repeats only the same provider request', async () => {
  const { confirmAndRequestRetrievalProofs } = await import('./retrievalSettlement')
  const { bech32 } = await import('bech32')
  const s = { ...sessions[0], owner: bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(1))),
    payee: bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(2))), window: { ...sessions[0].window, blobCount: 1 } } as FrozenSession
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'opfs', length: 4n, through: -1n })
  let sends = 0, posts = 0
  cursor.prepare(0n, [s])
  const confirm = async () => { await settleBrowserTransaction({ store: storage, key: 'ack',
    prepare: async () => ({ data: '0x1234', intent: [hash] }), send: async () => { sends++; return hash },
    receipt: async () => ({ status: 'success', transactionHash: hash, blockNumber: 9n }), reconcile: async () => false,
  }) }
  const options = { gatewayBase: 'http://localhost:8080', confirm,
    fetchFn: async (_: unknown, init?: RequestInit) => {
      posts++; assert.equal(JSON.parse(String(init?.body)).session_id, hash)
      if (posts === 1) throw new Error('response lost after broadcast')
      return new Response(JSON.stringify({ status: 'reconciled', session_id: hash, proof_count: 1, tx_hash: '', cleanup_status: 'complete' }), { headers: { 'content-type': 'application/json' } })
    },
  }
  const unknown = await confirmAndRequestRetrievalProofs([s], options)
  assert.equal(unknown[0].responseUnknown, true)
  assert.equal(cursor.state.through, -1n)
  const restored = retrievalCheckpointCursor(storage, 'file', storage.get<RetrievalCheckpointState>('file')!)
  const outcomes = await confirmAndRequestRetrievalProofs(restored.state.pending!.sessions, options)
  assert.equal(outcomes[0].state, 'committed'); assert.equal(outcomes[0].responseUnknown, undefined)
  restored.complete(0n, outcomes)
  assert.equal(sends, 1); assert.equal(posts, 2); assert.equal(restored.state.through, 0n)
})


test('denied control storage releases the browser lock before any output or wallet work', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let held = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    async request(_name: string, _options: unknown, run: (lock: object) => Promise<void>) {
      assert.equal(held, false); held = true
      try { await run({}) } finally { held = false }
    },
  } } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage access denied') } })
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(openRetrievalCheckpoint(['chain', 'wallet', 'file'], 4n), /storage access denied/)
      await Promise.resolve()
      assert.equal(held, false)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator')
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})


test('a failed committed-journal removal retains bounded cleanup until retry, before another MDU or handoff', () => {
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'opfs', length: 16n, through: -1n })
  storage.put('open', { committed: true })
  cursor.prepare(0n, sessions)
  cursor.complete(0n, [{ sessionId: hash, state: 'committed' }])
  const failingStore: RetrievalStore = { ...storage, remove: () => { throw new Error('remove denied') } }
  assert.throws(() => failingStore.remove('open'), /remove denied/)
  const restored = retrievalCheckpointCursor(storage, 'file', storage.get<RetrievalCheckpointState>('file')!)
  assert.deepEqual(restored.state.cleanup, sessions)
  assert.equal(restored.state.through, 0n)
  assert.throws(() => restored.prepare(1n, sessions), /cleanup is pending/)
  storage.remove('open')
  const failingCursor = retrievalCheckpointCursor({ ...storage, put: () => { throw new Error('save denied') } }, 'file', restored.state)
  assert.throws(() => failingCursor.cleaned(), /save denied/)
  assert.deepEqual(failingCursor.state.cleanup, sessions)
  // Idempotent removal and only then durable cursor cleanup on the next retry.
  storage.remove('open'); restored.cleaned()
  assert.equal(restored.state.cleanup, undefined)
  assert.equal(storage.get('open'), undefined)
  restored.prepare(1n, sessions)
})
