import test from 'node:test'
import assert from 'node:assert/strict'
import { requestRetrievalProofV3 } from './retrievalV3Settlement'

const sessionId = `0x${'33'.repeat(32)}`
const request = { sessionId, slot: 3 }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'content-type': 'application/json' } })

test('v3 proof parser ignores optional timing while preserving canonical settlement fields', async () => {
  const result = await requestRetrievalProofV3('https://gateway.example', request, undefined, (async (url, init) => {
    assert.equal(url, 'https://gateway.example/gateway/retrieval/session-proof/continue')
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' })
    assert.deepEqual(JSON.parse(String(init?.body)), { session_id: sessionId, slot: 3 })
    return json({ status: 'success', session_id: sessionId, tx_hash: 'ab'.repeat(32), slot: 3, proof_count: 17, remaining: 4,
      cleanup_status: 'complete', timing: { schema: 'polystore-v3-provider-timing-v1', provider_total_ns: 99 } })
  }) as typeof fetch)
  assert.deepEqual(result, { state: 'accepted', sessionId, slot: 3, proofCount: 17, remaining: 4, txHash: 'ab'.repeat(32) })
})

test('v3 proof relay rejects slots outside the committed obligation range', async () => {
  await assert.rejects(requestRetrievalProofV3('https://gateway.example', { sessionId, slot: 8 }), /integer/)
})

test('only the exact pre-admission busy body is retryable and malformed outcomes stay unknown', async () => {
  const exact = await requestRetrievalProofV3('https://provider.example', request, undefined,
    (async () => json({ error: 'retrieval submission busy', hint: 'signer busy' }, 429)) as typeof fetch)
  assert.equal(exact.state, 'busy')
  const gatewayBusy = await requestRetrievalProofV3('https://gateway.example', request, undefined,
    (async () => json({ error: 'retrieval continuation busy', hint: 'gateway busy' }, 429)) as typeof fetch)
  assert.equal(gatewayBusy.state, 'busy')
  for (const response of [json({ error: 'retrieval submission busy', hint: 'signer busy', tx_hash: '' }, 429), json({ error: 'other', hint: 'signer busy' }, 429), new Response('lost', { status: 500 })]) {
    const outcome = await requestRetrievalProofV3('https://provider.example', request, undefined, (async () => response) as typeof fetch)
    assert.equal(outcome.state, 'unknown')
    assert.equal(outcome.responseUnknown, true)
  }
})

test('caller cancellation propagates instead of becoming an unknown proof outcome', async () => {
  const controller = new AbortController()
  const call = requestRetrievalProofV3('https://provider.example', request, controller.signal, (async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
  }) as typeof fetch)
  controller.abort(new Error('stop retrieval'))
  await assert.rejects(call, /stop retrieval/)
})
