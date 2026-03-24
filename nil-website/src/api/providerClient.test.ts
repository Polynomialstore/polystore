import test from 'node:test'
import assert from 'node:assert/strict'

import { providerFetchMduWindowWithSession } from './providerClient.ts'

test('providerFetchMduWindowWithSession sends retrieval window in query and headers', async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {}
  const bytes = new Uint8Array([1, 2, 3, 4])

  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input)
    seen.headers = Object.fromEntries(new Headers(init?.headers).entries())
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  }) as typeof fetch

  const out = await providerFetchMduWindowWithSession(
    'https://sp1.nilstore.org',
    '0xabc123',
    7,
    {
      dealId: '25',
      owner: 'nil1owner',
      sessionId: '0xdeadbeef',
      startBlobIndex: 32,
      blobCount: 32,
    },
    fetchMock,
  )

  assert.deepEqual(Array.from(out), Array.from(bytes))
  assert.ok(seen.url, 'request url should be captured')
  const url = new URL(seen.url!)
  assert.equal(url.pathname, '/sp/retrieval/mdu/0xabc123/7')
  assert.equal(url.searchParams.get('deal_id'), '25')
  assert.equal(url.searchParams.get('owner'), 'nil1owner')
  assert.equal(url.searchParams.get('start_blob_index'), '32')
  assert.equal(url.searchParams.get('blob_count'), '32')
  assert.equal(seen.headers?.['x-nil-session-id'], '0xdeadbeef')
  assert.equal(seen.headers?.['x-nil-start-blob-index'], '32')
  assert.equal(seen.headers?.['x-nil-blob-count'], '32')
})
