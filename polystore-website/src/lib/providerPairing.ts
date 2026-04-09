import {
  lcdFetchPendingProviderLink,
  lcdFetchPendingProviderLinksByOperator,
  lcdFetchProviderPairing,
  lcdFetchProvidersByOperator,
} from '../api/lcdClient'
import { appConfig } from '../config'
import type { LcdPendingProviderLink, LcdProviderPairing } from '../domain/lcd'
import { ethToPolystoreAddress } from './address'

function normalizeNonEmpty(input: string): string {
  return String(input || '').trim()
}

export function operatorAddressFromWalletAddress(walletAddress: string): string | null {
  const normalized = normalizeNonEmpty(walletAddress)
  if (!normalized) return null
  const polystoreAddress = ethToPolystoreAddress(normalized)
  return polystoreAddress || null
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

export async function fetchPendingProviderLink(
  providerAddress: string,
  { lcdBase = appConfig.lcdBase, fetchFn = fetch }: { lcdBase?: string; fetchFn?: typeof fetch } = {},
): Promise<LcdPendingProviderLink | null> {
  const normalized = normalizeNonEmpty(providerAddress)
  if (!normalized) return null
  return lcdFetchPendingProviderLink(lcdBase, normalized, fetchFn)
}

export async function fetchPendingProviderLinksByOperator(
  operator: string,
  { lcdBase = appConfig.lcdBase, fetchFn = fetch }: { lcdBase?: string; fetchFn?: typeof fetch } = {},
): Promise<LcdPendingProviderLink[]> {
  const normalized = normalizeNonEmpty(operator)
  if (!normalized) return []
  return lcdFetchPendingProviderLinksByOperator(lcdBase, normalized, fetchFn)
}
