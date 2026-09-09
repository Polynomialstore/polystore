import test from 'node:test'
import assert from 'node:assert/strict'
import { openRetrievalCheckpoint, retrievalCheckpointCursor, type RetrievalCheckpointState } from './retrievalCheckpoint'
import { settleBrowserTransaction, type RetrievalStore } from './retrievalTransactions'
import { bech32 } from 'bech32'
import type { FrozenSession } from './retrieval'
const hash = `0x${'ab'.repeat(32)}` as const
const sessions = [{ sessionId: hash, payee: bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(2))), browserTransactionKey: `open:${'ab'.repeat(32)}`, pin: { dealId: 1n }, window: { mduIndex: 2n, blobCount: 1 } }] as FrozenSession[]
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
  assert.equal(restored.state.cleanup, undefined, 'pending settlement retains transaction journals')
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
  const options = { resolveProviderBase: async () => 'https://provider.example', confirm,
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

test('committed provider cleanup remains checkpointed until reconciliation completes', async () => {
  const { confirmAndRequestRetrievalProofs } = await import('./retrievalSettlement')
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'opfs', length: 4n, through: -1n })
  cursor.prepare(0n, sessions)
  let posts = 0, forgotten = 0
  const settle = () => confirmAndRequestRetrievalProofs(sessions, {
    confirm: async () => {}, resolveProviderBase: async () => 'https://provider.example',
    fetchFn: async () => {
      posts++
      return new Response(JSON.stringify({ status: 'reconciled', session_id: hash, proof_count: 1, tx_hash: '',
        cleanup_status: posts === 1 ? 'pending' : 'complete' }), { headers: { 'content-type': 'application/json' } })
    },
  })
  cursor.complete(0n, await settle())
  assert.equal(cursor.state.unsettled, 1); assert.ok(storage.get('file:settlement:0'))
  await cursor.reconcile(settle, async () => { forgotten++ })
  assert.equal(posts, 2); assert.equal(forgotten, 1); assert.equal(cursor.state.unsettled, 0)
  assert.equal(storage.get('file:settlement:0'), undefined)
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

test('gateway-free completed bytes retain their original payment wave instead of scheduling journal deletion', () => {
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'opfs', length: 16n, through: -1n })
  cursor.prepare(0n, sessions)
  cursor.complete(0n, [{ sessionId: hash, state: 'unavailable' }])
  assert.equal(cursor.state.through, 0n)
  assert.equal(cursor.state.cleanup, undefined, 'unsettled open and ACK journals must not be forgotten')
  assert.deepEqual(storage.get<{ sessions: FrozenSession[] }>('file:settlement:0')?.sessions.map((s) => s.sessionId), sessions.map((s) => s.sessionId))
})


test('two gateway-free MDUs survive reload and settle the same IDs without another open, fetch, or ACK', async () => {
  const { confirmAndRequestRetrievalProofs } = await import('./retrievalSettlement')
  const { bech32 } = await import('bech32')
  const owner = bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(1)))
  const payee = bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(2)))
  const waves = [0, 1].map((mdu) => Array.from({ length: 8 }, (_, i) => ({ ...sessions[0], owner, payee,
    sessionId: `0x${(mdu * 8 + i + 1).toString(16).padStart(64, '0')}`,
    window: { mduIndex: BigInt(mdu + 2), blobCount: 8 }, browserTransactionKey: `open:${String(mdu + 1).repeat(64)}`,
  } as FrozenSession)))
  const storage = store()
  let cursor = retrievalCheckpointCursor(storage, 'file', { id: 'same-output', length: 16n << 20n, through: -1n })
  let opens = 0, fetches = 0, acks = 0
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    opens++; fetches += 8
    storage.put(`open-${ordinal}`, { committed: true })
    const wave = waves[ordinal]
    cursor.prepare(BigInt(ordinal), wave)
    const outcomes = await confirmAndRequestRetrievalProofs(wave, { confirm: async () => {
      acks++; storage.put(`ack-${ordinal}`, { committed: true })
    } })
    cursor.complete(BigInt(ordinal), outcomes)
    assert.equal(cursor.state.cleanup, undefined)
  }
  assert.equal(cursor.state.unsettled, 16)
  cursor = retrievalCheckpointCursor(storage, 'file', storage.get<RetrievalCheckpointState>('file')!)
  const posted: string[] = [], forgotten: string[][] = []
  await cursor.reconcile((wave) => confirmAndRequestRetrievalProofs(wave, {
    confirm: async () => {}, resolveProviderBase: async () => 'https://provider.example',
    fetchFn: async (_, init) => {
      const id = JSON.parse(String(init?.body)).session_id
      posted.push(id)
      return new Response(JSON.stringify({ status: 'reconciled', session_id: id, proof_count: 8, tx_hash: '', cleanup_status: 'complete' }), { headers: { 'content-type': 'application/json' } })
    },
  }), async (wave) => {
    forgotten.push(wave.map((s) => s.sessionId))
    const ordinal = waves.findIndex((w) => w[0].sessionId === wave[0].sessionId)
    storage.remove(`open-${ordinal}`); storage.remove(`ack-${ordinal}`)
  })
  assert.deepEqual(posted, waves.flat().map((s) => s.sessionId))
  assert.deepEqual(forgotten, waves.map((w) => w.map((s) => s.sessionId)))
  assert.deepEqual([opens, fetches, acks], [2, 16, 2])
  assert.equal(cursor.state.id, 'same-output'); assert.equal(cursor.state.through, 1n)
  assert.equal(cursor.state.unsettled, 0); assert.equal(cursor.state.firstSettlementIssue, undefined)
  assert.equal(storage.get('file:settlement:0'), undefined); assert.equal(storage.get('file:settlement:1'), undefined)
})

