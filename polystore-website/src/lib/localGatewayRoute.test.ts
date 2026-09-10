import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as retrievalMode from './retrievalMode'
import * as transportMode from './transport/mode'

function fixture(configuredBase: string, fetchFn: (url: string) => Promise<Response>) {
  const values = new Map<string, string>()
  let cleanup: (() => void) | undefined
  let connected!: () => void
  const connectedPromise = new Promise<void>((resolve) => { connected = resolve })
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
      if (key === retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY) connected()
    },
    removeItem: (key: string) => { values.delete(key) },
  }
  const fakeWindow = { localStorage, setTimeout: () => 1, clearTimeout: () => {} }
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
  return { values, connected: connectedPromise, cleanup: () => cleanup?.() }
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
    await f.connected
    assert.ok(seen.includes(`${row.configured}/status`))
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_BASE_KEY), row.active)
    assert.equal(f.values.get(retrievalMode.LOCAL_GATEWAY_CONNECTED_KEY), '1')
    f.cleanup()
  })
}

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
