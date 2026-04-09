/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FAUCET_AUTH_TOKEN_STORAGE_KEY, getFaucetAuthToken, setFaucetAuthToken } from './faucetAuthToken'

class FakeStorage {
  private readonly store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }
}

test('faucet auth token is trimmed and stored in localStorage', () => {
  const original = (globalThis as any).localStorage
  const fake = new FakeStorage()

  try {
    (globalThis as any).localStorage = fake

    assert.equal(getFaucetAuthToken(), null)

    setFaucetAuthToken('  secret  ')
    assert.equal(fake.getItem(FAUCET_AUTH_TOKEN_STORAGE_KEY), 'secret')
    assert.equal(getFaucetAuthToken(), 'secret')

    setFaucetAuthToken('   ')
    assert.equal(getFaucetAuthToken(), null)
  } finally {
    (globalThis as any).localStorage = original
  }
})
