import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import type { FrozenSession, PinnedGeneration } from './retrieval'
import { executeRetrievalWindows } from './retrievalFlow'
import { recoverRetrievalMdu } from './retrievalRecovery'
import { confirmAndRequestRetrievalProofs } from './retrievalSettlement'

const providerBase = 'https://provider.example'
const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))
const session = (n = 1): FrozenSession => ({ sessionId: `0x${n.toString(16).padStart(64, '0')}`, payee: address(n + 1), owner: address(99),
  pin: { dealId: 9007199254740993n + BigInt(n) }, window: { mduIndex: 2n, startBlobIndex: 0, blobCount: 1, provider: address(90), slices: [] } }) as unknown as FrozenSession
const txHash = 'A1'.repeat(32)
// Go writeSubmissionOutcome returns the canonical 0x-prefixed session ID.
const payload = (s: FrozenSession, status = 'success', hash = txHash) => ({ status, session_id: s.sessionId, proof_count: 1, tx_hash: hash, cleanup_status: 'complete' })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const confirm = async () => {}
const resolveProviderBase = async () => providerBase

test('four independent payees submit concurrently with bounded work and ordered outcomes', async () => {
  const sessions = Array.from({ length: 8 }, (_, i) => session(i + 1))
  const release: Array<() => void> = [], started: number[] = [], completed: number[] = []
  const gates = sessions.map((_, i) => new Promise<void>((resolve) => { release[i] = resolve }))
  let active = 0, peak = 0
  const work = confirmAndRequestRetrievalProofs(sessions, { resolveProviderBase, confirm,
    fetchFn: async (_, init) => {
      const index = sessions.findIndex((s) => s.sessionId === JSON.parse(String(init?.body)).session_id)
      started.push(index); peak = Math.max(peak, ++active)
      await gates[index]
      active--; completed.push(index)
      return json(payload(sessions[index]))
    },
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(started, [0, 1, 2, 3])
    for (const index of [3, 2, 1, 0]) release[index]()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(started.length, 8)
    assert.equal(peak, 4)
    assert.deepEqual(completed, [3, 2, 1, 0])
  } finally {
    release.forEach((resolve) => resolve())
    await work
  }
  assert.deepEqual((await work).map((outcome) => [outcome.sessionId, outcome.state]), sessions.map((s) => [s.sessionId, 'committed']))
})

test('sessions sharing a frozen deputy remain serial while distinct payees make progress', async () => {
  const sessions = [session(1), { ...session(2), payee: session(1).payee }, session(3)]
  let releaseFirst!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const started: string[] = [], active = new Set<string>(), resolutions = new Map<string, number>()
  const work = confirmAndRequestRetrievalProofs(sessions, { resolveProviderBase: async (payee) => {
    resolutions.set(payee, (resolutions.get(payee) ?? 0) + 1)
    return providerBase
  }, confirm,
    fetchFn: async (_, init) => {
      const s = sessions.find((s) => s.sessionId === JSON.parse(String(init?.body)).session_id)!
      assert.equal(active.has(s.payee), false)
      active.add(s.payee); started.push(s.sessionId)
      if (s === sessions[0]) await first
      active.delete(s.payee)
      return json(payload(s))
    },
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(started, [sessions[0].sessionId, sessions[2].sessionId])
  } finally {
    releaseFirst()
    await work
  }
  assert.deepEqual(started, [sessions[0].sessionId, sessions[2].sessionId, sessions[1].sessionId])
  assert.deepEqual([...resolutions.entries()].sort(), [[sessions[0].payee, 1], [sessions[2].payee, 1]].sort())
  assert.deepEqual((await work).map((outcome) => outcome.sessionId), sessions.map((s) => s.sessionId))
})

test('ACK commits before singular requests, preserving each immutable deputy and exact deal ID', async () => {
  const sessions = [session(1), session(2)], events: string[] = []
  const outcomes = await confirmAndRequestRetrievalProofs(sessions, {
    resolveProviderBase: async (provider) => { assert.ok(sessions.some((session) => session.payee === provider)); return providerBase },
    confirm: async (wave) => { assert.equal(wave, sessions); events.push('ACK') }, onConfirmed: () => events.push('confirmed'),
    fetchFn: async (url, init) => {
      const s = sessions.find((session) => session.sessionId === JSON.parse(String(init?.body)).session_id)!
      assert.deepEqual(events.slice(0, 2), ['ACK', 'confirmed'])
      assert.equal(String(url), `${providerBase}/sp/retrieval/session-proof/continue`)
      assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal)
      assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' })
      assert.deepEqual(JSON.parse(String(init?.body)), { session_id: s.sessionId })
      assert.notEqual(s.payee, s.window.provider)
      events.push('POST'); return json(payload(s))
    },
  })
  assert.deepEqual(events, ['ACK', 'confirmed', 'POST', 'POST'])
  assert.deepEqual(outcomes.map((o) => o.state), ['committed', 'committed'])
})

test('healthy user-gateway is the only continuation route and direct provider is the absent-gateway fallback', async () => {
  const s = session()
  let resolutions = 0
  const gatewayBase = 'http://127.0.0.1:8080'
  const [throughGateway] = await confirmAndRequestRetrievalProofs([s], {
    gatewayBase,
    resolveProviderBase: async () => { resolutions++; return providerBase },
    confirm,
    fetchFn: async (url, init) => {
      assert.equal(String(url), `${gatewayBase}/gateway/retrieval/session-proof/continue`)
      assert.deepEqual(JSON.parse(String(init?.body)), { session_id: s.sessionId })
      return json(payload(s))
    },
  })
  assert.equal(throughGateway.state, 'committed')
  assert.equal(resolutions, 0)

  const [gatewayFailure] = await confirmAndRequestRetrievalProofs([s], {
    gatewayBase,
    resolveProviderBase: async () => { resolutions++; return providerBase },
    confirm,
    fetchFn: async (url) => {
      assert.equal(String(url), `${gatewayBase}/gateway/retrieval/session-proof/continue`)
      throw new Error('gateway response lost')
    },
  })
  assert.equal(gatewayFailure.state, 'pending')
  assert.equal(gatewayFailure.responseUnknown, true)
  assert.equal(resolutions, 0)

  const [direct] = await confirmAndRequestRetrievalProofs([s], {
    resolveProviderBase: async () => { resolutions++; return providerBase },
    confirm,
    fetchFn: async (url) => {
      assert.equal(String(url), `${providerBase}/sp/retrieval/session-proof/continue`)
      return json(payload(s))
    },
  })
  assert.equal(direct.state, 'committed')
  assert.equal(resolutions, 1)
})

test('failed ACK never submits a proof request', async () => {
  let posts = 0
  await assert.rejects(confirmAndRequestRetrievalProofs([session()], {
    resolveProviderBase, confirm: async () => { throw new Error('ACK failed') },
    fetchFn: async () => { posts++; throw new Error('unexpected POST') },
  }), /ACK failed/)
  assert.equal(posts, 0)
})

test('actual wave sequencing never posts before verified writes and flush, including failed ACK', async () => {
  for (const fail of ['', 'verify', 'write', 'flush', 'ACK']) {
    const s = session(), events: string[] = []
    const step = (name: string) => { events.push(name); if (fail === name) throw new Error(name) }
    const work = executeRetrievalWindows([s.window], {
      open: async () => [s], fetchAndVerify: async () => { step('verify'); return new Uint8Array([1]) },
      consume: async () => { step('write') }, flush: async () => { step('flush') },
      confirm: async (wave) => { await confirmAndRequestRetrievalProofs(wave, { resolveProviderBase,
        confirm: async () => { step('ACK') }, fetchFn: async () => { step('POST'); return json(payload(s)) },
      }) },
    })
    if (fail) { await assert.rejects(work); assert.ok(!events.includes('POST'), fail) }
    else { await work; assert.deepEqual(events, ['verify', 'write', 'flush', 'ACK', 'POST']) }
  }
})

test('recovery submits only after reconstructed output persists and ACK commits', async () => {
  const pin: PinnedGeneration = { ...session().pin, layout: 2, k: 2, m: 1, rows: 32, leafCount: 96, metadataMdus: 2n, userMdus: 1n,
    assignments: Array.from({ length: 3 }, (_, i) => ({ provider: address(i + 1), active: true })) }
  for (const fail of ['', 'reconstruct', 'write', 'flush', 'ACK', 'POST']) {
    const events: string[] = []
    const step = (name: string) => { events.push(name); if (fail === name) throw new Error(name) }
    const work = recoverRetrievalMdu(pin, 0n, {
      open: async (windows) => windows.map((window, i) => ({ ...session(i + 1), pin, window })),
      fetchAndVerify: async () => new Uint8Array(pin.rows * 131072),
      reconstructAndVerify: async () => { step('reconstruct'); return new Uint8Array(8388608) },
      consumeAndFlush: async () => { step('write'); step('flush') },
      confirm: async (sessions) => {
        const outcomes = await confirmAndRequestRetrievalProofs(sessions, { resolveProviderBase,
          confirm: async () => { step('ACK') }, fetchFn: async (_, init) => {
            step('POST'); const s = sessions.find((s) => s.sessionId === JSON.parse(String(init?.body)).session_id)!
            return json({ ...payload(s), proof_count: pin.rows })
          },
        })
        assert.deepEqual(outcomes.map((o) => o.state), fail === 'POST' ? ['pending', 'pending'] : ['committed', 'committed'])
      },
    })
    if (fail && fail !== 'POST') { await assert.rejects(work); assert.ok(!events.includes('POST'), fail) }
    else { assert.equal((await work).length, 8388608); assert.deepEqual(events, ['reconstruct', 'write', 'flush', 'ACK', 'POST', 'POST']) }
  }
})

test('committed, reconciled, pending known/unknown and explicit failure remain distinct', async () => {
  const s = session()
  for (const [status, hash, code, state] of [
    ['success', txHash, 200, 'committed'], ['reconciled', '', 200, 'committed'],
    ['pending', txHash, 202, 'pending'], ['pending', '', 202, 'pending'], ['failed', txHash, 409, 'failed'],
  ] as const) {
    const [outcome] = await confirmAndRequestRetrievalProofs([s], { resolveProviderBase, confirm, fetchFn: async () => json(payload(s, status, hash), code) })
    assert.equal(outcome.state, state); assert.equal(outcome.txHash, hash || undefined)
    if (state === 'pending') { assert.match(outcome.message!, /Reconcile this same session/); assert.match(outcome.message!, hash ? /A1A1/ : /outcome unknown/) }
  }
  const [rejected] = await confirmAndRequestRetrievalProofs([s], { resolveProviderBase, confirm, fetchFn: async () => json({ error: 'forbidden' }, 403) })
  assert.equal(rejected.state, 'failed'); assert.match(rejected.message!, /403.*forbidden/)
  const [lost] = await confirmAndRequestRetrievalProofs([s], { resolveProviderBase, confirm, fetchFn: async () => json({ error: 'upstream response lost' }, 502) })
  assert.equal(lost.state, 'pending')
  for (const cleanup_status of ['pending', 'retained']) {
    const [cleanup] = await confirmAndRequestRetrievalProofs([s], { resolveProviderBase, confirm,
      fetchFn: async () => json({ ...payload(s, 'reconciled', ''), cleanup_status }) })
    assert.equal(cleanup.state, 'pending'); assert.match(cleanup.message!, /settlement is committed.*cleanup is pending/i)
  }
})

test('missing, failed or non-HTTP provider resolution preserves ACK without a POST', async () => {
  for (const resolve of [undefined, async () => { throw new Error('lookup failed') }, async () => 'ftp://provider.example']) {
    let acks = 0, posts = 0
    const [outcome] = await confirmAndRequestRetrievalProofs([session()], { resolveProviderBase: resolve, confirm: async () => { acks++ }, fetchFn: async () => { posts++; throw new Error('unexpected') } })
    assert.equal(acks, 1); assert.equal(posts, 0); assert.equal(outcome.state, 'unavailable'); assert.match(outcome.message!, /Verified output and owner confirmation are preserved/)
  }
})

test('malformed or mismatched final responses are unknown, never settled or retried', async () => {
  const s = session()
  const bad = [
    () => json(payload(s), 202), () => json(payload(s, 'pending'), 200), () => json(payload(s, 'success', ''), 200),
    () => json({ ...payload(s), session_id: session(2).sessionId }),
    () => json({ ...payload(s), session_id: s.sessionId.slice(2) }),
    () => json({ ...payload(s), session_ids: [s.sessionId] }), () => json({ ...payload(s), proof_count: '1' }),
    () => json({ ...payload(s), proof_count: 2 }), () => json({ ...payload(s), tx_hash: 'not-a-hash' }),
    () => json({ ...payload(s), cleanup_status: ['complete'] }), () => json({ ...payload(s), error: [] }),
    () => new Response('{"status":', { headers: { 'content-type': 'application/json' } }),
    () => new Response(JSON.stringify(payload(s))),
    () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(16385), { headers: { 'content-type': 'application/json' } }),
    () => { const r = json(payload(s)); r.headers.set('content-length', '99999'); return r },
  ]
  for (const response of bad) {
    let calls = 0
    const [outcome] = await confirmAndRequestRetrievalProofs([s], { resolveProviderBase, confirm, fetchFn: async () => { calls++; return response() } })
    assert.equal(calls, 1); assert.equal(outcome.state, 'pending'); assert.match(outcome.message!, /No valid final response/)
  }
  let calls = 0
  const [outcome] = await confirmAndRequestRetrievalProofs([s], { resolveProviderBase, confirm, fetchFn: async () => { calls++; throw new DOMException('HTTP deadline', 'TimeoutError') } })
  assert.equal(calls, 1); assert.equal(outcome.state, 'pending')
})

