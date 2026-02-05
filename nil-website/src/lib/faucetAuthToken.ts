export const FAUCET_AUTH_TOKEN_STORAGE_KEY = 'nilstore.faucetAuthToken'

export function getFaucetAuthToken(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(FAUCET_AUTH_TOKEN_STORAGE_KEY) ?? ''
    const trimmed = raw.trim()
    return trimmed ? trimmed : null
  } catch {
    return null
  }
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

