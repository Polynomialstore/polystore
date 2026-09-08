import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

// Use a separately started Vite server. An installed Chromium executable can
// be selected without downloading Playwright's browser bundle.
test.use({ launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} })

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
    const { fetchFrozenSession, planRetrievalWindows } = await module('/src/lib/retrieval.ts')
    const { executeRetrievalWindows, decodeRetrievalOutput, createRetrievalOutput, validateRetrievalAllocation } = await module('/src/lib/retrievalFlow.ts')
    const { providerFetchRetrievalMetadata, providerFetchRetrievalWindow } = await module('/src/api/providerClient.ts')
    const s = query.session
    const pin = { chainId: 'test-1', height: 9n, dealId: 9007199254740993n, generation: 7n,
      root: `0x${Array.from(atob(s.manifest_root), (v) => v.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`, owner: s.owner,
      endHeight: 100n, layout: 2, k: 8, m: 4, rows: 8, leafCount: 96, metadataMdus: 2n, userMdus: 1n, totalMdus: 3n,
      assignments: Array.from({ length: 12 }, () => ({ provider: s.provider, active: true })) }
    const events: string[] = []
    await workerClient.initRetrievalWasm()
    const records = await workerClient.verifyRetrievalMetadata(await providerFetchRetrievalMetadata(location.origin, pin), pin)
    validateRetrievalAllocation(pin, records); events.push('metadata_verified')
    const file = records.find((r: { path: string }) => r.path === 'payload.bin')
    if (!file) throw new Error('authenticated file missing')
    const window = Array.from(planRetrievalWindows(pin, file, 0n, file.size_bytes)).find((w: any) => w.slot === 1) as any
    if (!window || window.startBlobIndex !== 8 || window.blobCount !== 2) throw new Error('fixture selected window mismatch')
    const expected = { sessionId: `0x${'01'.repeat(32)}`, pin, window, owner: s.owner, payee: s.authorized_proof_provider, funding: 1 }
    const output = await createRetrievalOutput(2n * 126976n)
    let ack = 0, written = 0n, hash = '', error = ''
    try {
      await executeRetrievalWindows([window], {
        open: async () => [await fetchFrozenSession(location.origin, expected)],
        fetchAndVerify: async (session: any) => {
          const bytes = await workerClient.verifyRetrievalWindow(session, await providerFetchRetrievalWindow(location.origin, session))
          events.push('window_verified'); return bytes
        },
        consume: async (window: any, bytes: Uint8Array) => {
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