test('bounded chunked reader cancels oversized outcomes and settlement waves reject invalid IDs', async () => {
  let canceled = false
  const [outcome] = await confirmAndRequestRetrievalProofs([session()], { resolveProviderBase, confirm, fetchFn: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16385)) }, cancel() { canceled = true },
  }), { headers: { 'content-type': 'application/json' } }) })
  assert.equal(outcome.state, 'pending'); assert.equal(canceled, true)
  let acks = 0
  for (const sessions of [[], [session(), session()], Array.from({ length: 65 }, (_, i) => session(i + 1)), [{ ...session(), payee: 'invalid' }]]) {
    await assert.rejects(confirmAndRequestRetrievalProofs(sessions, { resolveProviderBase, confirm: async () => { acks++ } }))
  }
  assert.equal(acks, 0)
})

test('cancellation during an ACK receipt wait does not suppress proof requests after commitment', async () => {
  const controller = new AbortController(), s = session()
  let posts = 0
  const outcomes = await confirmAndRequestRetrievalProofs([s], {
    resolveProviderBase, signal: controller.signal,
    confirm: async () => { controller.abort() },
    fetchFn: async (_, init) => { assert.equal(init?.signal?.aborted, false); posts++; return json(payload(s)) },
  })
  assert.equal(posts, 1); assert.equal(outcomes[0].state, 'committed')
})