test('mixed outcomes retain the original ACK wave and only retry its unsettled providers', async () => {
  const wave = Array.from({ length: 4 }, (_, i) => ({ ...sessions[0], sessionId: `0x${String(i + 1).repeat(64)}` as const }))
  const states = ['committed', 'pending', 'failed', 'unavailable'] as const
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'output', length: 8n, through: -1n })
  cursor.prepare(0n, wave)
  cursor.complete(0n, wave.map((s, i) => ({ sessionId: s.sessionId, state: states[i] })))
  let forgotten = 0
  await cursor.reconcile(async (remaining) => {
    assert.deepEqual(remaining.map((s) => s.sessionId), wave.slice(1).map((s) => s.sessionId))
    return remaining.map((s, i) => ({ sessionId: s.sessionId, state: i ? 'committed' : 'pending' }))
  }, async () => { forgotten++ })
  assert.equal(forgotten, 0); assert.equal(cursor.state.unsettled, 1)
  await cursor.reconcile(async (remaining) => {
    assert.deepEqual(remaining.map((s) => s.sessionId), [wave[1].sessionId])
    return [{ sessionId: wave[1].sessionId, state: 'committed' }]
  }, async (original) => { assert.deepEqual(original.map((s) => s.sessionId), wave.map((s) => s.sessionId)); forgotten++ })
  assert.equal(forgotten, 1); assert.equal(cursor.state.unsettled, 0)
})

test('settlement row persistence precedes byte cursor advancement and journal deletion', async () => {
  const storage = store()
  let denyRow = false, denyCursor = false
  const faultStore: RetrievalStore = { ...storage, put(key, value) {
    if (denyRow && key.includes(':settlement:')) throw new Error('row denied')
    if (denyCursor && key === 'file') throw new Error('cursor denied')
    storage.put(key, value)
  } }
  let cursor = retrievalCheckpointCursor(faultStore, 'file', { id: 'output', length: 8n, through: -1n })
  cursor.prepare(0n, sessions)
  denyRow = true
  assert.throws(() => cursor.complete(0n, [{ sessionId: hash, state: 'unavailable' }]), /row denied/)
  assert.equal(cursor.state.through, -1n); assert.deepEqual(cursor.state.pending?.sessions, sessions)
  denyRow = false; denyCursor = true
  assert.throws(() => cursor.complete(0n, [{ sessionId: hash, state: 'unavailable' }]), /cursor denied/)
  assert.equal(cursor.state.through, -1n)
  denyCursor = false
  cursor.complete(0n, [{ sessionId: hash, state: 'unavailable' }])
  let posts = 0, forgotten = 0
  const settle = async () => { posts++; return [{ sessionId: hash, state: 'committed' as const }] }
  const forget = async () => { forgotten++ }
  denyCursor = true
  await assert.rejects(cursor.reconcile(settle, forget), /cursor denied/)
  assert.equal(forgotten, 0)
  denyCursor = false
  cursor = retrievalCheckpointCursor(faultStore, 'file', storage.get<RetrievalCheckpointState>('file')!)
  await cursor.reconcile(settle, forget)
  assert.equal(posts, 1, 'durable committed outcome is not posted again after cursor failure')
  assert.equal(forgotten, 1); assert.equal(cursor.state.unsettled, 0)
})

test('settled row cleanup failure remains resumable after transaction journals were removed', async () => {
  const storage = store()
  let failRemoval = true
  const faultStore: RetrievalStore = { ...storage, remove(key) { if (failRemoval && key.includes(':settlement:')) throw new Error('remove denied'); storage.remove(key) } }
  let cursor = retrievalCheckpointCursor(faultStore, 'file', { id: 'output', length: 8n, through: -1n })
  cursor.prepare(0n, sessions); cursor.complete(0n, [{ sessionId: hash, state: 'pending' }])
  let posts = 0, forgets = 0
  const settle = async () => { posts++; return [{ sessionId: hash, state: 'committed' as const }] }
  const forget = async () => { forgets++ }
  await assert.rejects(cursor.reconcile(settle, forget), /remove denied/)
  assert.deepEqual(cursor.state.cleanup?.map((s) => s.sessionId), sessions.map((s) => s.sessionId))
  assert.throws(() => cursor.prepare(1n, sessions), /cleanup is pending/)
  failRemoval = false
  cursor = retrievalCheckpointCursor(faultStore, 'file', storage.get<RetrievalCheckpointState>('file')!)
  await cursor.reconcile(settle, forget)
  assert.equal(posts, 1); assert.equal(forgets, 2)
  assert.equal(cursor.state.unsettled, 0); assert.equal(cursor.state.cleanup, undefined)
})

