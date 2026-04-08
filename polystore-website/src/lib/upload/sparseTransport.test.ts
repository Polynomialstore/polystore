import test from 'node:test'
import assert from 'node:assert/strict'

import { postSparseArtifact } from './sparseTransport'

test('postSparseArtifact sends truncated body with X-Nil-Full-Size', async () => {
  const calls: Array<{ headers: Record<string, string>; bytes: Uint8Array }> = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>
    const bytes = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer())
    calls.push({ headers, bytes })
    return new Response('ok', { status: 200 })
  }

  const response = await postSparseArtifact({
    url: 'http://example.test/sp/upload_mdu',
    headers: { 'X-Nil-Deal-ID': '1' },
    artifact: {
      kind: 'mdu',
      index: 0,
      bytes: new Uint8Array([1, 2, 0, 0]),
    },
    fetchImpl,
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers['X-Nil-Full-Size'], '4')
  assert.deepStrictEqual(calls[0].bytes, new Uint8Array([1, 2]))
})

test('postSparseArtifact retries once with full payload on sparse rollout rejection', async () => {
  const calls: Array<{ headers: Record<string, string>; bytes: Uint8Array }> = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>
    const bytes = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer())
    calls.push({ headers, bytes })
    return calls.length === 1 ? new Response('bad', { status: 400 }) : new Response('ok', { status: 200 })
  }

  const response = await postSparseArtifact({
    url: 'http://example.test/sp/upload_manifest',
    headers: { 'X-Nil-Deal-ID': '1' },
    artifact: {
      kind: 'manifest',
      bytes: new Uint8Array([9, 0, 0]),
    },
    fetchImpl,
  })

  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers['X-Nil-Full-Size'], '3')
  assert.deepStrictEqual(calls[0].bytes, new Uint8Array([9]))
  assert.equal(calls[1].headers['X-Nil-Full-Size'], undefined)
  assert.deepStrictEqual(calls[1].bytes, new Uint8Array([9, 0, 0]))
})

test('postSparseArtifact keeps non-empty all-zero payloads sparse', async () => {
  const calls: Array<{ headers: Record<string, string>; bytes: Uint8Array }> = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>
    const bytes = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer())
    calls.push({ headers, bytes })
    return new Response('ok', { status: 200 })
  }

  await postSparseArtifact({
    url: 'http://example.test/sp/upload_shard',
    headers: { 'X-Nil-Deal-ID': '1', 'X-Nil-Slot': '0' },
    artifact: {
      kind: 'shard',
      index: 3,
      slot: 0,
      bytes: new Uint8Array(16),
    },
    fetchImpl,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers['X-Nil-Full-Size'], '16')
  assert.deepStrictEqual(calls[0].bytes, new Uint8Array([0]))
})

test('postSparseArtifact sends direct typed-array bodies without blob wrapping', async () => {
  let body: BodyInit | null | undefined
  const bytes = new Uint8Array([1, 2, 3, 4])
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = init?.body
    return new Response('ok', { status: 200 })
  }

  await postSparseArtifact({
    url: 'http://example.test/sp/upload_mdu',
    headers: { 'X-Nil-Deal-ID': '1' },
    artifact: {
      kind: 'mdu',
      index: 0,
      bytes,
    },
    fetchImpl,
  })

  assert.ok(body instanceof Uint8Array)
  assert.deepStrictEqual(body, bytes)
})

test('postSparseArtifact reuses headers object when no sparse header is needed', async () => {
  const headers = {
    'X-Nil-Deal-ID': '1',
    'Content-Type': 'application/octet-stream',
  }
  let seenHeaders: HeadersInit | undefined
  const fetchImpl: typeof fetch = async (_url, init) => {
    seenHeaders = init?.headers
    return new Response('ok', { status: 200 })
  }

  await postSparseArtifact({
    url: 'http://example.test/sp/upload_mdu',
    headers,
    artifact: {
      kind: 'mdu',
      index: 0,
      bytes: new Uint8Array([1, 2, 3]),
      fullSize: 3,
    },
    fetchImpl,
  })

  assert.equal(seenHeaders, headers)
})