test('one post-ACK deadline bounds the whole wave and prevents dispatch after expiry', async (t) => {
  const deadlines: AbortController[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 95_000)
    const controller = new AbortController(); deadlines.push(controller); return controller.signal
  })
  let posts = 0
  const outcomes = await confirmAndRequestRetrievalProofs([session(1), session(2), session(3)], {
    resolveProviderBase, confirm,
    fetchFn: async (_, init) => {
      posts++; deadlines[0].abort(new Error('whole wave expired'))
      assert.equal(init?.signal?.aborted, true)
      throw new Error('response lost at deadline')
    },
  })
  assert.equal(posts, 1)
  assert.equal(outcomes.length, 3)
  assert.equal(outcomes[0].responseUnknown, true)
  assert.equal(outcomes[0].state, 'pending')
  assert.deepEqual(outcomes.slice(1).map((o) => o.state), ['unavailable', 'unavailable'])
})

test('a shared-payee session is not dispatched after the wave deadline expires', async (t) => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 95_000)
    return deadline.signal
  })
  const first = session(1)
  const sessions = [first, { ...session(2), payee: first.payee }]
  let posts = 0
  const outcomes = await confirmAndRequestRetrievalProofs(sessions, {
    resolveProviderBase, confirm,
    fetchFn: async () => {
      posts++
      deadline.abort(new Error('whole wave expired'))
      throw new Error('response lost at deadline')
    },
  })
  assert.equal(posts, 1)
  assert.equal(outcomes[0].state, 'pending')
  assert.equal(outcomes[0].responseUnknown, true)
  assert.equal(outcomes[1].state, 'unavailable')
})

