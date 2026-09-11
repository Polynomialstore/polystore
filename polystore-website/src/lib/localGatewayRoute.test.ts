import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as retrievalMode from './retrievalMode'
import * as transportMode from './transport/mode'
import * as v3Candidates from './transport/v3Candidates'

const qualifiedStatus = JSON.stringify({ persona: 'user-gateway', allowed_route_families: ['gateway'],
  capabilities: { retrieval_session_proof_continue: true } })

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

function fixture(configuredBase: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
  const values = new Map<string, string>()
  let cleanup: (() => void) | undefined
  let timer: (() => void) | undefined
  const waiters = new Map<string, Array<() => void>>()
  const published: string[] = []
  const stateValues: unknown[] = []
  let stateIndex = 0
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
      useState: (initial: unknown) => {
        const index = stateIndex
        stateIndex += 1
        stateValues[index] = initial
        return [initial, (next: unknown) => { stateValues[index] = next }]
      },
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
    }, persistLocalGatewayLiveness: () => {
      localStorage.setItem(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY, '1')
      localStorage.removeItem(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY)
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
  return { values, published, status: () => stateValues[0], cleanup: () => cleanup?.(), runTimer: () => timer?.(),
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
    const redirects: Array<RequestRedirect | undefined> = []
    const f = fixture(row.configured, async (url, init) => {
      seen.push(url)
      redirects.push(init?.redirect)
      if (url === `${row.active}/status`) return new Response(qualifiedStatus, { status: 200 })
      throw new TypeError('unreachable')
    })
    await f.waitForBase(row.active)
    assert.ok(seen.includes(`${row.configured}/status`))
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), row.active)
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '1')
    assert.ok(redirects.every((redirect) => redirect === 'error'))
    f.cleanup()
  })
}

test('useLocalGateway refreshes the persisted base when a connected probe falls back', async () => {
  let fallback = false
  const f = fixture('http://localhost:8080', async (url) => {
    if (!fallback && url === 'http://localhost:8080/status') return new Response(qualifiedStatus, { status: 200 })
    if (fallback && url === 'http://127.0.0.1:8080/status') return new Response(qualifiedStatus, { status: 200 })
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
  resolve(new Response(qualifiedStatus, { status: 200 }))
  await response
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '0')
  assert.equal(f.values.has(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), false)
})

for (const row of [
  { name: 'invalid JSON', body: '{' },
  { name: 'null', body: 'null' },
  { name: 'array', body: '[]' },
  { name: 'empty object', body: '{}' },
  { name: 'wrong persona', body: JSON.stringify({ persona: 'provider-daemon', allowed_route_families: ['gateway'] }) },
  { name: 'missing route families', body: JSON.stringify({ persona: 'user-gateway' }) },
  { name: 'near-match route family', body: JSON.stringify({ persona: 'user-gateway', allowed_route_families: ['user-gateway', 'gateway/retrieval'] }) },
  { name: 'missing retrieval continuation capability', body: JSON.stringify({ persona: 'user-gateway', allowed_route_families: ['gateway'] }) },
] as const) {
  test(`useLocalGateway does not publish ${row.name} status and still discovers a qualified fallback`, async () => {
    const configured = 'http://localhost:18080'
    const fallback = 'http://127.0.0.1:8080'
    const f = fixture(configured, async (url) => {
      if (url === `${configured}/status`) return new Response(row.body, { status: 200 })
      if (url === `${fallback}/status`) return new Response(qualifiedStatus, { status: 200 })
      throw new TypeError('unreachable')
    })
    await f.waitForBase(fallback)
    assert.equal(f.published.includes(configured), false)
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), fallback)
    f.cleanup()
  })
}

test('health-only liveness does not authorize payment and a later valid status upgrades it', async () => {
  const configured = 'http://localhost:18080'
  let qualified = false
  const f = fixture(configured, async (url) => {
    if (url === `${configured}/status`) {
      return qualified ? new Response(qualifiedStatus, { status: 200 }) : new Response(null, { status: 404 })
    }
    if (url === `${configured}/health`) return new Response(null, { status: 200 })
    throw new TypeError('unreachable')
  })
  await eventually(() => f.status() === 'connected')
  assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '1')
  assert.equal(f.values.has(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), false)

  qualified = true
  f.runTimer()
  await f.waitForBase(configured)
  assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '1')
  f.cleanup()
})

test('a connected gateway that becomes unqualified loses payment eligibility', async () => {
  const configured = 'http://localhost:8080'
  let qualified = true
  const f = fixture(configured, async (url) => {
    if (url.endsWith('/status')) {
      return new Response(qualified ? qualifiedStatus : '{}', { status: 200 })
    }
    throw new TypeError('unreachable')
  })
  await f.waitForBase(configured)
  qualified = false
  f.runTimer()
  await eventually(() => f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY) === '0')
  assert.equal(f.values.has(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), false)
  f.cleanup()
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
