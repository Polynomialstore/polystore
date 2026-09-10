import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { assertRetrievalV3CheckpointScope, discardUnboundRetrievalV3Checkpoint, hasSettledRetrievalV3Cache, listRetrievalV3Checkpoints, purgeSettledRetrievalV3Cache, purgeSettledRetrievalV3CacheForKey, readRetrievalV3Checkpoint, retainSettledRetrievalV3Cache, retrievalV3CheckpointKey, retrievalV3CheckpointMatchesCurrent, retrievalV3DownloadCheckpointKey, type RetrievalV3CheckpointState } from './retrievalV3Checkpoint'
import { RETRIEVAL_V3_SETUP, type FrozenSessionV3 } from './retrievalV3'
import { retrievalV3OpenTransactionKey, settleBrowserTransaction, type BrowserTransaction, type RetrievalStore } from './retrievalTransactions'

const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))
function store(value: RetrievalV3CheckpointState): RetrievalStore {
  return { get: <T>() => structuredClone(value) as T, put() {}, remove() {} }
}

function mapStore(values: Record<string, unknown>): RetrievalStore {
  const entries = new Map(Object.entries(values))
  return { get: <T>(key: string) => structuredClone(entries.get(key)) as T, put(key, value) { entries.set(key, structuredClone(value)) }, remove(key) { entries.delete(key) },
    keys(prefix) { return [...entries.keys()].filter((key) => key.startsWith(prefix)) } }
}
function state(): RetrievalV3CheckpointState {
  const providers = Array.from({ length: 12 }, (_, i) => address(i + 2)), length = 65n * 126_976n
  const authority = { chainId: 'test-1', height: 9n, dealId: 7n, generation: 2n, owner: address(1), dealEnd: 100n,
    setupDigest: RETRIEVAL_V3_SETUP, providers, totalMdus: 4n, witnessMdus: 1n, metadataMdus: 2n, userMdus: 2n,
    integrityLeafCount: 192n, polyfsRoot: `0x${'11'.repeat(32)}` as const, integrityRoot: `0x${'22'.repeat(32)}` as const, retrievalPolicyMode: 5 as const }
  const file = { path: 'file.bin', start_offset: 0n, size_bytes: length, flags: 0 }
  const session = { authority, height: 12n, sessionId: `0x${'33'.repeat(32)}`, contextHash: new Uint8Array(32), planHash: new Uint8Array(32),
    owner: authority.owner, payer: authority.owner, fileRecordIndex: 3, file, rangeStart: 0n, rangeLength: length, first: 0n, last: 64n,
    population: 65n, sampleCount: 65n, nonce: 1n, priceDenom: 'stake', pricePerBlob: 1n, baseFee: 1n, completionBurnBps: 0, funding: 1,
    snapshot: 10n, anchor: 11n, firstResponse: 12n, deadline: 90n, dealEnd: 100n,
    obligations: [{ slot: 0, assigned: providers[0], payee: providers[0], blobCount: 9n, sampleCount: 9n, lockedFee: 9n }],
    acceptedBitmap: new Uint8Array(17), ackedMask: 0, settledMask: 0, refundedMask: 0, lockedFee: 9n, expired: false, context: new Uint8Array() } as FrozenSessionV3
  return { version: 3, id: 'output', length, authority, fileRecordIndex: 3, file, rangeStart: 0n, rangeLength: length,
    requestRangeStart: null, requestRangeLength: null, requester: authority.owner, session, cursors: { 0: 64n } }
}

function unboundState(): RetrievalV3CheckpointState {
  return { ...state(), session: undefined, cursors: {} }
}

function transactionIntent(saved: RetrievalV3CheckpointState) {
  return { authority: saved.authority, recordIndex: saved.fileRecordIndex, file: saved.file,
    rangeStart: saved.rangeStart, rangeLength: saved.rangeLength, nonce: 1n, expiry: 50n, binding: { sessionId: `0x${'44'.repeat(32)}` } }
}

