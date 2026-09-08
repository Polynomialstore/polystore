import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { decodeRetrievalOutput, decodeRetrievalSlice, executeRetrievalWindows, validateRetrievalAllocation, type RetrievalFlow } from './retrievalFlow'
import { planRetrievalWindows, type PinnedGeneration, type FrozenSession, type RetrievalFile, type RetrievalWindow } from './retrieval'

const pin = { layout: 2, k: 8, m: 4, rows: 8, leafCount: 96, metadataMdus: 2n, userMdus: 133n, assignments: Array.from({ length: 12 }, (_, i) => ({ provider: `provider${i}`, active: true })) } as unknown as PinnedGeneration
function packed(raw: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(131072)
  for (let offset = 0; offset < raw.length; offset += 31) { const chunk = raw.subarray(offset, offset + 31); bytes.set(chunk, Math.floor(offset / 31) * 32 + 32 - chunk.length) }
  return bytes
}

test('decoder preserves producer right-aligned short chunks and rejects reserved/padding bytes', () => {
  for (const size of [0, 1, 30, 31, 32, 1024, 126975, 126976]) {
    const raw = Uint8Array.from({ length: size }, (_, i) => (i * 17 + 11) % 256), bytes = packed(raw)
    assert.deepEqual(decodeRetrievalSlice(bytes, size, 0, size), raw)
    if (size > 2) assert.deepEqual(decodeRetrievalSlice(bytes, size, 1, size - 2), raw.subarray(1, -1))
    const prefix = bytes.slice(); prefix[32] = 1
    assert.throws(() => decodeRetrievalSlice(prefix, size, 0, size), /prefix/)
    if (size < 126976) { const bad = bytes.slice(); bad[Math.floor(size / 31) * 32 + 1] = 1; assert.throws(() => decodeRetrievalSlice(bad, size, 0, size), /padding/) }
  }
})

test('allocation preflight rejects overlapping/scalar-ambiguous and transformed files', () => {
  const file = { path: 'a', start_offset: 0n, size_bytes: 1n, flags: 0 }
  validateRetrievalAllocation(pin, [file, { ...file, path: 'b', start_offset: 8126464n }])
  for (const change of [{ start_offset: 1n }, { flags: 1 }, { size_bytes: 999999999999n }]) assert.throws(() => validateRetrievalAllocation(pin, [{ ...file, ...change }]))
  assert.throws(() => validateRetrievalAllocation(pin, [file, { ...file, path: '', start_offset: 31n }]))
})

const windows = () => planRetrievalWindows(pin, { path: 'a', start_offset: 0n, size_bytes: 8126464n * 3n, flags: 0 }, 0n, 8126464n * 3n)
function harness(failure?: string) {
  const events: string[] = [], controller = new AbortController()
  let fetched = 0
  const flow: RetrievalFlow = {
    open: async (windows) => { events.push(`open:${windows.length}`); return windows.map((window) => ({ window }) as FrozenSession) },
    fetchAndVerify: async () => { events.push('verify'); fetched++; if (failure === 'verify' && fetched === 2) throw new Error('crypto rejected'); return new Uint8Array(8 * 131072) },
    consume: async () => { events.push('write'); if (failure === 'write') throw new Error('disk full'); if (failure === 'abort') controller.abort() },
    flush: async () => { events.push('flush'); if (failure === 'flush') throw new Error('close failed') },
    confirm: async (sessions) => { events.push(`ack:${sessions.length}`) },
  }
  return { flow, events, controller }
}
test('only fully verified, decoded and durably closed waves are acknowledged', async () => {
  const good = harness()
  await executeRetrievalWindows(windows(), good.flow)
  assert.equal(good.events[0], 'open:16')
  assert.deepEqual(good.events.filter((e) => e.startsWith('ack:')), ['ack:16', 'ack:8'])
  for (let i = 0; i < good.events.length; i++) if (good.events[i].startsWith('ack:')) assert.equal(good.events[i - 1], 'flush')
  for (const failure of ['verify', 'write', 'flush', 'abort']) {
    const bad = harness(failure)
    await assert.rejects(executeRetrievalWindows(windows(), bad.flow, bad.controller.signal))
    assert.ok(!bad.events.some((e) => e.startsWith('ack:')), failure)
  }
  const bad = harness(); bad.flow.open = async (w) => w.slice().reverse().map((window) => ({ window }) as FrozenSession)
  await assert.rejects(executeRetrievalWindows(windows(), bad.flow), /order/)
  assert.equal(bad.events.length, 0)
})

