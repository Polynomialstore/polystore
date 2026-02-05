import { appConfig } from '../config'

export type ServiceStatus = 'ok' | 'warn' | 'error'

export interface StatusSummary {
  lcd: ServiceStatus
  evm: ServiceStatus
  faucet: ServiceStatus
  gateway: ServiceStatus
  chainIdMatch: ServiceStatus
  height?: number
  networkName?: string
  evmChainId?: number
  providerCount?: number
  error?: string
}

export async function fetchStatus(expectedChainId: number): Promise<StatusSummary> {
  const summary: StatusSummary = { lcd: 'warn', evm: 'warn', faucet: 'warn', gateway: 'warn', chainIdMatch: 'warn' }
  try {
    const res = await fetch(`${appConfig.lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`)
    if (res.ok) {
      const json = await res.json()
      summary.height = Number(json?.block?.header?.height || 0)
      summary.networkName = json?.block?.header?.chain_id
      summary.lcd = 'ok'
    } else {
      summary.lcd = 'error'
    }
  } catch (e) {
    summary.lcd = 'error'
  }

  try {
    const res = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/providers`)
    if (res.ok) {
      const json = await res.json()
      const providers = Array.isArray(json?.providers) ? json.providers : []
      summary.providerCount = Number(providers.length)
    }
  } catch (e) {
    // optional
  }

  try {
    const res = await fetch(appConfig.evmRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
    })
    if (res.ok) {
      const json = await res.json()
      const chainIdHex = json?.result
      const chainId = chainIdHex ? parseInt(chainIdHex, 16) : undefined
      summary.evm = chainId ? 'ok' : 'warn'
      summary.chainIdMatch = chainId === expectedChainId ? 'ok' : 'error'
      summary.evmChainId = chainId
    } else {
      summary.evm = 'error'
    }
  } catch (e) {
    summary.evm = 'error'
  }

  if (!appConfig.gatewayDisabled) {
    try {
      const res = await fetch(`${appConfig.gatewayBase}/health`)
      summary.gateway = res.ok ? 'ok' : 'warn'
    } catch (e) {
      summary.gateway = 'error'
    }
  }

  if (appConfig.faucetEnabled) {
    try {
      const res = await fetch(`${appConfig.apiBase}/health`)
      summary.faucet = res.ok ? 'ok' : 'warn'
    } catch (e) {
      summary.faucet = 'warn'
    }
  } else {
    summary.faucet = 'warn'
  }

  return summary
}
