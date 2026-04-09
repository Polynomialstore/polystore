import { appConfig } from '../config'

type ErrorLike = {
  code?: unknown
  message?: unknown
  shortMessage?: unknown
  details?: unknown
  cause?: unknown
}

export interface WalletErrorInfo {
  message: string
  reconnectSuggested: boolean
  userRejected: boolean
}

function asObject(value: unknown): ErrorLike | null {
  if (!value || typeof value !== 'object') return null
  return value as ErrorLike
}

function collectErrorStrings(error: unknown): string[] {
  const out = new Set<string>()
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || seen.has(next)) continue
    seen.add(next)
    if (typeof next === 'string') {
      const trimmed = next.trim()
      if (trimmed) out.add(trimmed)
      continue
    }
    const obj = asObject(next)
    if (!obj) continue
    for (const field of [obj.message, obj.shortMessage, obj.details]) {
      if (typeof field === 'string') {
        const trimmed = field.trim()
        if (trimmed) out.add(trimmed)
      }
    }
    if (obj.cause) queue.push(obj.cause)
  }
  return Array.from(out)
}

function collectErrorCodes(error: unknown): number[] {
  const out: number[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || seen.has(next)) continue
    seen.add(next)
    const obj = asObject(next)
    if (!obj) continue
    const code = Number(obj.code)
    if (Number.isFinite(code)) out.push(code)
    if (obj.cause) queue.push(obj.cause)
  }
  return out
}

export function classifyWalletError(error: unknown, fallback = 'Wallet request failed'): WalletErrorInfo {
  const messages = collectErrorStrings(error)
  const joined = messages.join(' | ')
  const lower = joined.toLowerCase()
  const codes = collectErrorCodes(error)

  const codeRejected = codes.includes(4001)
  const codeUnauthorized = codes.includes(4100)
  const textRejected =
    lower.includes('user rejected') ||
    lower.includes('rejected the request') ||
    lower.includes('request rejected')
  const textUnauthorized =
    lower.includes('unauthorized') ||
    lower.includes('not authorized') ||
    lower.includes('permission') ||
    lower.includes('eth_requestaccounts')
  const staleAccount =
    lower.includes('connected wallet changed') ||
    lower.includes('wallet not connected')
  const rpcBackoff =
    lower.includes('rpc endpoint returned too many errors') ||
    (lower.includes('requested resource not available') &&
      lower.includes('consider using a different rpc endpoint'))

  const reconnectSuggested = codeRejected || codeUnauthorized || textRejected || textUnauthorized || staleAccount
  const userRejected = codeRejected || textRejected

  if (reconnectSuggested) {
    return {
      message:
        'Wallet access is required. If you switched accounts in MetaMask, click Connect Wallet and approve access for the active account.',
      reconnectSuggested: true,
      userRejected,
    }
  }

  if (rpcBackoff) {
    return {
      message:
        `MetaMask could not reach the configured PolyStore RPC reliably. Retry in a few seconds. If it keeps happening, open MetaMask > Networks > PolyStore Devnet and confirm the RPC URL is ${appConfig.evmRpc}.`,
      reconnectSuggested: false,
      userRejected: false,
    }
  }

  const bestMessage = messages.find(Boolean) || fallback
  return {
    message: bestMessage,
    reconnectSuggested: false,
    userRejected: false,
  }
}
