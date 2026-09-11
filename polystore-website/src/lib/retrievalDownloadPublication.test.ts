import assert from 'node:assert/strict'
import test from 'node:test'
import { handoffOwnedDownload } from './retrievalDownloadPublication'

test('handoffOwnedDownload refuses an obsolete download after deferred handoff', async () => {
  let finish!: (cleanup: () => Promise<void>) => void
  const deferred = new Promise<() => Promise<void>>((resolve) => { finish = resolve })
  let owner = true, cleaned = 0, revoked = ''
  const run = handoffOwnedDownload(new AbortController().signal, () => owner, 'blob:old', () => deferred, () => 'published',
    (url) => { revoked = url })
  owner = false
  finish(async () => { cleaned++ })
  await assert.rejects(run, { name: 'AbortError' })
  assert.equal(cleaned, 1)
  assert.equal(revoked, 'blob:old')
})

test('handoffOwnedDownload does not start handoff after cancellation', async () => {
  const controller = new AbortController(); controller.abort()
  let handedOff = false, revoked = ''
  await assert.rejects(handoffOwnedDownload(controller.signal, () => true, 'blob:canceled', async () => {
    handedOff = true; return undefined
  }, () => 'published', (url) => { revoked = url }), { name: 'AbortError' })
  assert.equal(handedOff, false)
  assert.equal(revoked, 'blob:canceled')
})

test('handoffOwnedDownload publishes synchronously with its final ownership check', async () => {
  let owner = true, published = false
  const result = await handoffOwnedDownload(new AbortController().signal, () => owner, 'blob:current', async () => undefined,
    () => { published = true; owner = false; return 'installed' }, () => {})
  assert.equal(result, 'installed')
  assert.equal(published, true)
})
