import test from 'node:test'
import assert from 'node:assert/strict'
import { retrievalDiagnostic, timeRetrieval, type RetrievalDiagnostic } from './retrievalDiagnostics'

test('optional diagnostics observe actual completion and never replace success or failure', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events: RetrievalDiagnostic[] = []
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __polystoreRetrievalDiagnostic: (event: RetrievalDiagnostic) => events.push(event) } })
    assert.equal(await timeRetrieval('verify', async () => 7, 'session'), 7)
    assert.deepEqual(events.map((e) => [e.phase, e.edge, e.sessionId]), [['verify', 'start', 'session'], ['verify', 'end', 'session']])
    assert.ok(events[1].atMs >= events[0].atMs)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __polystoreRetrievalDiagnostic: () => { throw new Error('observer unavailable') } } })
    retrievalDiagnostic({ phase: 'write', bytes: 1 })
    assert.equal(await timeRetrieval('verify', async () => 8), 8)
    const failure = new Error('verification failed')
    await assert.rejects(timeRetrieval('verify', async () => { throw failure }), (error) => error === failure)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
