import test from 'node:test'
import assert from 'node:assert/strict'

import { executeWithFallback } from './router'
import { TransportError } from './errors'
import type { TransportCandidate } from './types'

test('executeWithFallback falls back to direct SP when gateway is down', async () => {
  const candidates: TransportCandidate<string>[] = [
    {
      backend: 'gateway',
      endpoint: 'http://gateway',
      execute: async () => {
        throw new TransportError('connection refused', 'connection_refused')
      },
    },
    {
      backend: 'direct_sp',
      endpoint: 'http://sp',
      execute: async () => 'ok',
    },
  ]

  const result = await executeWithFallback('list_files', candidates, { preference: 'auto' })
  assert.equal(result.backend, 'direct_sp')
  assert.equal(result.data, 'ok')
  assert.equal(result.trace.attempts.length, 2)
})

test('executeWithFallback does not retry 4xx on the same backend', async () => {
  let gatewayAttempts = 0
  const candidates: TransportCandidate<string>[] = [
    {
      backend: 'gateway',
      endpoint: 'http://gateway',
      execute: async () => {
        gatewayAttempts += 1
        throw new TransportError('not found', 'http_4xx', 404)
      },
    },
    {
      backend: 'direct_sp',
      endpoint: 'http://sp',
      execute: async () => 'ok',
    },
  ]

  const result = await executeWithFallback('slab', candidates, {
    preference: 'auto',
    maxAttemptsPerBackend: 3,
  })
  assert.equal(result.backend, 'direct_sp')
  assert.equal(gatewayAttempts, 1)
})

test('executeWithFallback treats provider mismatch as terminal', async () => {
  let spCalled = false
  const candidates: TransportCandidate<string>[] = [
    {
      backend: 'gateway',
      endpoint: 'http://gateway',
      execute: async () => {
        throw new TransportError('provider mismatch', 'provider_mismatch')
      },
    },
    {
      backend: 'direct_sp',
      endpoint: 'http://sp',
      execute: async () => {
        spCalled = true
        return 'ok'
      },
    },
  ]

  await assert.rejects(
    executeWithFallback('fetch', candidates, { preference: 'auto' }),
    /Terminal fetch failure/,
  )
  assert.equal(spCalled, false)
})

test('executeWithFallback classifies timeouts and falls back', async () => {
  const candidates: TransportCandidate<string>[] = [
    {
      backend: 'gateway',
      endpoint: 'http://gateway',
      execute: async (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    },
    {
      backend: 'direct_sp',
      endpoint: 'http://sp',
      execute: async () => 'ok',
    },
  ]

  const result = await executeWithFallback('fetch', candidates, { preference: 'auto', timeoutMs: 5 })
  assert.equal(result.backend, 'direct_sp')
  const timeoutAttempt = result.trace.attempts.find((a) => a.errorClass === 'timeout')
  assert.equal(Boolean(timeoutAttempt), true)
})
