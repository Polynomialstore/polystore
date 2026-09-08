import { test, expect, chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { FrozenSession, PinnedGeneration, RetrievalWindow } from '../src/lib/retrieval'

// Use a separately started Vite server. An installed Chromium executable can
// be selected without downloading Playwright's browser bundle.

test('real OPFS checkpoint survives reload and excludes a second tab after a simulated lost ACK receipt', async ({ page, context }) => {
  test.setTimeout(60_000)
  await context.route('**/retrieval-checkpoint-harness', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Retrieval recovery check</title>',
  }))
  await page.goto('/retrieval-checkpoint-harness')
  const job = await page.evaluateHandle(async () => {
    const checkpointPath = '/src/lib/retrievalCheckpoint.ts', transactionPath = '/src/lib/retrievalTransactions.ts'
    const { openRetrievalCheckpoint } = await import(/* @vite-ignore */ checkpointPath) as typeof import('../src/lib/retrievalCheckpoint')
    const { browserRetrievalStore, settleBrowserTransaction } = await import(/* @vite-ignore */ transactionPath) as typeof import('../src/lib/retrievalTransactions')
    const job = await openRetrievalCheckpoint(['runtime-recovery'], 1024n)
    const bytes = Uint8Array.from({ length: 1024 }, (_, i) => (i * 17 + (i >>> 8)) & 255)
    await job.output.write(0n, bytes); await job.output.flush()
    const hash = `0x${'12'.repeat(32)}` as const
    // Storage/transaction recovery only; chain receipts and ACK are simulated.
    const sessions = [{ sessionId: hash, context: new Uint8Array([1, 2, 3]), pin: { dealId: 17n } }] as FrozenSession[]
    job.prepare(0n, sessions)
    try {
      await settleBrowserTransaction({ store: browserRetrievalStore(), key: 'runtime-ack',
        prepare: async () => ({ data: '0x1234', intent: [hash] }),
        send: async () => { localStorage.setItem('runtime-sends', String(Number(localStorage.getItem('runtime-sends') ?? 0) + 1)); return hash },
        receipt: async () => { throw new Error('simulated lost receipt') }, reconcile: async () => false,
      })
      throw new Error('uncertain receipt was accepted')
    } catch (error) { if (!String(error).includes('outcome is unresolved')) throw error }
    return job
  })
  const id = await job.evaluate((value) => value.state.id)
  const other = await context.newPage()
  await other.goto('/retrieval-checkpoint-harness')
  expect(await other.evaluate(async () => {
    const path = '/src/lib/retrievalCheckpoint.ts'
    const { openRetrievalCheckpoint } = await import(/* @vite-ignore */ path) as typeof import('../src/lib/retrievalCheckpoint')
    try { const unexpected = await openRetrievalCheckpoint(['runtime-recovery'], 1024n); await unexpected.retain(); return 'unexpected acquisition' }
    catch (error) { return String(error) }
  })).toContain('already running in another tab')
  await job.evaluate(async (value) => value.retain())
  await page.reload()
  const result = await page.evaluate(async () => {
    const checkpointPath = '/src/lib/retrievalCheckpoint.ts', transactionPath = '/src/lib/retrievalTransactions.ts'
    const { openRetrievalCheckpoint } = await import(/* @vite-ignore */ checkpointPath) as typeof import('../src/lib/retrievalCheckpoint')
    const { browserRetrievalStore, settleBrowserTransaction } = await import(/* @vite-ignore */ transactionPath) as typeof import('../src/lib/retrievalTransactions')
    const job = await openRetrievalCheckpoint(['runtime-recovery'], 1024n), store = browserRetrievalStore()
    try {
      const session = job.state.pending?.sessions[0]
      if (!session || session.pin.dealId !== 17n || !(session.context instanceof Uint8Array)) throw new Error('frozen session checkpoint did not round-trip')
      const bytes = new Uint8Array(await (await job.output.file()).arrayBuffer())
      if (bytes.length !== 1024 || bytes.some((b, i) => b !== ((i * 17 + (i >>> 8)) & 255))) throw new Error('persisted bytes changed')
      await settleBrowserTransaction({ store, key: 'runtime-ack',
        prepare: async () => { throw new Error('retry prepared a replacement') }, send: async () => { throw new Error('retry sent a replacement') },
        receipt: async (hash) => ({ status: 'success', transactionHash: hash, blockNumber: 9n }), reconcile: async () => false,
      })
      job.complete(0n, [{ sessionId: session.sessionId, state: 'committed' }])
      store.remove('runtime-ack'); job.cleaned(); job.finish()
      return { id: job.state.id, through: String(job.state.through), sends: Number(localStorage.getItem('runtime-sends')), bytes: bytes.length }
    } finally { await job.output.cleanup(); localStorage.removeItem('runtime-sends') }
  })
  expect(result).toEqual({ id, through: '0', sends: 1, bytes: 1024 })
  await other.close()
})

