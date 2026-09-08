import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { WasmBlstKzgCommitBackend } from './kzgCommitBackend'
import { parsePolyfsFilesFromMdu0 } from './polyfsLocal'

test('actual worker and maintained WASM preserve metadata after failed or overlapping operations', async (t) => {
  const binary = await readFile(new URL('../../public/wasm/polystore_core_bg.wasm', import.meta.url))
  const trustedSetupBytes = new Uint8Array(await readFile(new URL('../../public/trusted_setup.txt', import.meta.url)))
  const replies = new Map<number, { type: string; payload: unknown }>()
  const scope = {
    location: { origin: 'http://metadata.test' },
    onmessage: undefined as unknown as (event: { data: { id: number; type: string; payload: unknown } }) => Promise<void>,
    postMessage(reply: { id: number; type: string; payload: unknown }) { replies.set(reply.id, reply) },
  }
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope })
  t.after(() => {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
    else Reflect.deleteProperty(globalThis, 'self')
  })
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(String(url), 'http://metadata.test/wasm/polystore_core_bg.wasm')
    return new Response(binary, { headers: { 'content-type': 'application/wasm' } })
  })
  // Node has no nested browser workers; the production pool's existing fallback applies.
  t.mock.method(console, 'warn', () => {})
  await import('../workers/gateway.worker')
  let id = 0
  const send = async (type: string, payload: unknown = {}) => {
    const request = ++id
    await scope.onmessage({ data: { id: request, type, payload } })
    const reply = replies.get(request)
    replies.delete(request)
    assert.ok(reply, `missing worker response to ${type}`)
    if (reply.type === 'error') throw new Error(String(reply.payload))
    return reply.payload
  }
  await send('initPolyStoreWasm', { trustedSetupBytes })
  await send('initMdu0Builder', { maxUserMdus: 65536, commitmentsPerMdu: 96 })
  await send('appendFileToMdu0', { path: 'original', size: 1, startOffset: 0 })
  const before = await send('getMdu0Bytes')
  const digest = (bytes: unknown) => createHash('sha256').update(bytes as Uint8Array).digest('hex')
  const rootsFlat = new Uint8Array(64).fill(255)
  await assert.rejects(send('setMdu0RootsBatch', { startIndex: 65535, rootsFlat }))
  assert.equal(digest(await send('getMdu0Bytes')), digest(before), 'failed batch must preserve every root')
  await assert.rejects(send('loadMdu0Builder', { data: new Uint8Array(1), maxUserMdus: 1 }), /size|length/i)
  const prepare = { witnessRootsFlat: rootsFlat, userRootStartIndex: 2, path: 'next', size: 1, startOffset: 1 }
  await assert.rejects(send('prepareMdu0Bytes', { ...prepare, path: '../bad' }))
  await assert.rejects(send('appendFileToMdu0', { path: 'rounded', size: 1.5, startOffset: 0 }))
  assert.deepEqual(await send('getMdu0Bytes'), before)

  let entered!: () => void
  let failCommit!: (error: Error) => void
  const committing = new Promise<void>((resolve) => { entered = resolve })
  const failure = new Promise<never>((_, reject) => { failCommit = reject })
  // Hold the installed backend at its real async boundary; metadata/WASM are untouched.
  const backend = t.mock.method(WasmBlstKzgCommitBackend.prototype, 'commitBlobsProfiled', (() => {
    entered()
    return failure
  }) as unknown as WasmBlstKzgCommitBackend['commitBlobsProfiled'])
  const rejectedCommit = assert.rejects(send('prepareAndCommitMdu0', prepare), /injected commitment failure/)
  await committing
  await assert.rejects(send('appendFileToMdu0', { path: 'interloper', size: 1, startOffset: 2 }), /in progress/)
  await assert.rejects(send('initMdu0Builder', { maxUserMdus: 1 }), /in progress/)
  failCommit(new Error('injected commitment failure'))
  await rejectedCommit
  backend.mock.restore()
  assert.deepEqual(await send('getMdu0Bytes'), before)

  await send('prepareMdu0Bytes', prepare)
  const after = await send('getMdu0Bytes') as Uint8Array
  assert.deepEqual(parsePolyfsFilesFromMdu0(after).map((record) => record.path), ['original', 'next'])
  assert.notDeepEqual(after, before)
})
