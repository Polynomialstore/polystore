import { buildProviderAdminActionTypedData } from './eip712'

export type ProviderAdminActionName = 'status_refresh' | 'run_doctor' | 'rotate_endpoint'

export interface ProviderAdminRequestEnvelope {
  provider: string
  action: ProviderAdminActionName
  endpoint: string
  nonce: number
  expires_at: number
  signature: string
}

export function createProviderAdminNonce(nowMs: number = Date.now(), randomValue: number = Math.random() * 1_000_000): number {
  const now = Math.max(1, Math.floor(Number(nowMs) || 0))
  const randomPart = Math.abs(Math.floor(Number(randomValue) || 0)) % 1_000_000
  return now + randomPart
}

export function createProviderAdminExpiry(
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = 5 * 60,
): number {
  const now = Math.max(1, Math.floor(Number(nowSeconds) || 0))
  const ttl = Math.max(60, Math.floor(Number(ttlSeconds) || 0))
  return now + ttl
}

export function buildProviderAdminRequestEnvelope(input: {
  provider: string
  action: ProviderAdminActionName
  endpoint?: string | null
  nonce: number
  expiresAt: number
  signature: string
}): ProviderAdminRequestEnvelope {
  return {
    provider: String(input.provider || '').trim(),
    action: input.action,
    endpoint: String(input.endpoint || '').trim(),
    nonce: Math.max(1, Math.floor(Number(input.nonce) || 0)),
    expires_at: Math.max(1, Math.floor(Number(input.expiresAt) || 0)),
    signature: String(input.signature || '').trim(),
  }
}

export function buildProviderAdminTypedData(input: {
  provider: string
  action: ProviderAdminActionName
  endpoint?: string | null
  nonce: number
  expiresAt: number
  chainId: number
}) {
  return buildProviderAdminActionTypedData(
    {
      provider: String(input.provider || '').trim(),
      action: input.action,
      endpoint: String(input.endpoint || '').trim(),
      nonce: Math.max(1, Math.floor(Number(input.nonce) || 0)),
      expires_at: Math.max(1, Math.floor(Number(input.expiresAt) || 0)),
    },
    Math.max(1, Math.floor(Number(input.chainId) || 0)),
  )
}
