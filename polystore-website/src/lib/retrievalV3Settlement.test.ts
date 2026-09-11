import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { requestRetrievalProofV3 } from './retrievalV3Settlement'

const provider = bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(2)))
const sessionId = `0x${'33'.repeat(32)}`
const request = { dealId: 7n, sessionId, provider }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'content-type': 'application/json' } })

test('v3 proof parser ignores optional timing while preserving canonical settlement fields', async () => {
  const result = await requestRetrievalProofV3('https://gateway.example', request, undefined, (async (url, init) => {
    assert.equal(url, 'https://gateway.example/gateway/session-proof?deal_id=7')
    assert.equal(JSON.parse(String(init?.body)).session_id, sessionId)
    return json({ status: 'success', session_id: sessionId, tx_hash: 'ab'.repeat(32), slot: 3, proof_count: 17, remaining: 4,
      cleanup_status: 'complete', timing: { schema: 'polystore-v3-provider-timing-v1', provider_total_ns: 99 } })
  }) as typeof fetch)
  assert.deepEqual(result, { state: 'accepted', sessionId, slot: 3, proofCount: 17, remaining: 4, txHash: 'ab'.repeat(32) })
})

test('only the exact pre-admission busy body is retryable and malformed outcomes stay unknown', async () => {
  const exact = await requestRetrievalProofV3('https://provider.example', request, undefined,
    (async () => json({ error: 'retrieval submission busy', hint: 'signer busy' }, 429)) as typeof fetch)
  assert.equal(exact.state, 'busy')
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