// A seekable, nonconstant fixture stream, independent of planner output slices.
// AES here only generates test bytes; this test does not perform network/crypto
// proof verification. Every blob and MDU has different data, exposing swaps.
const fixtureKey = Buffer.alloc(32, 0x57)
const rawBlobBytes = 31 * 4096, rawMduBytes = rawBlobBytes * 64
function sourceBytes(offset: number, length: number): Uint8Array {
  const counter = Buffer.alloc(16)
  counter.writeBigUInt64BE(BigInt(Math.floor(offset / 16)), 8)
  const skip = offset % 16
  return createCipheriv('aes-256-ctr', fixtureKey, counter).update(Buffer.alloc(skip + length)).subarray(skip)
}
function encodedProviderWindow(file: RetrievalFile, window: RetrievalWindow): Uint8Array {
  const encoded = new Uint8Array(window.blobCount * 131072)
  for (let i = 0; i < window.blobCount; i++) {
    // Invert the physical leaf position: eight rows per provider slot, eight
    // data slots per row. Do not use slices, rawOffset or outputOffset here.
    const leaf = window.startBlobIndex + i, slot = Math.floor(leaf / 8), row = leaf % 8
    assert.equal(slot, window.slot); assert.ok(slot < 8)
    assert.equal(window.provider, pin.assignments[slot].provider)
    const absolute = Number(window.mduIndex - pin.metadataMdus) * rawMduBytes + (row * 8 + slot) * rawBlobBytes
    const relative = absolute - Number(file.start_offset)
    assert.ok(relative >= 0 && relative < Number(file.size_bytes))
    const raw = sourceBytes(relative, Math.min(rawBlobBytes, Number(file.size_bytes) - relative))
    encoded.set(packed(raw), i * 131072)
  }
  return encoded
}

test('1GiB planner/decoder reassembles exact nonconstant payload with bounded contexts and memory', async () => {
  const file = { path: 'large', start_offset: 0n, size_bytes: 1n << 30n, flags: 0 }
  // Independent oracle: sequential source generation, no planner/window input.
  const oracle = createHash('sha256'), cipher = createCipheriv('aes-256-ctr', fixtureKey, Buffer.alloc(16)), zeros = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < 1024; i++) oracle.update(cipher.update(zeros))
  oracle.update(cipher.final())
  const expectedHash = oracle.digest('hex')
  assert.equal(expectedHash, '5806efdf1f91fa2b8ab62f7b5e16541c0f866227cfe977238bd2ec9789664d9e')

  let total = 0, ack = 0, contexts = 0, peak = 0, liveBytes = 0, blobs = 0, mdus = 0, mduBase = 0
  const actual = createHash('sha256'), mdu = new Uint8Array(rawMduBytes)
  let spans: [number, number][] = []
  const flushMdu = () => {
    const expectedLength = Math.min(rawMduBytes, Number(file.size_bytes) - mduBase)
    let end = 0
    for (const [start, stop] of spans.sort((a, b) => a[0] - b[0])) { assert.equal(start, end, 'no output overlap or gap'); end = stop }
    assert.equal(end, expectedLength)
    actual.update(mdu.subarray(0, expectedLength)); mdus++; mduBase += expectedLength; spans = []
  }
  await executeRetrievalWindows(planRetrievalWindows(pin, file, 0n, file.size_bytes), {
    open: async (windows) => { contexts = windows.length; peak = Math.max(peak, contexts); return windows.map((window) => ({ window }) as FrozenSession) },
    fetchAndVerify: async (s) => {
      assert.equal(liveBytes, 0); liveBytes = s.window.blobCount * 131072; blobs += s.window.blobCount
      assert.ok(liveBytes <= 8 * 131072)
      return encodedProviderWindow(file, s.window)
    },
    consume: async (window, bytes) => {
      assert.equal(bytes.length, liveBytes)
      for (const part of decodeRetrievalOutput(pin, file, window, bytes)) {
        const position = Number(part.offset)
        if (position >= mduBase + rawMduBytes) flushMdu()
        const relative = position - mduBase
        assert.ok(relative >= 0 && relative + part.bytes.length <= mdu.length)
        mdu.set(part.bytes, relative); spans.push([relative, relative + part.bytes.length]); total += part.bytes.length
        assert.ok(spans.length <= 64)
      }
      liveBytes = 0
    },
    flush: async () => { assert.equal(liveBytes, 0) },
    confirm: async (sessions) => { assert.equal(sessions.length, contexts); ack += sessions.length; contexts = 0 },
  })
  flushMdu()
  assert.equal(total, 1 << 30); assert.equal(mduBase, total); assert.equal(blobs, 8457); assert.equal(mdus, 133)
  assert.equal(ack, 1064); assert.equal(peak, 16); assert.equal(contexts, 0); assert.equal(liveBytes, 0)
  assert.equal(actual.digest('hex'), expectedHash)
})

