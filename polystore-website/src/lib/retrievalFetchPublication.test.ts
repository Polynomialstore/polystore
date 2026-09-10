import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as publication from './retrievalDownloadPublication'

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
    '../config': { appConfig: { cosmosChainId: 'chain' } },
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
