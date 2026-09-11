import test from 'node:test'
import assert from 'node:assert/strict'
import { RetrievalProgress, startRetrievalWatchdog } from '../../tests/utils/retrievalProgress'

test('unique output and terminal sessions advance; duplicate writes, ACK, fetch and retry do not', () => {
  let now = 0
  const p = new RetrievalProgress(() => now)
  p.enter('retrieval')
  p.event({ phase: 'verified_write', atMs: 0, offset: 0, bytes: 10 })
  now = 590_000
  p.event({ phase: 'verified_write', atMs: now, offset: 0, bytes: 10 })
  p.event({ phase: 'acked', atMs: now, sessionIds: ['same'] })
  p.event({ phase: 'verified_window', atMs: now, sessionId: 'same' })
  for (let retry = 0; retry < 2; retry++) {
    for (const chunkId of ['0:0:56', '0:64:64']) p.event({ phase: 'verified_chunk', atMs: now, sessionId: 'same', chunkId, slot: 0 })
    p.event({ phase: 'acked_obligation', atMs: now, sessionId: 'same', slot: 0 })
  }
  assert.equal(p.snapshot().verifiedChunks, 2)
  assert.equal(p.snapshot().ackedObligations, 1)
  assert.equal(p.snapshot().ackedSessions, 1)
  now = 600_000; assert.throws(() => p.check(), /stalled/)
  p.event({ phase: 'verified_write', atMs: now, offset: 5, bytes: 10 })
  assert.equal(p.writtenBytes, 15); p.check()
  now += 590_000; p.completed('a', '12'); p.check()
  now += 590_000; p.completed('a', '12'); p.check()
  now += 10_000; assert.throws(() => p.check(), /stalled/)
  p.enter('final_hash'); now += 590_000; p.advance(1); p.check()
  now += 600_000; assert.throws(() => p.check(), /final_hash/)
})

test('heartbeat and watchdog survive download event; failure and explicit cleanup stop timers', () => {
  let now = 0, tick: () => void = () => {}, cleared = 0, beats = 0, failures = 0
  const timers = { setInterval: ((fn: () => void) => { tick = fn; return 1 }) as unknown as typeof setInterval,
    clearInterval: (() => { cleared++ }) as typeof clearInterval }
  const p = new RetrievalProgress(() => now)
  p.enter('await_download_stream')
  const stop = startRetrievalWatchdog(p, () => beats++, () => failures++, timers, () => now)
  tick(); now = 60_000; tick(); assert.equal(beats, 2)
  now = 600_000; tick(); assert.equal(failures, 1); assert.equal(cleared, 1)
  tick(); stop(); assert.equal(failures, 1); assert.equal(cleared, 1)
  const cleanup = startRetrievalWatchdog(new RetrievalProgress(() => now), () => beats++, () => failures++, timers, () => now)
  cleanup(); tick(); assert.equal(cleared, 2); assert.equal(failures, 1)
})


test('absolute retrieval budget includes a progressing final stream', () => {
  let now = 0
  const p = new RetrievalProgress(() => now)
  p.startRetrieval(30 * 60_000)
  now = 590_000; p.advance(1); p.check()
  p.enter('final_download_hash')
  now += 590_000; p.advance(2); p.check()
  now += 590_000; p.advance(3); p.check()
  now = 30 * 60_000; p.advance(4)
  assert.throws(() => p.check(), /execution budget/)
})
