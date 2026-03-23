import test from 'node:test'
import assert from 'node:assert/strict'

import { createSparseHttpTransportPort } from './httpTransport'

test('http transport forwards X-Nil-Previous-Manifest-Root when provided', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: { ...((init?.headers as Record<string, string>) || {}) },
    })
    return new Response('OK', { status: 200 })
  }) as typeof fetch
  try {
    const transport = createSparseHttpTransportPort()
    await transport.sendArtifact({
      dealId: '42',
      manifestRoot: '0xnext',
      previousManifestRoot: '0xprev',
      target: {
        baseUrl: 'http://provider.test',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
      },
      artifact: {
        kind: 'mdu',
        index: 0,
        bytes: new Uint8Array([1, 2, 3]),
        fullSize: 8,
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://provider.test/sp/upload_mdu')
  assert.equal(calls[0].headers['X-Nil-Previous-Manifest-Root'], '0xprev')
})