test('v3 checkpoint accepts only exact frozen session and durable chunk boundaries', () => {
  const valid = state()
  assert.equal(readRetrievalV3Checkpoint('key', store(valid))?.cursors[0], 64n)
  assert.equal(readRetrievalV3Checkpoint('key', store({ ...valid, requestRangeLength: 0 }))?.requestRangeLength, 0)
  for (const mutation of [
    { ...valid, cursors: { 0: 63n } },
    { ...valid, session: undefined, cursors: { 0: 64n } },
    { ...valid, fileRecordIndex: 4 },
    { ...valid, authority: { ...valid.authority, integrityRoot: `0x${'23'.repeat(32)}` as const } },
  ]) assert.throws(() => readRetrievalV3Checkpoint('key', store(mutation as RetrievalV3CheckpointState)), /invalid saved/)
})

test('checkpoint listing exposes only the wallet paid recovery for the requested deal', () => {
  const own = state(), otherWallet = state(), otherDeal = state(), malformed = state()
  otherWallet.requester = address(20); otherWallet.session = undefined; otherWallet.cursors = {}
  otherDeal.authority = { ...otherDeal.authority, dealId: 8n }; otherDeal.session = undefined; otherDeal.cursors = {}
  malformed.requester = 'bad'
  const ownKey = 'output-v3:' + 'a'.repeat(64)
  const saved = mapStore({ [ownKey]: own, ['output-v3:' + 'b'.repeat(64)]: otherWallet,
    ['output-v3:' + 'c'.repeat(64)]: otherDeal, ['output-v3:' + 'd'.repeat(64)]: malformed })
  assert.deepEqual(listRetrievalV3Checkpoints(7n, own.requester, own.authority.chainId, saved).map(({ key }) => key), [ownKey])
  assert.deepEqual(listRetrievalV3Checkpoints(7n, own.requester, 'other-1', saved), [])
})

test('same-root slot repair still classifies the older generation as explicit recovery', () => {
  const saved = state()
  const files = [{ path: saved.file.path, start_offset: saved.file.start_offset, size_bytes: saved.file.size_bytes }]
  assert.equal(retrievalV3CheckpointMatchesCurrent(saved, '2', saved.authority.polyfsRoot, files), true)
  assert.equal(retrievalV3CheckpointMatchesCurrent(saved, '3', saved.authority.polyfsRoot, files), false)
})

test('v3 download recovery key is stable when sponsored fee authorization changes', async () => {
  const key = await retrievalV3DownloadCheckpointKey('wallet:1', '7', 'file.bin', 0, 1024, undefined)
  assert.equal(key, await retrievalV3CheckpointKey(['wallet:1', 'download-v3', '7', 'file.bin', 0, 1024, undefined]))
  assert.notEqual(key, await retrievalV3CheckpointKey(['wallet:1', 'download-v3', '7', 'file.bin', 0, 1024, undefined,
    { type: 'none', maxTotalFee: 5n }]))
})

test('explicit recovery remains bound to its original wallet and network scope', async () => {
  const saved = state(), scope = ['test-1', 31337, '0x1234', '0xabcd']
  const key = await retrievalV3DownloadCheckpointKey(scope, '7', saved.file.path, undefined, undefined, undefined)
  await assertRetrievalV3CheckpointScope(key, saved, scope, saved.requester, saved.authority.chainId)
  await assert.rejects(assertRetrievalV3CheckpointScope(key, saved, ['other-1', 31337, '0x1234', '0xabcd'], saved.requester,
    saved.authority.chainId), /another wallet or network/)
  await assert.rejects(assertRetrievalV3CheckpointScope(key, saved, scope, saved.requester, 'other-1'), /another wallet or network/)
})

