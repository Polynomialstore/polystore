import {
  lcdFetchPendingProviderPairing,
  lcdFetchProviderPairing,
  lcdFetchProvidersByOperator,
} from '../api/lcdClient'
import { appConfig } from '../config'
import type { LcdPendingProviderPairing, LcdProviderPairing } from '../domain/lcd'
import { ethToNil } from './address'

function normalizeNonEmpty(input: string): string {
  return String(input || '').trim()
}

export function createProviderPairingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pair-${crypto.randomUUID()}`
  }
  return `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function operatorAddressFromWalletAddress(walletAddress: string): string | null {
  const normalized = normalizeNonEmpty(walletAddress)
  if (!normalized) return null
  const nilAddress = ethToNil(normalized)
  return nilAddress || null
}

export async function fetchProviderPairing(
  provider: string,
  { lcdBase = appConfig.lcdBase, fetchFn = fetch }: { lcdBase?: string; fetchFn?: typeof fetch } = {},
): Promise<LcdProviderPairing | null> {
  const normalized = normalizeNonEmpty(provider)
  if (!normalized) return null
  return lcdFetchProviderPairing(lcdBase, normalized, fetchFn)
}

export async function fetchProvidersByOperator(
  operator: string,
  { lcdBase = appConfig.lcdBase, fetchFn = fetch }: { lcdBase?: string; fetchFn?: typeof fetch } = {},
): Promise<LcdProviderPairing[]> {
  const normalized = normalizeNonEmpty(operator)
  if (!normalized) return []
  return lcdFetchProvidersByOperator(lcdBase, normalized, fetchFn)
}

export async function fetchProvidersByWallet(
  walletAddress: string,
  { lcdBase = appConfig.lcdBase, fetchFn = fetch }: { lcdBase?: string; fetchFn?: typeof fetch } = {},
): Promise<LcdProviderPairing[]> {
  const operator = operatorAddressFromWalletAddress(walletAddress)
  if (!operator) return []
  return fetchProvidersByOperator(operator, { lcdBase, fetchFn })
}

export async function fetchPendingProviderPairing(
  pairingId: string,
  { lcdBase = appConfig.lcdBase, fetchFn = fetch }: { lcdBase?: string; fetchFn?: typeof fetch } = {},
): Promise<LcdPendingProviderPairing | null> {
  const normalized = normalizeNonEmpty(pairingId)
  if (!normalized) return null
  return lcdFetchPendingProviderPairing(lcdBase, normalized, fetchFn)
}
