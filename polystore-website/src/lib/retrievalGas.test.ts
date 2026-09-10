import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as transactions from './retrievalTransactions'
import * as diagnostics from './retrievalDiagnostics'
import * as retrievalV3 from './retrievalV3'
import * as transportMode from './transport/mode'
import type { FrozenSession, PinnedGeneration, RetrievalWindow } from './retrieval'

// Execute both actual hook paths; replace only transport/storage boundaries.
function fixture(mode: 'open' | 'openV3' | 'ack' | 'ackV3' | 'refundV3') {
  const records = new Map<string, unknown>()
  const store: transactions.RetrievalStore = { get: <T>(key: string) => records.get(key) as T | undefined,
    put: (key, value) => { records.set(key, value) }, remove: (key) => { records.delete(key) } }
  const hash = `0x${'12'.repeat(32)}` as const, address = '0x1111111111111111111111111111111111111111'
  const precompile = '0x2222222222222222222222222222222222222222'
  let estimates = 0, sends = 0, nonceQueries = 0, generationQueries = 0, failEstimate = false, loseHash = false, loseReceipt = false, reverted = false, changedContext = false
  let gatewayDisabled = false, gatewayConnected = true
  const pin = { dealId: 1n, owner: 'owner', root: hash, generation: 1n, layout: 'mode2', k: 2, m: 1,
    metadataMdus: 2n, userMdus: 1n, endHeight: 1000n, height: 10n, assignments: [{ active: true, provider: 'provider' }] }
  const window = { slot: 0, provider: 'provider', mduIndex: 2n, startBlobIndex: 0, blobCount: 1 }
  const session = { sessionId: hash, pin, window, owner: 'owner', payee: 'provider', funding: 1, status: 2 }
  const providers = Array.from({ length: 12 }, (_, index) => `provider-${index}`)
  const authorityV3 = { chainId: 'chain', height: 10n, dealId: 1n, generation: 1n, owner: 'owner', dealEnd: 1000n,
    polyfsRoot: hash, integrityRoot: hash, setupDigest: hash, retrievalPolicyMode: 1, integrityLeafCount: 96n,
    metadataMdus: 2n, userMdus: 1n, totalMdus: 3n, witnessMdus: 1n, providers } as const
  let activeAuthorityV3 = authorityV3 as retrievalV3.FrozenGenerationV3
  const fileV3 = { path: 'original.bin', start_offset: 0n, size_bytes: 131_072n, flags: 0 }
  let nonceSessionId: typeof hash | null = null
  const bindingV3 = { range: { first: 0n, last: 0n, population: 1n }, plan: new Uint8Array(1), planHash: new Uint8Array(32), sessionId: hash,
    obligations: [{ slot: 0, assigned: providers[0], payee: providers[0], blobCount: 1n, sampleCount: 0n, lockedFee: 0n }] }
  const sessionV3 = { sessionId: hash, authority: authorityV3, contextHash: new Uint8Array(32), planHash: new Uint8Array(32),
    owner: 'owner', fileRecordIndex: 0, file: fileV3, rangeStart: 0n, rangeLength: 131_072n, nonce: 1n, deadline: 100n, funding: 1,
    obligations: bindingV3.obligations, ackedMask: 0, refundedMask: 0 }
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
    '../config': { appConfig: { chainId: 1, cosmosChainId: 'chain', polystorePrecompile: precompile,
      gatewayBase: 'http://127.0.0.1:8080', get gatewayDisabled() { return gatewayDisabled } } },
    '../lib/address': { ethToPolystoreAddress: () => 'owner' },
    '../lib/polystorePrecompile': { encodeRetrievalV2Data: () => '0x1234', encodeConfirmRetrievalSessionsData: () => '0x1234',
      encodeOpenRetrievalSessionV3Data: () => '0x1234', encodeOpenRetrievalSessionV3SponsoredData: () => '0x1234',
      encodeAcknowledgeRetrievalObligationV3Data: () => '0x1234', encodeRefundRetrievalSessionV3Data: () => '0x1234',
      decodeComputeRetrievalSessionIdsResult: () => ({ providers: ['provider'], sessionIds: [hash] }) },
    '../lib/retrieval': { fetchActiveRetrievalGeneration: async () => pin, fetchFrozenSession: async () => { if (loseHash) throw new Error('session not observed'); return session },
      unhex: () => new Uint8Array(32), accountBytes: () => new Uint8Array(20) },
    '../lib/retrievalFlow': { waitForRetrievalChallenge: async () => session },
    '../lib/retrievalV3': { ...retrievalV3,
      fetchActiveGenerationV3: async () => { generationQueries++; return activeAuthorityV3 },
      fetchLatestNonceV3: async () => { nonceQueries++; return { found: false, nonce: 0n, height: 10n } },
      fetchSessionIDByNonceV3: async () => nonceSessionId,
      prepareV3Binding: async () => bindingV3,
      fetchSessionV3: async (_lcd: string, _authority: object, expected: { frozenContextHash?: Uint8Array }) => {
        if (changedContext && expected.frozenContextHash) throw new Error('session context changed')
        return { ...sessionV3, ackedMask: 1, refundedMask: 1 }
      } },
    '../lib/worker-client': { workerClient: { retrievalV3AckHash: async () => new Uint8Array(32), retrievalV3Range: async () => new Uint8Array(24),
      retrievalV3ContextHash: async () => new Uint8Array(32), retrievalV3Seed: async () => new Uint8Array(32), retrievalV3Challenges: async () => new Uint8Array() } },
    '../domain/polyfsLayout': { BLOB_SIZE_BYTES: 131_072 },
    '../lib/retrievalTransactions': { ...transactions, browserRetrievalStore: () => store,
      retrievalIntentKey: async () => 'test', retrievalV3OpenTransactionKey: async () => 'open-v3:test',
      withRetrievalLock: (_key: string, work: () => unknown) => work() },
    '../lib/retrievalV3Checkpoint': { discardUnboundRetrievalV3Checkpoint: async () => {} },
    '../lib/retrievalMode': { readLocalGatewayConnectedHint: () => gatewayConnected },
    '../lib/transport/mode': transportMode,
  }
  const source = readFileSync(new URL('../hooks/useRetrievalSessions.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { useRetrievalSessions?: typeof import('../hooks/useRetrievalSessions').useRetrievalSessions } = {}
  new Function('require', 'exports', code)((name: string) => {
    if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
    return modules[name]
  }, exports)
  const hook = exports.useRetrievalSessions!()
  const runOpenV3 = (authority: retrievalV3.FrozenGenerationV3 = authorityV3 as retrievalV3.FrozenGenerationV3, file = fileV3) =>
    hook.openV3(authority, 0, file as never, 0n, file.size_bytes)
  return { store, hook, authorityV3, sessionId: hash, get estimates() { return estimates }, get sends() { return sends },
    get nonceQueries() { return nonceQueries }, get generationQueries() { return generationQueries },
    set failEstimate(value: boolean) { failEstimate = value }, set loseHash(value: boolean) { loseHash = value },
    set loseReceipt(value: boolean) { loseReceipt = value }, set changedContext(value: boolean) { changedContext = value },
    set nonceSessionId(value: typeof hash | null) { nonceSessionId = value },
    set gatewayDisabled(value: boolean) { gatewayDisabled = value }, set gatewayConnected(value: boolean) { gatewayConnected = value },
    advanceGeneration() { activeAuthorityV3 = { ...authorityV3, generation: 2n, polyfsRoot: `0x${'34'.repeat(32)}` } as retrievalV3.FrozenGenerationV3; return activeAuthorityV3 },
    set reverted(value: boolean) { reverted = value },
    runOpenV3,
    run: () => mode === 'open' ? hook.open(pin as unknown as PinnedGeneration, [window as RetrievalWindow]) : mode === 'openV3' ? runOpenV3() : mode === 'ack' ? hook.confirm([session as unknown as FrozenSession]) :
      mode === 'ackV3' ? hook.acknowledgeV3(sessionV3 as never, 0) : hook.refundV3(sessionV3 as never),
    key: mode === 'open' ? 'open:test' : mode === 'openV3' ? 'open-v3:test' : mode === 'ack' ? 'ack:test' : mode === 'ackV3' ? 'ack-v3:test' : 'refund-v3:test' }
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

test('openV3: lost receipt resumes the frozen journal after the active generation advances', async () => {
  const f = fixture('openV3')
  f.loseReceipt = true
  await assert.rejects(f.run(), /outcome is unresolved/)
  const pending = f.store.get<transactions.BrowserTransaction<{ authority: retrievalV3.FrozenGenerationV3; file: { path: string; start_offset: bigint; size_bytes: bigint; flags: number }; recordIndex: number;
    rangeStart: bigint; rangeLength: bigint; nonce: bigint; binding: { sessionId: string } }>>(f.key)!
  assert.equal(pending.state, 'broadcasting')
  assert.equal(pending.intent.authority.owner, 'owner')
  assert.equal(pending.intent.authority.dealId, 1n)
  assert.equal(pending.intent.authority.generation, 1n)
  assert.deepEqual(pending.intent.file, { path: 'original.bin', start_offset: 0n, size_bytes: 131_072n, flags: 0 })
  assert.deepEqual([pending.intent.recordIndex, pending.intent.rangeStart, pending.intent.rangeLength, pending.intent.nonce, pending.intent.binding.sessionId],
    [0, 0n, 131_072n, 1n, f.sessionId])
  f.advanceGeneration()
  f.nonceSessionId = f.sessionId
  f.gatewayConnected = false

  const session = await f.run()
  assert.ok(session && !Array.isArray(session))
  assert.equal(session.sessionId, f.sessionId)
  assert.equal(session.authority.generation, 1n)
  assert.equal(f.generationQueries, 1)
  assert.equal(f.nonceQueries, 1)
  assert.equal(f.estimates, 1)
  assert.equal(f.sends, 1)
})

for (const row of [
  { name: 'unbound disabled', state: undefined, disabled: true, connected: true },
  { name: 'prepared disconnected', state: 'prepared', disabled: false, connected: false },
  { name: 'reverted disabled', state: 'reverted', disabled: true, connected: true },
] as const) {
  test(`openV3: ${row.name} proof route fails before nonce or payment preparation`, async () => {
    const f = fixture('openV3')
    if (row.state) f.store.put(f.key, { state: row.state, data: '0x1234', intent: {} })
    f.gatewayDisabled = row.disabled
    f.gatewayConnected = row.connected

    await assert.rejects(f.run(), /requires a connected trusted user-gateway for proof submission/)
    assert.equal(f.generationQueries, 0)
    assert.equal(f.nonceQueries, 0)
    assert.equal(f.estimates, 0)
    assert.equal(f.sends, 0)
  })
}

test('openV3: an unknown broadcast reconciles while the proof route is unavailable', async () => {
  const f = fixture('openV3')
  f.loseHash = true
  await assert.rejects(f.run(), /outcome is unresolved/)
  f.gatewayConnected = false
  f.nonceSessionId = f.sessionId

  const session = await f.run()
  assert.ok(session && !Array.isArray(session))
  assert.equal(session.sessionId, f.sessionId)
  assert.equal(f.generationQueries, 1)
  assert.equal(f.nonceQueries, 1)
  assert.equal(f.estimates, 1)
  assert.equal(f.sends, 1)
})

test('openV3: a committed journal remains readable while the proof route is unavailable', async () => {
  const f = fixture('openV3')
  const first = await f.run()
  assert.ok(first && !Array.isArray(first))
  f.gatewayDisabled = true

  const recovered = await f.run()
  assert.ok(recovered && !Array.isArray(recovered))
  assert.equal(recovered.sessionId, f.sessionId)
  assert.equal(f.generationQueries, 1)
  assert.equal(f.nonceQueries, 1)
  assert.equal(f.estimates, 1)
  assert.equal(f.sends, 1)
})

test('refundV3 remains available while the proof route is unavailable', async () => {
  const f = fixture('refundV3')
  f.gatewayDisabled = true
  await f.run()
  assert.equal(f.estimates, 1)
  assert.equal(f.sends, 1)
})

test('openV3: a newer generation cannot replace an unresolved frozen request', async () => {
  const f = fixture('openV3')
  f.loseReceipt = true
  await assert.rejects(f.run(), /outcome is unresolved/)
  const newer = f.advanceGeneration()
  f.nonceSessionId = f.sessionId

  await assert.rejects(f.runOpenV3(newer), /another frozen v3 retrieval/)
  assert.equal(f.generationQueries, 1)
  assert.equal(f.nonceQueries, 1)
  assert.equal(f.estimates, 1)
  assert.equal(f.sends, 1)
  assert.equal(f.store.get<transactions.BrowserTransaction<{ authority: retrievalV3.FrozenGenerationV3 }>>(f.key)?.intent.authority.generation, 1n)
  const resumed = await f.run()
  assert.ok(resumed && !Array.isArray(resumed))
  assert.equal(resumed.authority.generation, 1n)
  assert.equal(f.estimates, 1)
  assert.equal(f.sends, 1)
})
