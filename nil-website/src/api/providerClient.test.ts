import test from 'node:test'
import assert from 'node:assert/strict'

import {
  providerAdminRefreshStatus,
  providerAdminRotateEndpoint,
  providerFetchMduWindowWithSession,
} from './providerClient.ts'

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

test('providerAdminRefreshStatus posts the signed envelope to the provider-daemon', async () => {
  const seen: { url?: string; method?: string; body?: string; headers?: Record<string, string> } = {}
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input)
    seen.method = String(init?.method || '')
    seen.body = String(init?.body || '')
    seen.headers = Object.fromEntries(new Headers(init?.headers).entries())
    return new Response(
      JSON.stringify({
        action: 'status_refresh',
        authorized_operator: 'nil1operator',
        provider: { address: 'nil1provider' },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }) as typeof fetch

  const response = await providerAdminRefreshStatus(
    'https://sp.nilstore.org',
    {
      provider: 'nil1provider',
      action: 'status_refresh',
      endpoint: '',
      nonce: 1,
      expires_at: 2,
      signature: '0xabc',
    },
    fetchMock,
  )

  assert.equal(seen.url, 'https://sp.nilstore.org/sp/admin/status')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.headers?.['content-type'], 'application/json')
  assert.match(seen.body || '', /"provider":"nil1provider"/)
  assert.equal(response.provider?.address, 'nil1provider')
})

test('providerAdminRotateEndpoint surfaces provider-daemon admin errors', async () => {
  const fetchMock = (async () =>
    new Response('rotation failed', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch

  await assert.rejects(
    providerAdminRotateEndpoint(
      'https://sp.nilstore.org',
      {
        provider: 'nil1provider',
        action: 'rotate_endpoint',
        endpoint: '/dns4/new.example.com/tcp/443/https',
        nonce: 3,
        expires_at: 4,
        signature: '0xdef',
      },
      fetchMock,
    ),
    /rotation failed/,
  )
})
