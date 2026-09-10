import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as publication from './retrievalDownloadPublication'
import * as retrievalV3 from './retrievalV3'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(staleUnbound = false) {
  const root = `0x${'34'.repeat(32)}`
  const handoffStarted = deferred<void>()
  const firstHandoff = deferred<() => Promise<void>>()
  const retained = [0, 0], cleaned = [0, 0]
  const revoked: string[] = [], published: Array<string | null> = []
  let opened = 0, objectUrls = 0, stateIndex = 0, refIndex = 0
  const active = { current: null as AbortController | null }
  const saved = { current: null as { url: string; cleanup: () => Promise<void> } | null }
  const settledSession = { lockedFee: 0n }
  const savedV3 = {
    authority: { chainId: 'chain', dealId: 1n, generation: 2n, owner: 'owner', polyfsRoot: root }, file: { path: 'file.bin' },
    rangeStart: 0n, rangeLength: 4n, length: 4n, ...staleUnbound ? {} : { session: settledSession },
  }
  const lockedV3 = { ...savedV3, session: settledSession }
  const checkpoint = (index: number) => ({
    state: lockedV3, cursors: {},
    output: { file: async () => new Blob([`file-${index}`]) },
    handoff: async () => {
      if (index === 0) { handoffStarted.resolve(); return firstHandoff.promise }
      return async () => { cleaned[index]++ }
    },
    retain: async () => { retained[index]++ },
  })
  const payment = { requireWallet: () => ({ owner: 'owner' }), scope: () => ['owner'], unavailableReason: undefined }
  const modules: Record<string, unknown> = {
    '../lib/retrievalDiagnostics': { retrievalDiagnostic: () => {}, timeRetrieval: (_name: string, work: () => unknown) => work() },
    react: {
      useEffect: () => {},
      useRef: () => refIndex++ === 0 ? active : saved,
      useState: (initial: unknown) => {
        const index = stateIndex++
        return [initial, (value: unknown) => { if (index === 1) published.push(value as string | null) }]
      },
    },
    '../api/providerClient': {},
    '../config': { appConfig: { cosmosChainId: 'chain', gatewayDisabled: true, gatewayBase: '' } },
    '../domain/polyfsLayout': {}, '../lib/providerDiscovery': {}, '../lib/retrieval': {}, '../lib/retrievalFlow': {},
    '../lib/retrievalRecovery': {}, '../lib/retrievalMode': {}, '../lib/retrievalSettlement': {}, '../lib/transport/mode': {},
    '../lib/walletErrors': { classifyWalletError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }) },
    '../lib/worker-client': {}, '../lib/retrievalCheckpoint': {},
    '../lib/retrievalDownloadPublication': {
      handoffOwnedDownload: <T>(signal: AbortSignal, ownsDownload: () => boolean, url: string,
        handoff: () => Promise<(() => Promise<void>) | undefined>, publish: (cleanup: (() => Promise<void>) | undefined) => T) =>
        publication.handoffOwnedDownload(signal, ownsDownload, url, handoff, publish, (staleUrl) => { revoked.push(staleUrl) }),
    },
    '../lib/retrievalV3': {},
    '../lib/retrievalV3Checkpoint': {
      retrievalV3DownloadCheckpointKey: async () => `output-v3:${'12'.repeat(32)}`,
      readRetrievalV3Checkpoint: () => savedV3,
      assertRetrievalV3CheckpointScope: async () => {},
      hasSettledRetrievalV3Cache: () => true,
      openRetrievalV3Checkpoint: async () => checkpoint(opened++),
    },
    '../lib/retrievalV3Flow': { retrievalV3OutputComplete: () => true },
    '../lib/retrievalV3Recovery': {}, '../lib/retrievalV3Settlement': {},
    './useRetrievalSessions': { useRetrievalSessions: () => payment },
    './useTransportRouter': { useTransportRouter: () => ({}) },
  }
  const source = readFileSync(new URL('../hooks/useFetch.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { useFetch?: typeof import('../hooks/useFetch').useFetch } = {}
  const localUrl = { createObjectURL: () => `blob:${++objectUrls}`, revokeObjectURL: (url: string) => { revoked.push(url) } }
  new Function('require', 'exports', 'URL', code)((name: string) => {
    if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
    return modules[name]
  }, exports, localUrl)
  const hook = exports.useFetch!()
  const fetch = (generation = '2') => hook.fetchFile({ dealId: '1', generation, manifestRoot: root, owner: 'owner', filePath: 'file.bin' })
  return { fetch, handoffStarted: handoffStarted.promise,
    finishFirstHandoff: () => firstHandoff.resolve(async () => { cleaned[0]++ }), retained, cleaned, revoked, published }
}

test('normal file click cannot reuse a same-root checkpoint from an older generation', async () => {
  const f = fixture()
  await assert.rejects(f.fetch('3'), /prior frozen generation/)
})

test('useFetch reaches the legacy path when the real generation-v3 query returns 404', async () => {
  let legacyQueries = 0, v3Payments = 0, refIndex = 0, v3Queries = 0
  const active = { current: null as AbortController | null }
  const saved = { current: null as { url: string; cleanup: () => Promise<void> } | null }
  const modules: Record<string, unknown> = {
    '../lib/retrievalDiagnostics': { retrievalDiagnostic: () => {}, timeRetrieval: (_name: string, work: () => unknown) => work() },
    react: { useEffect: () => {}, useRef: () => refIndex++ === 0 ? active : saved, useState: (initial: unknown) => [initial, () => {}] },
    '../api/providerClient': {},
    '../config': { appConfig: { cosmosChainId: 'chain', lcdBase: 'https://lcd.example' } },
    '../domain/polyfsLayout': {}, '../lib/providerDiscovery': {},
    '../lib/retrieval': {
      account: (value: string) => value,
      fetchActiveRetrievalGeneration: async () => { legacyQueries++; throw new Error('legacy-v2-reached') },
    },
    '../lib/retrievalFlow': {}, '../lib/retrievalRecovery': {}, '../lib/retrievalMode': {}, '../lib/retrievalSettlement': {},
    '../lib/transport/mode': {},
    '../lib/walletErrors': { classifyWalletError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }) },
    '../lib/worker-client': { workerClient: { initRetrievalWasm: async () => {} } },
    '../lib/retrievalCheckpoint': {}, '../lib/retrievalDownloadPublication': {},
    '../lib/retrievalV3': {
      fetchActiveGenerationV3: (lcd: string, chainId: string, dealId: string, signal?: AbortSignal) =>
        retrievalV3.fetchActiveGenerationV3(lcd, chainId, dealId, signal, (async (url: string) => {
          assert.match(url, /\/generation-v3$/)
          v3Queries++
          return new Response('', { status: 404 })
        }) as typeof fetch),
    },
    '../lib/retrievalV3Checkpoint': {
      retrievalV3DownloadCheckpointKey: async () => `output-v3:${'12'.repeat(32)}`,
      readRetrievalV3Checkpoint: () => undefined,
      hasSettledRetrievalV3Cache: () => false,
    },
    '../lib/retrievalV3Flow': {}, '../lib/retrievalV3Recovery': {}, '../lib/retrievalV3Settlement': {},
    './useRetrievalSessions': { useRetrievalSessions: () => ({
      requireWallet: () => ({ owner: 'owner' }), scope: () => ['owner'], unavailableReason: undefined,
      openV3: async () => { v3Payments++; throw new Error('unexpected v3 payment') },
    }) },
    './useTransportRouter': { useTransportRouter: () => ({}) },
  }
  const source = readFileSync(new URL('../hooks/useFetch.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { useFetch?: typeof import('../hooks/useFetch').useFetch } = {}
  new Function('require', 'exports', code)((name: string) => {
    if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
    return modules[name]
  }, exports)
  const hook = exports.useFetch!()
  await assert.rejects(hook.fetchFile({ dealId: '1', generation: '2', manifestRoot: `0x${'34'.repeat(32)}`, owner: 'owner', filePath: 'file.bin' }), /legacy-v2-reached/)
  assert.equal(v3Queries, 1)
  assert.equal(legacyQueries, 1)
  assert.equal(v3Payments, 0)
})

for (const row of [
  { configured: 'http://localhost:8080', probed: 'http://127.0.0.1:8080' },
  { configured: 'http://localhost:18080', probed: 'http://127.0.0.1:8080' },
] as const) {
  test(`useFetch submits v3 proof through probed ${row.probed} instead of configured ${row.configured}`, async () => {
    const root = `0x${'34'.repeat(32)}`, sessionId = `0x${'12'.repeat(32)}`
    const file = { path: 'file.bin', start_offset: 0n, size_bytes: 4n, flags: 0 }
    const authority = { chainId: 'chain', dealId: 1n, generation: 2n, owner: 'owner', polyfsRoot: root,
      providers: ['provider'], metadataMdus: 2n, userMdus: 1n, totalMdus: 3n, witnessMdus: 1n }
    const session = { sessionId, authority, owner: 'owner', lockedFee: 1n,
      obligations: [{ slot: 0, payee: 'provider' }] }
    const proofBases: string[] = []
    let refIndex = 0
    const active = { current: null as AbortController | null }
    const saved = { current: null as { url: string; cleanup: () => Promise<void> } | null }
    const checkpoint = {
      state: {} as { session?: typeof session }, cursors: {},
      output: { file: async () => new Blob(['data']) },
      bind(value: typeof session) { this.state.session = value }, refresh: () => {}, retain: async () => {},
      handoff: async () => async () => {},
    }
    const payment = {
      requireWallet: () => ({ owner: 'owner' }), scope: () => ['owner'], unavailableReason: undefined,
      openV3: async () => session, readyV3: async (value: typeof session) => value,
      observeV3: async (value: typeof session) => value, acknowledgeV3: async (value: typeof session) => value,
      forgetV3: async () => {}, discardUnboundV3: async () => {},
    }
    const modules: Record<string, unknown> = {
      '../lib/retrievalDiagnostics': { retrievalDiagnostic: () => {}, timeRetrieval: (_name: string, work: () => unknown) => work() },
      react: { useEffect: () => {}, useRef: () => refIndex++ === 0 ? active : saved, useState: (initial: unknown) => [initial, () => {}] },
      '../api/providerClient': {},
      '../config': { appConfig: { cosmosChainId: 'chain', lcdBase: 'https://lcd.example', gatewayDisabled: false,
        gatewayBase: row.configured, spBase: '' } },
      '../domain/polyfsLayout': {}, '../lib/providerDiscovery': {},
      '../lib/retrieval': { account: (value: string) => value, u64: (value: string) => BigInt(value) },
      '../lib/retrievalFlow': { validateRetrievalAllocation: () => {} }, '../lib/retrievalRecovery': {},
      '../lib/retrievalMode': { readLocalGatewayConnectedBase: () => row.probed, readLocalGatewayConnectedHint: () => true },
      '../lib/retrievalSettlement': {}, '../lib/transport/mode': await import('./transport/mode'),
      '../lib/walletErrors': { classifyWalletError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }) },
      '../lib/worker-client': { workerClient: { initRetrievalWasm: async () => {}, verifyRetrievalDataV3: async () => {} } },
      '../lib/retrievalCheckpoint': {},
      '../lib/retrievalDownloadPublication': { handoffOwnedDownload: async (_signal: AbortSignal, _owns: () => boolean, _url: string,
        handoff: () => Promise<unknown>, publish: (cleanup: unknown) => unknown) => publish(await handoff()) },
      '../lib/retrievalV3': {
        fetchActiveGenerationV3: async () => authority,
        generationAsPinnedV2Shape: () => ({}),
        planV3Chunks: () => [{ slot: 0 }][Symbol.iterator](),
      },
      '../lib/retrievalV3Checkpoint': {
        retrievalV3DownloadCheckpointKey: async () => `output-v3:${'12'.repeat(32)}`,
        readRetrievalV3Checkpoint: () => undefined, hasSettledRetrievalV3Cache: () => false,
        openRetrievalV3Checkpoint: async () => checkpoint,
      },
      '../lib/retrievalV3Flow': { executeRetrievalV3: async (_session: unknown, _checkpoint: unknown,
        options: { requestProof: (current: typeof session, slot: number) => Promise<unknown> }) => {
        const outcome = await options.requestProof(session, 0)
        return { session: { ...session, lockedFee: 0n }, outcomes: [outcome] }
      } },
      '../lib/retrievalV3Recovery': {},
      '../lib/retrievalV3Settlement': { requestRetrievalProofV3: async (base: string) => {
        proofBases.push(base)
        return { state: 'accepted', sessionId }
      } },
      './useRetrievalSessions': { useRetrievalSessions: () => payment },
      './useTransportRouter': { useTransportRouter: () => ({ allowsV3Direct: () => false,
        fetchV3Metadata: async () => ({ data: [file] }) }) },
    }
    const source = readFileSync(new URL('../hooks/useFetch.ts', import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: { useFetch?: typeof import('../hooks/useFetch').useFetch } = {}
    const localUrl = { createObjectURL: () => 'blob:1', revokeObjectURL: () => {} }
    new Function('require', 'exports', 'URL', code)((name: string) => {
      if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
      return modules[name]
    }, exports, localUrl)
    const result = await exports.useFetch!().fetchFile({ dealId: '1', generation: '2', manifestRoot: root, owner: 'owner', filePath: file.path })
    assert.equal(result.url, 'blob:1')
    assert.deepEqual(proofBases, [row.probed])
  })
}

test('saved v3 recovery refreshes state after acquiring its checkpoint lock', async () => {
  const f = fixture(true)
  const pending = f.fetch()
  await Promise.race([f.handoffStarted, pending.then(() => { throw new Error('fetch completed before handoff') })])
  f.finishFirstHandoff()
  const result = await pending
  assert.equal(result.route, 'browser_v3_cache')
  assert.deepEqual(f.published, ['blob:1'])
  await result.cleanup?.()
})

test('settled v3 cache publication completes before the enclosing checkpoint finally', async () => {
  const f = fixture()
  const pending = f.fetch()
  await Promise.race([f.handoffStarted, pending.then(() => { throw new Error('fetch completed before handoff') })])
  assert.deepEqual(f.retained, [0, 0])
  f.finishFirstHandoff()

  const result = await pending
  assert.equal(result.url, 'blob:1')
  assert.equal(result.route, 'browser_v3_cache')
  assert.deepEqual(f.published, ['blob:1'])
  assert.deepEqual(f.retained, [0, 0])
  await result.cleanup?.()
  assert.deepEqual(f.revoked, ['blob:1'])
  assert.deepEqual(f.cleaned, [1, 0])
})

test('replacement during a deferred v3 cache handoff cannot publish the stale URL', async () => {
  const f = fixture()
  const stale = f.fetch()
  await Promise.race([f.handoffStarted, stale.then(() => { throw new Error('fetch completed before handoff') })])
  const current = await f.fetch()
  assert.equal(current.url, 'blob:2')
  f.finishFirstHandoff()

  await assert.rejects(stale, /abort/i)
  assert.deepEqual(f.published, ['blob:2'])
  assert.equal(f.revoked.filter((url) => url === 'blob:1').length, 1)
  assert.deepEqual(f.cleaned, [1, 0])
  assert.deepEqual(f.retained, [0, 0])
  await current.cleanup?.()
  assert.deepEqual(f.revoked, ['blob:1', 'blob:2'])
  assert.deepEqual(f.cleaned, [1, 1])
})