test('1KiB arbitrary-offset ranges decode exactly within/across blobs and at a partial file tail', async () => {
  const file = { path: 'offset', start_offset: BigInt(3 * rawMduBytes), size_bytes: BigInt(2 * rawBlobBytes + 1027), flags: 0 }
  // Sequential oracle also covers a nonzero file allocation offset; it never
  // derives expected bytes from the planner's source or destination slices.
  const original = createCipheriv('aes-256-ctr', fixtureKey, Buffer.alloc(16)).update(Buffer.alloc(Number(file.size_bytes)))
  for (const [start, expectedBlobs] of [[54321, 1], [rawBlobBytes - 337, 2], [Number(file.size_bytes) - 1024, 1]]) {
    const output = new Uint8Array(1024), written = new Uint8Array(1024)
    let blobs = 0, acks = 0
    await executeRetrievalWindows(planRetrievalWindows(pin, file, BigInt(start), 1024n), {
      open: async (windows) => windows.map((window) => ({ window }) as FrozenSession),
      fetchAndVerify: async (s) => { blobs += s.window.blobCount; return encodedProviderWindow(file, s.window) },
      consume: async (window, bytes) => {
        for (const part of decodeRetrievalOutput(pin, file, window, bytes)) {
          const offset = Number(part.offset)
          assert.ok(offset >= 0 && offset + part.bytes.length <= 1024)
          for (let i = offset; i < offset + part.bytes.length; i++) { assert.equal(written[i], 0); written[i]++ }
          output.set(part.bytes, offset)
        }
      },
      flush: async () => { assert.ok(written.every((n) => n === 1)) },
      confirm: async (sessions) => { acks += sessions.length },
    })
    assert.equal(blobs, expectedBlobs); assert.equal(acks, expectedBlobs)
    assert.deepEqual(output, new Uint8Array(original.subarray(start, start + 1024)))
  }
})

test('file-backed sink closes each wave, preserves earlier writes and cleans up failed output', async () => {
  const { createRetrievalOutput } = await import('./retrievalFlow')
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const events: string[] = []
  let persisted = new Uint8Array(), rejectClose = false
  const handle = {
    async createWritable(options?: { keepExistingData?: boolean }) {
      events.push(options?.keepExistingData ? 'reopen' : 'create')
      let staged = options?.keepExistingData ? persisted.slice() : new Uint8Array()
      return {
        async truncate(size: number) { staged = new Uint8Array(size) },
        async write(value: { position: number; data: Uint8Array }) { events.push('write'); staged.set(value.data, value.position) },
        async close() { events.push('close'); if (rejectClose) throw new Error('disk close failure'); persisted = staged },
        async abort() { events.push('abort') },
      }
    },
    async getFile() { return new File([persisted], 'output') },
  }
  const dir = { async getFileHandle() { return handle }, async removeEntry() { events.push('remove') } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { async getDirectory() { return { async getDirectoryHandle() { return dir } } } } } })
  try {
    const output = await createRetrievalOutput(4n)
    await output.write(0n, new Uint8Array([1, 2])); await output.flush()
    await output.write(2n, new Uint8Array([3, 4])); await output.flush()
    assert.deepEqual(new Uint8Array(await (await output.file()).arrayBuffer()), new Uint8Array([1, 2, 3, 4]))
    assert.deepEqual(events, ['create', 'write', 'close', 'reopen', 'write', 'close'])
    await assert.rejects(output.write(4n, new Uint8Array([1])), /range/)
    await output.cleanup(); await output.cleanup(); assert.equal(events.filter((e) => e === 'remove').length, 1)
    const failing = await createRetrievalOutput(1n)
    rejectClose = true
    const flow = harness()
    flow.flow.flush = () => failing.flush()
    await assert.rejects(executeRetrievalWindows(windows(), flow.flow), /disk close failure/)
    assert.ok(!flow.events.some((e) => e.startsWith('ack:')))
    await failing.cleanup(); assert.deepEqual(events.slice(-2), ['abort', 'remove'])
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
