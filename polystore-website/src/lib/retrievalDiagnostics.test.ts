import test from 'node:test'
import assert from 'node:assert/strict'
import { retrievalDiagnostic, retrievalServerTiming, timeRetrieval, type RetrievalDiagnostic } from './retrievalDiagnostics'

test('optional diagnostics observe actual completion and never replace success or failure', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events: RetrievalDiagnostic[] = []
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __polystoreRetrievalDiagnostic: (event: RetrievalDiagnostic) => events.push(event) } })
    assert.equal(await timeRetrieval('verify', async () => 7, 'session', { chunkId: '0:0:56', slot: 0 }), 7)
    assert.deepEqual(events.map((e) => [e.phase, e.edge, e.sessionId]), [['verify', 'start', 'session'], ['verify', 'end', 'session']])
    assert.ok(events[1].atMs >= events[0].atMs)
    assert.ok(events.every((e) => e.chunkId === '0:0:56' && e.slot === 0))
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

test('server timing accepts only bounded numeric phase observations without mixing clocks or roles', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events: RetrievalDiagnostic[] = []
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __polystoreRetrievalDiagnostic: (event: RetrievalDiagnostic) => events.push(event) } })
    const context = { sessionId: 'session', chunkId: '0:0:0', slot: 0 }
    retrievalServerTiming('ps3p_lcd;dur=12.500;desc="2", ps3g_lcd;dur=3.000;desc="2", ps3p_lcd;dur=99.000;desc="2", secret_key;dur=5;desc="private", ps3p_read;dur=1;desc="secret"', context)
    assert.deepEqual(events.map((e) => [e.phase, e.durationMs, e.calls]), [['server_provider_lcd', 12.5, 2], ['server_gateway_lcd', 3, 2]])
    assert.ok(events.every((e) => e.sessionId === 'session' && e.chunkId === '0:0:0' && e.edge === undefined))
    retrievalServerTiming('x'.repeat(4097), context)
    retrievalServerTiming('ps3p_lcd;dur=9999999999;desc="2", ps3p_lcd;dur=2;desc="0"', context)
    assert.equal(events.length, 2)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
