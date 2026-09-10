import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as retrievalMode from './retrievalMode'
import * as transportMode from './transport/mode'
import * as v3Candidates from './transport/v3Candidates'

function fixture(configuredBase: string, fetchFn: (url: string) => Promise<Response>) {
  const values = new Map<string, string>()
  let cleanup: (() => void) | undefined
  let timer: (() => void) | undefined
  const waiters = new Map<string, Array<() => void>>()
  const published: string[] = []
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
      if (key === retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY) {
        published.push(value)
        for (const resolve of waiters.get(value) || []) resolve()
        waiters.delete(value)
      }
    },
    removeItem: (key: string) => { values.delete(key) },
  }
  const fakeWindow = { localStorage, setTimeout: (callback: () => void) => { timer = callback; return 1 }, clearTimeout: () => {} }
  const fakeDocument = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} }
  const modules: Record<string, unknown> = {
    react: {
      useState: (initial: unknown) => [initial, () => {}],
      useRef: (initial: unknown) => ({ current: initial }),
      useEffect: (effect: () => (() => void) | void) => { cleanup = effect() || undefined },
    },
    '../config': { appConfig: { gatewayBase: configuredBase, gatewayDisabled: false } },
    '../lib/transport/mode': transportMode,
    '../lib/retrievalMode': { persistLocalGatewayConnection: (base?: string) => {
      const clean = String(base || '').replace(/\/$/, '')
      if (transportMode.isTrustedLocalGatewayBase(clean)) {
        localStorage.setItem(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY, clean)
        localStorage.setItem(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY, '1')
      } else {
        localStorage.setItem(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY, '0')
        localStorage.removeItem(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY)
      }
    } },
  }
  const source = readFileSync(new URL('../hooks/useLocalGateway.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { useLocalGateway?: typeof import('../hooks/useLocalGateway').useLocalGateway } = {}
  new Function('require', 'exports', 'window', 'document', 'fetch', code)((name: string) => {
    if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
    return modules[name]
  }, exports, fakeWindow, fakeDocument, fetchFn)
  exports.useLocalGateway!()
  return { values, cleanup: () => cleanup?.(), runTimer: () => timer?.(),
    waitForBase: (base: string) => published.includes(base) ? Promise.resolve() : new Promise<void>((resolve) => {
      waiters.set(base, [...waiters.get(base) || [], resolve])
    }) }
}

for (const row of [
  { configured: 'http://localhost:8080', active: 'http://127.0.0.1:8080' },
  { configured: 'http://localhost:18080', active: 'http://127.0.0.1:8080' },
] as const) {
  test(`useLocalGateway persists probed ${row.active} instead of configured ${row.configured}`, async () => {
    const seen: string[] = []
    const f = fixture(row.configured, async (url) => {
      seen.push(url)
      if (url === `${row.active}/status`) return new Response('{"persona":"user-gateway"}', { status: 200 })
      throw new TypeError('unreachable')
    })
    await f.waitForBase(row.active)
    assert.ok(seen.includes(`${row.configured}/status`))
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), row.active)
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '1')
    f.cleanup()
  })
}

test('useLocalGateway refreshes the persisted base when a connected probe falls back', async () => {
  let fallback = false
  const f = fixture('http://localhost:8080', async (url) => {
    if (!fallback && url === 'http://localhost:8080/status') return new Response('{"persona":"user-gateway"}', { status: 200 })
    if (fallback && url === 'http://127.0.0.1:8080/status') return new Response('{"persona":"user-gateway"}', { status: 200 })
    throw new TypeError('unreachable')
  })
  await f.waitForBase('http://localhost:8080')
  fallback = true
  f.runTimer()
  await f.waitForBase('http://127.0.0.1:8080')
  assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), 'http://127.0.0.1:8080')
  f.cleanup()
})

test('an unmounted useLocalGateway probe cannot publish a late successful route', async () => {
  let resolve!: (response: Response) => void
  const response = new Promise<Response>((done) => { resolve = done })
  const f = fixture('http://localhost:8080', async () => response)
  f.cleanup()
  resolve(new Response('{"persona":"user-gateway"}', { status: 200 }))
  await response
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '0')
  assert.equal(f.values.has(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), false)
})

test('useTransportRouter reads the current probed base for each v3 metadata and chunk request', async () => {
  let connectedBase = 'http://localhost:8080'
  const requested: string[] = []
  class TransportError extends Error {}
  class TransportTraceError extends Error { trace = {} }
  const modules: Record<string, unknown> = {
    '../lib/retrievalDiagnostics': { timeRetrieval: (_name: string, work: () => unknown) => work() },
    react: { useCallback: (callback: unknown) => callback, useMemo: (factory: () => unknown) => factory() },
    '../api/gatewayClient': {},
    '../api/providerClient': {
      gatewayFetchRetrievalMetadata: async (base: string) => { requested.push(`metadata:${base}`); return new Uint8Array() },
      fetchRetrievalChunkV3: async (base: string) => { requested.push(`chunk:${base}`); return {} },
    },
    '../config': { appConfig: { gatewayBase: 'http://localhost:18080', gatewayDisabled: false, p2pEnabled: false } },
    '../context/TransportContext': { useTransportContext: () => ({ preference: 'gateway_only', lastTrace: null,
      setLastTrace: () => {}, setPreference: () => {} }) },
    '../lib/retrievalV3': { generationAsPinnedV2Shape: () => ({}) },
    '../lib/transport/errors': { classifyStatus: () => 'network', TransportError },
    '../lib/transport/libp2pClient': {},
    '../lib/transport/mode': transportMode,
    '../lib/transport/router': { TransportTraceError, executeWithFallback: async (_operation: string,
      candidates: Array<{ backend: string; execute: (signal: AbortSignal) => Promise<unknown> }>) => ({
      backend: candidates[0].backend, data: await candidates[0].execute(new AbortController().signal), trace: {},
    }) },
    '../lib/transport/v3Candidates': v3Candidates,
    '../lib/worker-client': { workerClient: { verifyRetrievalMetadataV3: async () => [] } },
    '../lib/retrievalMode': { readLocalGatewayConnectedBase: () => connectedBase },
  }
  const source = readFileSync(new URL('../hooks/useTransportRouter.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { useTransportRouter?: typeof import('../hooks/useTransportRouter').useTransportRouter } = {}
  new Function('require', 'exports', 'window', code)((name: string) => {
    if (!(name in modules)) throw new Error('unexpected hook dependency: ' + name)
    return modules[name]
  }, exports, { localStorage: { getItem: () => '1' } })
  const hook = exports.useTransportRouter!()
  connectedBase = 'http://127.0.0.1:8080'
  await hook.fetchV3Metadata({ authority: {} as never, directBases: [], preference: 'gateway_only' })
  connectedBase = 'http://localhost:8080'
  await hook.fetchV3Chunk({ authority: {} as never, directBases: [], preference: 'gateway_only', chunk: {} as never, owner: 'owner' })
  assert.deepEqual(requested, ['metadata:http://127.0.0.1:8080', 'chunk:http://localhost:8080'])
})
