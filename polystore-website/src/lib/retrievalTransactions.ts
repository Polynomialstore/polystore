import type { Hex } from 'viem'

const PREFIX = 'polystore-retrieval-v1:'
// A 1 GiB download has 133 MDU waves: one open, ACK, and settlement
// record per wave, plus its output cursor. Never evict unresolved payments.
const MAX_RECORDS = 512, MAX_RECORD_BYTES = 1024 * 1024
export interface RetrievalStore {
  get<T>(key: string): T | undefined
  put(key: string, value: unknown): void
  remove(key: string): void
}
// Small control records only. OPFS owns the bytes. Never evict unresolved work
// by age: a receipt timeout is not evidence that a transaction was dropped.
export function browserRetrievalStore(storage: Storage = localStorage): RetrievalStore {
  return {
    get<T>(key: string) {
      const text = storage.getItem(PREFIX + key)
      if (text === null) return undefined
      if (text.length > MAX_RECORD_BYTES) throw new Error('retrieval recovery record exceeds limit')
      return JSON.parse(text, (_, v) => v && typeof v === 'object' && Object.keys(v).length === 1 ?
        typeof v.$bigint === 'string' ? BigInt(v.$bigint) : Array.isArray(v.$bytes) ? Uint8Array.from(v.$bytes) : v : v) as T
    },
    put(key, value) {
      const text = JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: String(v) } : v instanceof Uint8Array ? { $bytes: Array.from(v) } : v)
      if (text.length > MAX_RECORD_BYTES) throw new Error('retrieval recovery record exceeds limit')
      if (storage.getItem(PREFIX + key) === null) {
        let count = 0
        for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(PREFIX)) count++
        if (count >= MAX_RECORDS) throw new Error('retrieval recovery storage is full; reconcile existing retrievals before payment')
      }
      storage.setItem(PREFIX + key, text)
    },
    remove(key) { storage.removeItem(PREFIX + key) },
  }
}
export async function retrievalIntentKey(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
export async function withRetrievalLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('browser retrieval recovery locks are unavailable')
  return navigator.locks.request(PREFIX + key, { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('this retrieval is already active in another tab; wait for it before retrying')
    return run()
  })
}
export function assertRetrievalWalletScope(expectedChain: number, walletChain?: number, publicChain?: number): void {
  if (walletChain !== expectedChain || publicChain !== expectedChain) throw new Error('Switch the wallet to the configured retrieval network before payment')
}
export interface RetrievalReceipt { status: string; transactionHash: string; blockNumber: bigint }
export interface BrowserTransaction<T = unknown> {
  state: 'prepared' | 'broadcasting' | 'committed' | 'reverted'
  data: Hex
  hash?: Hex
  intent: T
}
export class RetrievalTransactionPending extends Error {
  constructor(readonly hash?: Hex) {
    super(`Retrieval transaction outcome is unresolved${hash ? ` (${hash})` : ' (wallet returned no hash)'}. Verified progress is saved. Retry the same retrieval to reconcile it; no replacement payment will be sent. An expired unresolved session requires chain/operator reconciliation.`)
  }
}

/** Caller holds the operation lock. Persist intent before entering the wallet. */
export async function settleBrowserTransaction<T>(options: {
  store: RetrievalStore; key: string; prepare: () => Promise<{ data: Hex; intent: T }>
  send: (data: Hex) => Promise<Hex>; receipt: (hash: Hex) => Promise<RetrievalReceipt>
  reconcile: (transaction: BrowserTransaction<T>) => Promise<boolean>; signal?: AbortSignal
}): Promise<BrowserTransaction<T>> {
  let transaction = options.store.get<BrowserTransaction<T>>(options.key)
  if (!transaction || transaction.state === 'prepared' || transaction.state === 'reverted') {
    options.signal?.throwIfAborted()
    transaction = { ...await options.prepare(), state: 'prepared' }
    options.store.put(options.key, transaction)
  }
  if (transaction.state === 'committed') return transaction
  if (transaction.state === 'prepared') {
    options.signal?.throwIfAborted()
    transaction.state = 'broadcasting'
    options.store.put(options.key, transaction)
    try {
      transaction.hash = await options.send(transaction.data)
      options.store.put(options.key, transaction)
    } catch (error) {
      // Only an explicit wallet rejection proves the user did not authorize a
      // broadcast. Transport errors (including a lost hash) remain uncertain.
      let cause: unknown = error
      for (let i = 0; cause && i < 8; i++) {
        if (typeof cause !== 'object') break
        const value = cause as { code?: unknown; cause?: unknown }
        if (value.code === 4001) { transaction.state = 'prepared'; options.store.put(options.key, transaction); throw error }
        cause = value.cause
      }
      throw new RetrievalTransactionPending(transaction.hash)
    }
  }
  // Cancellation still stops every pre-broadcast wallet action. After broadcast
  // it cannot erase committed progress or authorize a replacement transaction.
  if (transaction.hash) {
    let receipt: RetrievalReceipt | undefined
    try { receipt = await options.receipt(transaction.hash) } catch { /* reconcile canonical session state below */ }
    if (receipt && receipt.transactionHash.toLowerCase() === transaction.hash.toLowerCase() && receipt.blockNumber > 0n) {
      if (receipt.status === 'success') transaction.state = 'committed'
      else if (receipt.status === 'reverted') transaction.state = 'reverted'
      if (transaction.state !== 'broadcasting') {
        options.store.put(options.key, transaction)
        if (transaction.state === 'reverted') throw new Error(`Retrieval transaction reverted (${transaction.hash}); verified progress is saved. Retry the same retrieval to prepare a new transaction`)
        return transaction
      }
    }
  }
  try {
    if (await options.reconcile(transaction)) {
      transaction.state = 'committed'; options.store.put(options.key, transaction); return transaction
    }
  } catch { /* stale, missing or malformed chain data cannot clear the intent */ }
  throw new RetrievalTransactionPending(transaction.hash)
}
