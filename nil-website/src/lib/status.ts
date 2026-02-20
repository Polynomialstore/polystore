import { appConfig } from '../config'
import { isTrustedLocalGatewayBase } from './transport/mode'

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

export interface FetchStatusOptions {
  // Expensive optional probes (gateway/faucet health). Keep off during routine polling.
  probeOptionalHealth?: boolean
}

const GATEWAY_STATUS_PATH = '/status'
const GATEWAY_HEALTH_PATH = '/health'
let cachedGatewayPath: '/status' | '/health' = '/status'
let cachedGatewayStatus: ServiceStatus = 'warn'

async function probeGateway(base: string): Promise<ServiceStatus> {
  const baseUrl = String(base || '').replace(/\/$/, '')
  const probe = async (path: typeof GATEWAY_STATUS_PATH | typeof GATEWAY_HEALTH_PATH): Promise<ServiceStatus> => {
    const res = await fetch(`${baseUrl}${path}`)
    return res.ok ? 'ok' : 'warn'
  }

  if (cachedGatewayPath === GATEWAY_STATUS_PATH) {
    try {
      return await probe(GATEWAY_STATUS_PATH)
    } catch {
      try {
        const fallback = await probe(GATEWAY_HEALTH_PATH)
        cachedGatewayPath = GATEWAY_HEALTH_PATH
        return fallback
      } catch {
        return 'error'
      }
    }
  }

  try {
    const health = await probe(GATEWAY_HEALTH_PATH)
    return health
  } catch {
    try {
      const status = await probe(GATEWAY_STATUS_PATH)
      cachedGatewayPath = GATEWAY_STATUS_PATH
      return status
    } catch {
      return 'error'
    }
  }
}

export async function fetchStatus(expectedChainId: number, options: FetchStatusOptions = {}): Promise<StatusSummary> {
  const gatewayTrusted = isTrustedLocalGatewayBase(appConfig.gatewayBase)
  if (appConfig.gatewayDisabled) {
    cachedGatewayStatus = 'warn'
  } else if (!gatewayTrusted) {
    cachedGatewayStatus = 'warn'
  }
  const summary: StatusSummary = {
    lcd: 'warn',
    evm: 'warn',
    faucet: appConfig.faucetEnabled ? 'ok' : 'warn',
    gateway: appConfig.gatewayDisabled || !gatewayTrusted ? 'warn' : cachedGatewayStatus,
    chainIdMatch: 'warn',
  }
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

  if (options.probeOptionalHealth && !appConfig.gatewayDisabled && gatewayTrusted) {
    try {
      summary.gateway = await probeGateway(appConfig.gatewayBase)
      cachedGatewayStatus = summary.gateway
    } catch (e) {
      summary.gateway = 'error'
      cachedGatewayStatus = 'error'
    }
  } else if (options.probeOptionalHealth && (!gatewayTrusted || appConfig.gatewayDisabled)) {
    summary.gateway = 'warn'
    cachedGatewayStatus = 'warn'
  }

  if (options.probeOptionalHealth && appConfig.faucetEnabled) {
    try {
      const res = await fetch(`${appConfig.apiBase}/health`)
      summary.faucet = res.ok ? 'ok' : 'warn'
    } catch (e) {
      summary.faucet = 'warn'
    }
  }

  return summary
}