test('secured selected window uses real Chromium Worker/WASM and OPFS before simulated ACK', async ({ page }) => {
  test.setTimeout(120_000)
  const root = new URL('../../testdata/retrieval-window-v2/', import.meta.url)
  const query = JSON.parse(await readFile(new URL('session.json', root), 'utf8'))
  const metadata = JSON.parse(await readFile(new URL('metadata.json', root), 'utf8'))
  const encoded = await readFile(new URL('window.bin', root))
  const mdu0 = gunzipSync(await readFile(new URL('mdu_0.bin.gz', root)))
  // Independent payload oracle: strip each canonical scalar's reserved byte.
  // This fixture supplies two full blobs, not the other slots of the file.
  const decoded = Buffer.alloc(2 * 126976)
  for (let scalar = 0; scalar < encoded.length / 32; scalar++) encoded.copy(decoded, scalar * 31, scalar * 32 + 1, scalar * 32 + 32)
  const expectedHash = createHash('sha256').update(decoded).digest('hex')
  let corrupt = false, sessionQueries = 0, metadataQueries = 0, windowQueries = 0
  await page.route('**/retrieval-v2-harness', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Retrieval runtime fixture</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }))
  await page.route('**/polystorechain/polystorechain/v1/retrieval-sessions/*', async (route) => {
    const segment = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!)
    expect(segment).toMatch(/^[A-Za-z0-9_-]{43}=$/)
    expect(Buffer.from(segment, 'base64url')).toEqual(Buffer.from(query.session.session_id, 'base64'))
    sessionQueries++
    await route.fulfill({ json: query, headers: { 'x-cosmos-block-height': '12' } })
  })
  await page.route('**/sp/retrieval/mdu/**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname.endsWith('/0')) {
      expect(url.searchParams.get('committed_height')).toBe('9'); metadataQueries++
      await route.fulfill({ body: mdu0, contentType: 'application/octet-stream', headers: { 'x-cosmos-block-height': '9' } }); return
    }
    expect(request.headers()['x-polystore-session-id']).toBe(metadata.session_id)
    expect(url.searchParams.get('blob_count')).toBe('2'); windowQueries++
    const bytes = Buffer.from(encoded)
    if (corrupt) bytes[32 * 5 + 31] ^= 1
    const body = Buffer.concat([
      Buffer.from(`--runtime-window\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--runtime-window\r\nContent-Disposition: form-data; name="bytes"; filename="blobs.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes, Buffer.from('\r\n--runtime-window--\r\n'),
    ])
    await route.fulfill({ body, contentType: 'multipart/form-data; boundary=runtime-window; version=2' })
  })
  await page.goto('/retrieval-v2-harness')
  let workers = 0
  page.on('worker', () => { workers++ })
  const run = () => page.evaluate(async ({ query, expectedHash }) => {
    const module = (path: string) => import(/* @vite-ignore */ path)
    const { workerClient } = await module('/src/lib/worker-client.ts')
    const { fetchFrozenSession, planRetrievalWindows } = await module('/src/lib/retrieval.ts') as typeof import('../src/lib/retrieval')
    const { executeRetrievalWindows, decodeRetrievalOutput, createRetrievalOutput, validateRetrievalAllocation } = await module('/src/lib/retrievalFlow.ts')
    const { providerFetchRetrievalMetadata, providerFetchRetrievalWindow } = await module('/src/api/providerClient.ts')
    const s = query.session
    const pin: PinnedGeneration = { chainId: 'test-1', height: 9n, dealId: 9007199254740993n, generation: 7n,
      root: `0x${Array.from(atob(s.manifest_root), (v) => v.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`, owner: s.owner,
      endHeight: 100n, layout: 2, k: 8, m: 4, rows: 8, leafCount: 96, metadataMdus: 2n, userMdus: 1n, totalMdus: 3n,
      assignments: Array.from({ length: 12 }, () => ({ provider: s.provider, active: true })) }
    const events: string[] = []
    await workerClient.initRetrievalWasm()
    const records = await workerClient.verifyRetrievalMetadata(await providerFetchRetrievalMetadata(location.origin, pin), pin)
    validateRetrievalAllocation(pin, records); events.push('metadata_verified')
    const file = records.find((r: { path: string }) => r.path === 'payload.bin')
    if (!file) throw new Error('authenticated file missing')
    const window = Array.from(planRetrievalWindows(pin, file, 0n, file.size_bytes)).find((w) => w.slot === 1)
    if (!window || window.startBlobIndex !== 8 || window.blobCount !== 2) throw new Error('fixture selected window mismatch')
    const expected: Parameters<typeof fetchFrozenSession>[1] = { sessionId: `0x${'01'.repeat(32)}`, pin, window, owner: s.owner, payee: s.authorized_proof_provider, funding: 1 }
    const output = await createRetrievalOutput(2n * 126976n)
    let ack = 0, written = 0n, hash = '', error = ''
    try {
      await executeRetrievalWindows([window], {
        open: async () => [await fetchFrozenSession(location.origin, expected)],
        fetchAndVerify: async (session: FrozenSession) => {
          const bytes = await workerClient.verifyRetrievalWindow(session, await providerFetchRetrievalWindow(location.origin, session))
          events.push('window_verified'); return bytes
        },
        consume: async (window: RetrievalWindow, bytes: Uint8Array) => {
          // Save the fixture's selected slot payloads in proof order. This is
          // a window artifact, not a claim to reconstruct the other file slots.
          for (const part of decodeRetrievalOutput(pin, file, window, bytes)) { await output.write(written, part.bytes); written += BigInt(part.bytes.length) }
          events.push('written')
        },
        flush: async () => { await output.flush(); events.push('flushed') },
        confirm: async () => {
          const saved = await output.file()
          if (saved.size !== 2 * 126976) throw new Error('output length mismatch')
          hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await saved.arrayBuffer())), (v) => v.toString(16).padStart(2, '0')).join('')
          if (hash !== expectedHash) throw new Error('OPFS payload hash mismatch')
          events.push('file_hash_verified'); ack++; events.push('simulated_ACK')
        },
      })
    } catch (reason) { error = String(reason) }
    finally { await output.cleanup() }
    return { events, ack, written: Number(written), hash, error, secureContext: isSecureContext, opfs: Boolean(navigator.storage?.getDirectory) }
  }, { query, expectedHash })
  const valid = await run()
  expect(valid.error).toBe(''); expect(valid.ack).toBe(1); expect(valid.written).toBe(2 * 126976); expect(valid.hash).toBe(expectedHash)
  expect(valid.events).toEqual(['metadata_verified', 'window_verified', 'written', 'flushed', 'file_hash_verified', 'simulated_ACK'])
  expect(valid.secureContext).toBe(true); expect(valid.opfs).toBe(true); expect(workers).toBeGreaterThan(0)
  corrupt = true
  const invalid = await run()
  expect(invalid.error).toContain('received bytes'); expect(invalid.ack).toBe(0); expect(invalid.written).toBe(0)
  expect(invalid.events).toEqual(['metadata_verified'])
  expect(sessionQueries).toBe(2); expect(metadataQueries).toBe(2); expect(windowQueries).toBe(2)
})

test('1GiB OPFS output preserves every flushed chunk through one in-place handle', async () => {
  test.setTimeout(120_000)
  const chunk = Buffer.alloc(8388608)
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 17 + (i >>> 8)) & 255
  const hashes = Array.from({ length: 128 }, (_, i) => {
    chunk.writeUInt32LE(i, 0); chunk.writeUInt32LE(i ^ 0xabcdef, chunk.length - 4)
    return createHash('sha256').update(chunk).digest('hex')
  })
  // Playwright's ephemeral context hit its storage ceiling below 1GiB on
  // this host. Use a fresh disk-backed profile, never the user's Chrome data.
  const profile = await mkdtemp(join(tmpdir(), 'polystore-opfs-257-'))
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      headless: true, baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5173',
    })
    const page = await context.newPage()
    await page.route('**/retrieval-output-harness', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OPFS output check</title>' }))
    await page.goto('/retrieval-output-harness')
    const result = await page.evaluate(async (hashes) => {
      const path = '/src/lib/retrievalFlow.ts'
      const { createRetrievalOutput } = await import(/* @vite-ignore */ path) as typeof import('../src/lib/retrievalFlow')
      const bytes = new Uint8Array(8388608), view = new DataView(bytes.buffer)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + (i >>> 8)) & 255
      const output = await createRetrievalOutput(1073741824n)
      let flushed = 0
      try {
        for (let i = 0; i < 128; i++) {
          view.setUint32(0, i, true); view.setUint32(bytes.length - 4, i ^ 0xabcdef, true)
          await output.write(BigInt(i * bytes.length), bytes)
          await output.flush(); flushed++
        }
        const file = await output.file()
        if (file.size !== 1073741824) throw new Error('output length mismatch')
        for (let i = 0; i < 128; i++) {
          const bytes = await file.slice(i * 8388608, (i + 1) * 8388608).arrayBuffer()
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('')
          if (hash !== hashes[i]) throw new Error(`wrong persisted chunk ${i}`)
        }
        return { size: file.size, flushed }
      } finally { await output.cleanup() }
    }, hashes)
    expect(result).toEqual({ size: 1073741824, flushed: 128 })
  } finally { try { await context?.close() } finally { await rm(profile, { recursive: true, force: true }) } }
})