test('a stalled provider lookup consumes the wave deadline without starting later lookups', async (t) => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 95_000)
    return deadline.signal
  })
  const first = session(1)
  const sessions = [first, { ...session(2), payee: first.payee }]
  let lookups = 0, posts = 0
  const work = confirmAndRequestRetrievalProofs(sessions, {
    confirm,
    resolveProviderBase: async () => {
      lookups++
      return new Promise<string>(() => {})
    },
    fetchFn: async () => { posts++; throw new Error('unexpected POST') },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(lookups, 1)
  deadline.abort(new Error('wave expired during discovery'))
  const outcomes = await work
  assert.equal(lookups, 1)
  assert.equal(posts, 0)
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ['unavailable', 'unavailable'])
})

test('shared deadline cancels all four active workers without dispatching queued sessions', async (t) => {
  const deadlines: AbortController[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 95_000)
    const controller = new AbortController(); deadlines.push(controller); return controller.signal
  })
  const sessions = Array.from({ length: 64 }, (_, i) => session(i + 1))
  let posts = 0
  const work = confirmAndRequestRetrievalProofs(sessions, { resolveProviderBase, confirm,
    fetchFn: async (_, init) => {
      posts++
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('response lost')), { once: true })
      })
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  try { assert.equal(posts, 4) } finally { deadlines[0].abort(new Error('wave expired')) }
  const outcomes = await work
  assert.equal(posts, 4)
  assert.deepEqual(outcomes.map((o) => o.sessionId), sessions.map((s) => s.sessionId))
  assert.ok(outcomes.slice(0, 4).every((o) => o.responseUnknown && o.state === 'pending'))
  assert.ok(outcomes.slice(4).every((o) => o.state === 'unavailable'))
})