test('wallet rejection and estimate failure can discard an unbound frozen attempt before the current generation starts', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_key: string, _options: object, run: (lock: object | null) => unknown) => run({}) } } })
  try {
    const scope = ['test-1', 31337, '0x1234', '0xabcd']
    for (const failure of ['wallet', 'estimate'] as const) {
      const saved = unboundState()
      const key = await retrievalV3DownloadCheckpointKey(scope, '7', saved.file.path, undefined, undefined, undefined)
      const paymentKey = await retrievalV3OpenTransactionKey(scope, saved.requester, saved.authority.dealId)
      const records = mapStore({ [key]: saved })
      let payments = 0
      await assert.rejects(settleBrowserTransaction({ store: records, key: paymentKey,
        prepare: async () => {
          if (failure === 'estimate') throw new Error('estimate failed')
          return { data: '0x1234', intent: transactionIntent(saved) }
        },
        send: async () => { payments++; throw { code: 4001 } },
        receipt: async () => { throw new Error('not reached') }, reconcile: async () => false,
      }), failure === 'wallet' ? /object Object/ : /estimate failed/)
      assert.equal(records.get<BrowserTransaction>(paymentKey)?.state, failure === 'wallet' ? 'prepared' : undefined)
      const removed: string[] = []
      await discardUnboundRetrievalV3Checkpoint(key, scope, saved.requester, saved.authority.chainId, records, async (id) => { removed.push(id) })
      assert.deepEqual(removed, [saved.id])
      assert.equal(records.get(key), undefined)
      assert.equal(records.get(paymentKey), undefined)
      assert.equal(payments, failure === 'wallet' ? 1 : 0)
      const current = { ...saved, authority: { ...saved.authority, generation: 3n, polyfsRoot: `0x${'55'.repeat(32)}` as const } }
      records.put(key, current)
      assert.equal(readRetrievalV3Checkpoint(key, records)?.authority.generation, 3n)
      const opened = await settleBrowserTransaction({ store: records, key: paymentKey,
        prepare: async () => ({ data: '0x1234', intent: transactionIntent(current) }),
        send: async () => { payments++; return `0x${'66'.repeat(32)}` },
        receipt: async (hash) => ({ transactionHash: hash, status: 'success', blockNumber: 12n }), reconcile: async () => false,
      })
      assert.equal(opened.state, 'committed')
      assert.equal(payments, failure === 'wallet' ? 2 : 1)
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test('unbound discard retains paid, uncertain, malformed, and locked records while preserving a mismatched safe journal', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let blocked = ''
  const held = new Set<string>()
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (key: string, _options: object, run: (lock: object | null) => unknown) => {
    if (key === blocked || held.has(key)) return run(null)
    held.add(key)
    try { return await run({}) } finally { held.delete(key) }
  } } } })
  try {
    const scope = ['test-1', 31337, '0x1234', '0xabcd'], base = unboundState()
    const key = await retrievalV3DownloadCheckpointKey(scope, '7', base.file.path, undefined, undefined, undefined)
    const paymentKey = await retrievalV3OpenTransactionKey(scope, base.requester, base.authority.dealId)
    const cases: Array<[string, RetrievalV3CheckpointState, unknown]> = [
      ['bound', state(), undefined],
      ['lost hash', base, { state: 'broadcasting', data: '0x1234', intent: transactionIntent(base) }],
      ['committed', base, { state: 'committed', data: '0x1234', hash: `0x${'44'.repeat(32)}`, intent: transactionIntent(base) }],
      ['unknown', base, null],
      ['missing intent', base, { state: 'prepared', data: '0x1234' }],
    ]
    for (const [label, checkpoint, journal] of cases) {
      const records = mapStore({ [key]: checkpoint, ...(journal === undefined ? {} : { [paymentKey]: journal }) })
      let removed = 0
      await assert.rejects(discardUnboundRetrievalV3Checkpoint(key, scope, base.requester, base.authority.chainId, records, async () => { removed++ }))
      assert.equal(removed, 0, label)
      assert.equal(held.size, 0, label)
      assert.notEqual(records.get(key), undefined, label)
      if (journal !== undefined) assert.notEqual(records.get(paymentKey), undefined, label)
    }
    const mismatch = { state: 'prepared', data: '0x1234', intent: { ...transactionIntent(base), rangeLength: base.rangeLength - 1n } }
    const mismatchedRecords = mapStore({ [key]: base, [paymentKey]: mismatch })
    await discardUnboundRetrievalV3Checkpoint(key, scope, base.requester, base.authority.chainId, mismatchedRecords, async () => {})
    assert.equal(mismatchedRecords.get(key), undefined)
    assert.deepEqual(mismatchedRecords.get(paymentKey), mismatch)
    for (blocked of [key, `polystore-retrieval-v1:${paymentKey}`]) {
      const records = mapStore({ [key]: base })
      await assert.rejects(discardUnboundRetrievalV3Checkpoint(key, scope, base.requester, base.authority.chainId, records, async () => {}), /another tab/)
      assert.notEqual(records.get(key), undefined)
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test('settled output cache is one-entry bounded and never evicts active or unresolved recovery', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let blocked = ''
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (key: string, options: object, run: (lock: object | null) => unknown) =>
    run(key === blocked ? null : {}) } } })
  try {
    const first = state(), second = state()
    first.id = '00000000-0000-0000-0000-000000000000'
    first.session = { ...first.session!, lockedFee: 0n, ackedMask: 1, settledMask: 1 }
    second.id = '11111111-1111-1111-1111-111111111111'
    second.session = { ...second.session!, sessionId: `0x${'44'.repeat(32)}`, lockedFee: 0n, ackedMask: 1, settledMask: 1 }
    const firstKey = 'output-v3:' + 'a'.repeat(64), secondKey = 'output-v3:' + 'b'.repeat(64)
    const cacheKey = 'output-v3:settled-cache'
    const firstEntry = { version: 1 as const, key: firstKey, id: first.id, length: first.length, dealId: first.authority.dealId, filePath: first.file.path }
    const secondEntry = { version: 1 as const, key: secondKey, id: second.id, length: second.length, dealId: second.authority.dealId, filePath: second.file.path }
    const removed: string[] = []
    const saved = mapStore({ [firstKey]: first, [secondKey]: second, [cacheKey]: firstEntry })
    assert.equal(hasSettledRetrievalV3Cache(firstEntry.dealId, firstEntry.filePath, firstKey, saved), true)
    assert.equal(hasSettledRetrievalV3Cache(firstEntry.dealId, firstEntry.filePath, secondKey, saved), false)

    blocked = firstKey
    assert.equal(await retainSettledRetrievalV3Cache(secondEntry, saved, async (id) => { removed.push(id) }), false)
    assert.equal(saved.get<{ key: string }>(cacheKey)?.key, firstKey)
    blocked = ''
    assert.equal(await retainSettledRetrievalV3Cache(secondEntry, saved, async (id) => { removed.push(id) }), true)
    assert.deepEqual(removed, [first.id])
    assert.equal(saved.get(firstKey), undefined)
    assert.equal(saved.get<{ key: string }>(cacheKey)?.key, secondKey)

    assert.equal(await retainSettledRetrievalV3Cache({ ...secondEntry, id: first.id }, saved, async (id) => { removed.push(id) }), false)
    assert.equal(saved.get<{ id: string }>(cacheKey)?.id, second.id)

    second.session = { ...second.session!, lockedFee: 1n, settledMask: 0 }
    saved.put(secondKey, second)
    await assert.rejects(retainSettledRetrievalV3Cache(firstEntry, saved, async (id) => { removed.push(id) }), /completed output/)
    assert.deepEqual(removed, [first.id], 'unresolved output is never removed')

    second.session = { ...second.session!, lockedFee: 0n, settledMask: 1 }
    saved.put(secondKey, second)
    blocked = secondKey
    assert.equal(await purgeSettledRetrievalV3Cache(secondEntry.dealId, secondEntry.filePath, saved, async (id) => { removed.push(id) }), false)
    assert.equal(saved.get<{ key: string }>(cacheKey)?.key, secondKey)
    blocked = ''
    assert.equal(await purgeSettledRetrievalV3CacheForKey(secondEntry.dealId, secondEntry.filePath, firstKey, saved,
      async (id) => { removed.push(id) }), false)
    assert.equal(await purgeSettledRetrievalV3CacheForKey(secondEntry.dealId, secondEntry.filePath, secondKey, saved,
      async (id) => { removed.push(id) }), true)
    assert.deepEqual(removed, [first.id, second.id])
    assert.equal(saved.get(cacheKey), undefined)
    assert.equal(saved.get(secondKey), undefined)
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