test('133 unresolved MDU waves retain 1064 IDs without eviction or file-sized reads', async () => {
  const { browserRetrievalStore } = await import('./retrievalTransactions')
  const entries = new Map<string, string>()
  const backing: Storage = { get length() { return entries.size }, key: (i) => Array.from(entries.keys())[i] ?? null,
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: (key) => { entries.delete(key) }, clear: () => entries.clear() }
  const storage = browserRetrievalStore(backing)
  let cursor = retrievalCheckpointCursor(storage, 'file', { id: 'output', length: 1n << 30n, through: -1n })
  for (let ordinal = 0; ordinal < 133; ordinal++) {
    const wave = Array.from({ length: 8 }, (_, i) => ({ ...sessions[0], sessionId: `0x${(ordinal * 8 + i + 1).toString(16).padStart(64, '0')}` as const }))
    storage.put(`open-${ordinal}`, { committed: true }); storage.put(`ack-${ordinal}`, { committed: true })
    cursor.prepare(BigInt(ordinal), wave)
    cursor.complete(BigInt(ordinal), wave.map((s) => ({ sessionId: s.sessionId, state: 'unavailable' })))
  }
  assert.equal(entries.size, 400); assert.equal(cursor.state.unsettled, 1064)
  let seen = 0, maxWave = 0
  cursor = retrievalCheckpointCursor(browserRetrievalStore(backing), 'file', storage.get<RetrievalCheckpointState>('file')!)
  await cursor.reconcile(async (wave) => {
    maxWave = Math.max(maxWave, wave.length)
    for (const session of wave) { seen++; assert.equal(session.sessionId, `0x${seen.toString(16).padStart(64, '0')}`) }
    return wave.map((s) => ({ sessionId: s.sessionId, state: 'committed' }))
  }, async (wave) => {
    const ordinal = (Number(BigInt(wave[0].sessionId)) - 1) / 8
    storage.remove(`open-${ordinal}`); storage.remove(`ack-${ordinal}`)
  })
  assert.equal(seen, 1064); assert.equal(maxWave, 8); assert.equal(entries.size, 1)
  assert.equal(cursor.state.unsettled, 0)
})

test('an ambiguous replay remains durable and prevents cleanup of the acknowledged wave', async () => {
  const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'output', length: 8n, through: -1n })
  cursor.prepare(0n, sessions); cursor.complete(0n, [{ sessionId: hash, state: 'unavailable' }])
  await assert.rejects(cursor.reconcile(async () => [{ sessionId: hash, state: 'pending', responseUnknown: true }], async () => {
    assert.fail('uncertain settlement cannot forget journals')
  }), /outcome is unknown/)
  assert.equal(cursor.state.through, 0n); assert.equal(cursor.state.unsettled, 1)
  const restored = retrievalCheckpointCursor(storage, 'file', storage.get<RetrievalCheckpointState>('file')!)
  await restored.reconcile(async (wave) => {
    assert.deepEqual(wave.map((s) => s.sessionId), sessions.map((s) => s.sessionId))
    return [{ sessionId: hash, state: 'committed' }]
  }, async () => {})
  assert.equal(restored.state.unsettled, 0)
})

test('malformed compact recovery identities fail closed before proof dispatch or journal removal', async () => {
  for (const mutate of [
    (s: FrozenSession) => { s.sessionId = '0xAB' },
    (s: FrozenSession) => { s.payee = 'not-an-account' },
    (s: FrozenSession) => { s.pin.dealId = -1n },
    (s: FrozenSession) => { s.window.blobCount = 65 },
    (s: FrozenSession) => { s.browserTransactionKey = 'ack:unrelated' },
  ]) {
    const storage = store(), cursor = retrievalCheckpointCursor(storage, 'file', { id: 'output', length: 8n, through: -1n })
    cursor.prepare(0n, sessions); cursor.complete(0n, [{ sessionId: hash, state: 'unavailable' }])
    const row = storage.get<{ sessions: FrozenSession[] }>('file:settlement:0')!
    mutate(row.sessions[0]); storage.put('file:settlement:0', row)
    await assert.rejects(cursor.reconcile(async () => { assert.fail('malformed session was dispatched') }, async () => { assert.fail('malformed journal was removed') }))
    assert.equal(cursor.state.unsettled, 1)
  }
})
