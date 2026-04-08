export const FAUCET_AUTH_TOKEN_STORAGE_KEY = 'nilstore.faucetAuthToken'

function buildFaucetAuthToken(): string {
  try {
    const raw = (import.meta as { env?: Record<string, unknown> }).env?.VITE_FAUCET_AUTH_TOKEN
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    return trimmed
  } catch {
    return ''
  }
}

export function hasBuildFaucetAuthToken(): boolean {
  return buildFaucetAuthToken().length > 0
}

export function getFaucetAuthToken(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(FAUCET_AUTH_TOKEN_STORAGE_KEY) ?? ''
    const trimmed = raw.trim()
    if (trimmed) return trimmed
  } catch {
    // Ignore storage read errors (private mode, disabled storage, etc.).
  }

  const buildToken = buildFaucetAuthToken()
  if (buildToken) return buildToken
  return null
}

export function setFaucetAuthToken(token: string | null): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const trimmed = String(token ?? '').trim()
    if (!trimmed) {
      storage.removeItem(FAUCET_AUTH_TOKEN_STORAGE_KEY)
      return
    }
    storage.setItem(FAUCET_AUTH_TOKEN_STORAGE_KEY, trimmed)
  } catch {
    // Ignore storage write errors (private mode, disabled storage, etc.).
  }
}
