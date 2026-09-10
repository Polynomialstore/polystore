import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as transactions from './retrievalTransactions'
import * as diagnostics from './retrievalDiagnostics'
import type { FrozenSession, PinnedGeneration, RetrievalWindow } from './retrieval'

// Execute both actual hook paths; replace only transport/storage boundaries.
function fixture(mode: 'open' | 'ack' | 'ackV3' | 'refundV3') {
  const records = new Map<string, unknown>()
  const store: transactions.RetrievalStore = { get: <T>(key: string) => records.get(key) as T | undefined,
    put: (key, value) => { records.set(key, value) }, remove: (key) => { records.delete(key) } }
  const hash = `0x${'12'.repeat(32)}` as const, address = '0x1111111111111111111111111111111111111111'
  const precompile = '0x2222222222222222222222222222222222222222'
  let estimates = 0, sends = 0, failEstimate = false, loseHash = false, loseReceipt = false, reverted = false, changedContext = false
  const pin = { dealId: 1n, owner: 'owner', root: hash, generation: 1n, layout: 'mode2', k: 2, m: 1,
    metadataMdus: 2n, userMdus: 1n, endHeight: 1000n, height: 10n, assignments: [{ active: true, provider: 'provider' }] }
  const window = { slot: 0, provider: 'provider', mduIndex: 2n, startBlobIndex: 0, blobCount: 1 }
  const session = { sessionId: hash, pin, window, owner: 'owner', payee: 'provider', funding: 1, status: 2 }
  const sessionV3 = { sessionId: hash, authority: { chainId: 'chain', integrityRoot: hash }, contextHash: new Uint8Array(32), planHash: new Uint8Array(32),
    owner: 'owner', fileRecordIndex: 0, obligations: [{ slot: 0, assigned: 'provider', payee: 'provider', blobCount: 1n }], ackedMask: 0, refundedMask: 0 }
  const client = { chain: { id: 1 }, call: async () => ({ data: '0xab' }),
    estimateGas: async (request: unknown) => {
      estimates++
      assert.deepEqual(request, { account: address, to: precompile, data: '0x1234' })
      if (failEstimate) throw new Error('estimator unavailable')
      return 226673n
    },
    waitForTransactionReceipt: async () => {
      if (loseReceipt) throw new Error('lost receipt')
      return { transactionHash: hash, status: reverted ? 'reverted' : 'success', blockNumber: 128n }
    },
  }
  const wallet = { chain: client.chain, sendTransaction: async (request: unknown) => {
    sends++
    assert.deepEqual(request, { chain: client.chain, account: address, to: precompile, data: '0x1234', gas: 282008n })
    if (loseHash) throw new Error('lost wallet hash')
    return hash
  } }
  const modules: Record<string, unknown> = {
    '../lib/retrievalDiagnostics': diagnostics,
    wagmi: { useAccount: () => ({ address }), usePublicClient: () => client, useWalletClient: () => ({ data: wallet }) },
    '@tanstack/react-query': { useQuery: () => ({ data: null }) },
    '../config': { appConfig: { chainId: 1, cosmosChainId: 'chain', polystorePrecompile: precompile } },
    '../lib/address': { ethToPolystoreAddress: () => 'owner' },
    '../lib/polystorePrecompile': { encodeRetrievalV2Data: () => '0x1234', encodeConfirmRetrievalSessionsData: () => '0x1234',
      encodeAcknowledgeRetrievalObligationV3Data: () => '0x1234', encodeRefundRetrievalSessionV3Data: () => '0x1234',
      decodeComputeRetrievalSessionIdsResult: () => ({ providers: ['provider'], sessionIds: [hash] }) },
    '../lib/retrieval': { fetchActiveRetrievalGeneration: async () => pin, fetchFrozenSession: async () => { if (loseHash) throw new Error('session not observed'); return session },
      unhex: () => new Uint8Array(32), accountBytes: () => new Uint8Array(20) },
    '../lib/retrievalFlow': { waitForRetrievalChallenge: async () => session },
    '../lib/retrievalV3': { preserveV3BrowserTransactionKey: (previous: { browserTransactionKey?: string }, current: object) => ({ ...current, browserTransactionKey: previous.browserTransactionKey }),
      fetchSessionV3: async (_lcd: string, _authority: object, expected: { frozenContextHash?: Uint8Array }) => {
        if (changedContext && expected.frozenContextHash) throw new Error('session context changed')
        return { ...sessionV3, ackedMask: 1, refundedMask: 1 }
      } },
    '../lib/worker-client': { workerClient: { retrievalV3AckHash: async () => new Uint8Array(32) } },
    '../domain/polyfsLayout': { BLOB_SIZE_BYTES: 131_072 },
    '../lib/retrievalTransactions': { ...transactions, browserRetrievalStore: () => store,
      retrievalIntentKey: async () => 'test', withRetrievalLock: (_key: string, work: () => unknown) => work() },
  }
  const source = readFileSync(new URL('../hooks/useRetrievalSessions.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { useRetrievalSessions?: typeof import('../hooks/useRetrievalSessions').useRetrievalSessions } = {}
  new Function('require', 'exports', code)((name: string) => {
    if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
    return modules[name]
  }, exports)
  const hook = exports.useRetrievalSessions!()
  return { store, hook, get estimates() { return estimates }, get sends() { return sends },
    set failEstimate(value: boolean) { failEstimate = value }, set loseHash(value: boolean) { loseHash = value },
    set loseReceipt(value: boolean) { loseReceipt = value }, set changedContext(value: boolean) { changedContext = value },
    set reverted(value: boolean) { reverted = value },
    run: () => mode === 'open' ? hook.open(pin as unknown as PinnedGeneration, [window as RetrievalWindow]) : mode === 'ack' ? hook.confirm([session as unknown as FrozenSession]) :
      mode === 'ackV3' ? hook.acknowledgeV3(sessionV3 as never, 0) : hook.refundV3(sessionV3 as never),
    key: mode === 'open' ? 'open:test' : mode === 'ack' ? 'ack:test' : mode === 'ackV3' ? 'ack-v3:test' : 'refund-v3:test' }
}

test('v3 cached cleanup preserves a newer unresolved retrieval for the same owner and deal', async () => {
  const f = fixture('open')
  const oldSessionId = `0x${'12'.repeat(32)}` as const
  const newSessionId = `0x${'34'.repeat(32)}` as const
  const key = 'open-v3:test'
  f.store.put(key, { state: 'broadcasting', data: '0x1234', intent: { binding: { sessionId: newSessionId } } })

  await f.hook.forgetV3({ sessionId: oldSessionId, obligations: [], browserTransactionKey: key } as never)
  assert.equal((f.store.get<{ intent: { binding: { sessionId: string } } }>(key))?.intent.binding.sessionId, newSessionId)

  f.store.put(key, { state: 'committed', data: '0x1234', intent: { binding: { sessionId: oldSessionId } } })
  await f.hook.forgetV3({ sessionId: oldSessionId, obligations: [], browserTransactionKey: key } as never)
  assert.equal(f.store.get(key), undefined)
})

test('retrieval gas margin rounds upward without lossy number conversion', () => {
  assert.equal(transactions.retrievalGasLimit(1n), 10002n)
  const large = BigInt(Number.MAX_SAFE_INTEGER) + 42n
  assert.equal(transactions.retrievalGasLimit(large), (large * 6n + 4n) / 5n + 10000n)
  for (const bad of [0n, -1n]) assert.throws(() => transactions.retrievalGasLimit(bad))
})

for (const mode of ['open', 'ack'] as const) {
  test(`${mode}: estimate failure stays pre-broadcast and explicit retry estimates again`, async () => {
    const f = fixture(mode); f.failEstimate = true
    await assert.rejects(f.run(), /estimator unavailable/)
    assert.equal(f.sends, 0); assert.equal(f.store.get(f.key), undefined)
    f.failEstimate = false
    await f.run()
    assert.equal(f.estimates, 2); assert.equal(f.sends, 1)
  })
  test(`${mode}: proven revert re-estimates, lost hash never re-estimates or resends`, async () => {
    const f = fixture(mode); f.reverted = true
    await assert.rejects(f.run(), /reverted/)
    f.reverted = false
    await f.run()
    assert.equal(f.estimates, 2); assert.equal(f.sends, 2)
    const lost = fixture(mode); lost.loseHash = true
    await assert.rejects(lost.run(), /wallet returned no hash/)
    await assert.rejects(lost.run(), /outcome is unresolved/)
    assert.equal(lost.estimates, 1); assert.equal(lost.sends, 1)
  })
}

for (const mode of ['ackV3', 'refundV3'] as const) {
  test(`${mode}: lost receipt reconciles only against the frozen session context`, async () => {
    const f = fixture(mode)
    f.loseReceipt = true
    f.changedContext = true
    await assert.rejects(f.run(), /outcome is unresolved/)
    assert.equal(f.sends, 1)
    assert.equal(f.store.get<transactions.BrowserTransaction>(f.key)?.state, 'broadcasting')
    f.changedContext = false
    await f.run()
    assert.equal(f.sends, 1)
    assert.equal(f.store.get<transactions.BrowserTransaction>(f.key)?.state, 'committed')
  })
}
