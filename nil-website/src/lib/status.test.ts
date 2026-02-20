/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchStatus } from './status'
import { appConfig } from '../config'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('fetchStatus keeps last known gateway state when optional probe is skipped', async () => {
  const originalFetch = globalThis.fetch
  let gatewayUp = false

  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)

      if (url === `${appConfig.lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`) {
        return jsonResponse(200, {
          block: { header: { height: '1', chain_id: appConfig.cosmosChainId } },
        })
      }

      if (url === `${appConfig.lcdBase}/nilchain/nilchain/v1/providers`) {
        return jsonResponse(200, { providers: [] })
      }

      if (url === appConfig.evmRpc && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: `0x${appConfig.chainId.toString(16)}` })
      }

      if (url === `${appConfig.gatewayBase}/status` || url === `${appConfig.gatewayBase}/health`) {
        if (!gatewayUp) {
          throw new Error('Failed to fetch')
        }
        return jsonResponse(200, { mode: 'standalone' })
      }

      throw new Error(`unexpected url: ${url}`)
    }) as any

    const first = await fetchStatus(appConfig.chainId, { probeOptionalHealth: true })
    assert.equal(first.gateway, 'error')

    const second = await fetchStatus(appConfig.chainId, { probeOptionalHealth: false })
    assert.equal(second.gateway, 'error')

    gatewayUp = true
    const third = await fetchStatus(appConfig.chainId, { probeOptionalHealth: true })
    assert.equal(third.gateway, 'ok')

    const fourth = await fetchStatus(appConfig.chainId, { probeOptionalHealth: false })
    assert.equal(fourth.gateway, 'ok')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchStatus skips gateway probe when configured gateway base is untrusted', async () => {
  const originalFetch = globalThis.fetch
  const originalGatewayBase = appConfig.gatewayBase
  const mutableConfig = appConfig as { gatewayBase: string }
  let gatewayProbeCalls = 0

  try {
    mutableConfig.gatewayBase = 'http://localhost:8081'
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)

      if (url === `${appConfig.lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`) {
        return jsonResponse(200, {
          block: { header: { height: '1', chain_id: appConfig.cosmosChainId } },
        })
      }

      if (url === `${appConfig.lcdBase}/nilchain/nilchain/v1/providers`) {
        return jsonResponse(200, { providers: [] })
      }

      if (url === appConfig.evmRpc && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: `0x${appConfig.chainId.toString(16)}` })
      }

      if (url.includes('/status') || url.includes('/health')) {
        gatewayProbeCalls += 1
        return jsonResponse(200, { mode: 'standalone' })
      }

      throw new Error(`unexpected url: ${url}`)
    }) as typeof fetch

    const summary = await fetchStatus(appConfig.chainId, { probeOptionalHealth: true })
    assert.equal(summary.gateway, 'warn')
    assert.equal(gatewayProbeCalls, 0)
  } finally {
    mutableConfig.gatewayBase = originalGatewayBase
    globalThis.fetch = originalFetch
  }
})
