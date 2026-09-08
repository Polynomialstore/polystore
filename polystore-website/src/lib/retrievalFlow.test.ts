import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { decodeRetrievalSlice, executeRetrievalWindows, validateRetrievalAllocation, type RetrievalFlow } from './retrievalFlow'
import { planRetrievalWindows, type PinnedGeneration, type FrozenSession, type RetrievalWindow } from './retrieval'

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

test('1GiB plan executes with at most 16 contexts and one encoded window in flight', async () => {
  const file = { path: 'large', start_offset: 0n, size_bytes: 1n << 30n, flags: 0 }
  let total = 0n, ack = 0, contexts = 0, peak = 0, liveBytes = 0
  const summary = createHash('sha256')
  await executeRetrievalWindows(planRetrievalWindows(pin, file, 0n, file.size_bytes), {
    open: async (windows) => { contexts = windows.length; peak = Math.max(peak, contexts); return windows.map((window) => ({ window }) as FrozenSession) },
    fetchAndVerify: async (s) => { assert.equal(liveBytes, 0); liveBytes = s.window.blobCount * 131072; return new Uint8Array(liveBytes) },
    consume: async (w: RetrievalWindow, bytes) => { assert.equal(bytes.length, liveBytes); liveBytes = 0; for (const part of w.slices) { total += BigInt(part.length); summary.update(`${part.outputOffset}:${part.length};`) } },
    flush: async () => { assert.equal(liveBytes, 0) },
    confirm: async (sessions) => { assert.equal(sessions.length, contexts); ack += sessions.length; contexts = 0 },
  })
  assert.equal(total, 1n << 30n); assert.equal(ack, 1064); assert.equal(peak, 16); assert.equal(summary.digest('hex').length, 64)
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
