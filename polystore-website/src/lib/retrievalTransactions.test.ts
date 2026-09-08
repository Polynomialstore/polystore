import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRetrievalWalletScope, browserRetrievalStore, retrievalIntentKey, settleBrowserTransaction, type BrowserTransaction, type RetrievalStore } from './retrievalTransactions'
const hash = `0x${'12'.repeat(32)}` as const
const data = '0x1234' as const
export function memoryStore(): RetrievalStore {
  const values = new Map<string, unknown>()
  return { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key, value) => { values.set(key, structuredClone(value)) }, remove: (key) => { values.delete(key) } }
}
function fixture() {
  const store = memoryStore()
  let sends = 0, prepares = 0, committed = false, receiptWorks = true
  const options = { store, key: 'open:chain/account/generation/window/auth',
    prepare: async () => { prepares++; return { data, intent: { ids: [hash], nonce: 17n, expiry: 512n } } },
    send: async (sent: string) => { assert.equal(sent, data); assert.equal(store.get<BrowserTransaction>(options.key)?.state, 'broadcasting'); sends++; return hash },
    receipt: async () => { if (!receiptWorks) throw new Error('RPC timed out'); return { transactionHash: hash, status: 'success', blockNumber: 10n } },
    reconcile: async () => committed,
  }
  return { options, get sends() { return sends }, get prepares() { return prepares }, set committed(value: boolean) { committed = value }, set receiptWorks(value: boolean) { receiptWorks = value } }
}

test('an abort after broadcast cannot turn an observed successful ACK into failure', async () => {
  const f = fixture(), controller = new AbortController()
  const send = f.options.send
  await assert.doesNotReject(settleBrowserTransaction({ ...f.options, signal: controller.signal,
    send: async (value) => { const result = await send(value); controller.abort(); return result },
  }))
  assert.equal(f.options.store.get<BrowserTransaction>(f.options.key)?.state, 'committed')
})

test('lost receipt reload reuses the hash and exact open intent without another wallet send', async () => {
  const f = fixture(); f.receiptWorks = false
  await assert.rejects(settleBrowserTransaction(f.options), /outcome is unresolved/)
  assert.equal(f.options.store.get<BrowserTransaction>(f.options.key)?.hash, hash)
  f.receiptWorks = true
  await settleBrowserTransaction({ ...f.options, prepare: async () => { throw new Error('must not choose another nonce') } })
  assert.equal(f.sends, 1); assert.equal(f.prepares, 1)
})

test('lost wallet hash retains precomputed IDs and never sends again, even after expiry', async () => {
  const f = fixture(); f.receiptWorks = false
  let sends = 0
  const options = { ...f.options, send: async () => { sends++; throw new Error('wallet transport disconnected') } }
  await assert.rejects(settleBrowserTransaction(options), /wallet returned no hash/)
  await assert.rejects(settleBrowserTransaction(options), /outcome is unresolved/)
  assert.deepEqual(f.options.store.get<BrowserTransaction>(f.options.key)?.intent, { ids: [hash], nonce: 17n, expiry: 512n })
  f.committed = true
  assert.equal((await settleBrowserTransaction(options)).state, 'committed')
  assert.equal(sends, 1)
})

test('a canceled action before broadcast sends nothing; explicit wallet rejection remains retryable', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(settleBrowserTransaction({ ...f.options, signal: controller.signal }))
  assert.equal(f.sends, 0); assert.equal(f.prepares, 0)
  await assert.rejects(settleBrowserTransaction({ ...f.options, send: async () => { throw { cause: { code: 4001 } } } }))
  assert.equal(f.options.store.get<BrowserTransaction>(f.options.key)?.state, 'prepared')
  await settleBrowserTransaction(f.options)
  assert.equal(f.sends, 1); assert.equal(f.prepares, 2, 'a rejected open gets fresh expiry and nonce on explicit retry')
})

test('durable record failure prevents wallet entry; malformed receipts never imply success', async () => {
  const f = fixture()
  await assert.rejects(settleBrowserTransaction({ ...f.options, store: { ...f.options.store, put: () => { throw new Error('quota') } } }), /quota/)
  assert.equal(f.sends, 0)
  for (const receipt of [ { transactionHash: '0xdead', status: 'success', blockNumber: 10n }, { transactionHash: hash, status: 'success', blockNumber: 0n } ]) {
    const attempt = fixture()
    await assert.rejects(settleBrowserTransaction({ ...attempt.options, receipt: async () => receipt }), /outcome is unresolved/)
    assert.equal(attempt.options.store.get<BrowserTransaction>(attempt.options.key)?.state, 'broadcasting')
  }
})

test('a matching reverted receipt proves no effects and permits a freshly prepared retry', async () => {
  const f = fixture()
  await assert.rejects(settleBrowserTransaction({ ...f.options, receipt: async () => ({ transactionHash: hash, status: 'reverted', blockNumber: 10n }) }), /reverted/)
  await settleBrowserTransaction(f.options)
  assert.equal(f.sends, 2); assert.equal(f.prepares, 2)
})

test('operation identity separates chain, wallet, window, and sponsored authorization', async () => {
  const base = ['chain-1', 'wallet-1', 'root-1', 'window-1', 'auth-1']
  const key = await retrievalIntentKey(base)
  for (let i = 0; i < base.length; i++) { const other = [...base]; other[i] += '-other'; assert.notEqual(await retrievalIntentKey(other), key) }
  assert.equal(await retrievalIntentKey(base), key)
})

test('browser store round trips exact integers and contexts across reload and caps unresolved records', () => {
  const entries = new Map<string, string>()
  const storage = { get length() { return entries.size }, key: (i: number) => Array.from(entries.keys())[i] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) }, clear: () => entries.clear() } satisfies Storage
  const store = browserRetrievalStore(storage)
  const value = { exact: 9007199254740993n, bytes: new Uint8Array([0, 128, 255]) }
  store.put('test', value)
  assert.deepEqual(browserRetrievalStore(storage).get('test'), value)
  for (let i = 1; i < 512; i++) store.put(String(i), { pending: true })
  assert.throws(() => store.put('over-limit', {}), /full/)
  assert.deepEqual(store.get('test'), value)
  store.put('test', value) // updating a retained attempt is allowed at capacity
})


test('wallet and receipt client must both match the configured chain before journal or payment entry', () => {
  assert.doesNotThrow(() => assertRetrievalWalletScope(31337, 31337, 31337))
  for (const [wallet, client] of [[1, 31337], [31337, 1], [undefined, 31337], [31337, undefined]]) {
    assert.throws(() => assertRetrievalWalletScope(31337, wallet, client), /configured retrieval network/)
  }
})
