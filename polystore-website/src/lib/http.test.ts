/* eslint-disable @typescript-eslint/no-explicit-any */import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchWithTimeout } from './http'

test('fetchWithTimeout aborts a hanging fetch', async () => {
  const originalFetch = globalThis.fetch
  assert.ok(originalFetch, 'global fetch must exist for this test')

  let sawAbort = false

  try {
    globalThis.fetch = ((_input: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true
            reject(new Error('AbortError'))
          },
          { once: true },
        )
      })
    }) as any

    await assert.rejects(() => fetchWithTimeout('http://example.com', undefined, 10), /timed out/i)
    assert.equal(sawAbort, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

