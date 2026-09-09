import { RAW_BLOB_BYTES, fetchFrozenSession, type FrozenSession, type PinnedGeneration, type RetrievalFile, type RetrievalWindow } from './retrieval'
import { RAW_MDU_CAPACITY_BYTES } from '../domain/polyfsLayout'

const RAW_MDU = BigInt(RAW_MDU_CAPACITY_BYTES)

// Current native/browser append producers allocate a fresh MDU for each file.
// A FAT alone cannot distinguish alternative packing of two partial files into
// one scalar. Reject that shape before payment, including tombstone overlaps.
// FAT lengths describe stored bytes even for transformed files. Preserve those
// extents for append; planRetrievalWindows rejects a selected transformed file
// until its bounded decoder is supported, without blocking unrelated files.
export function validateRetrievalAllocation(pin: PinnedGeneration, records: readonly RetrievalFile[]): void {
  const extents = records.filter((r) => r.size_bytes > 0n).slice().sort((a, b) => a.start_offset < b.start_offset ? -1 : a.start_offset > b.start_offset ? 1 : 0)
  let end = 0n
  for (const file of extents) {
    if (file.start_offset % RAW_MDU !== 0n || file.start_offset < end || file.start_offset + file.size_bytes > pin.userMdus * RAW_MDU) throw new Error('unsupported or ambiguous packed allocation before payment')
    end = ((file.start_offset + file.size_bytes + RAW_MDU - 1n) / RAW_MDU) * RAW_MDU
  }
}

export function decodeRetrievalSlice(encoded: Uint8Array, validLength: number, offset: number, length: number): Uint8Array {
  if (encoded.length !== 131072 || ![validLength, offset, length].every(Number.isSafeInteger) || validLength < 0 || validLength > RAW_BLOB_BYTES || offset < 0 || length < 0 || offset + length > validLength) throw new Error('invalid packed range')
  const complete = Math.floor(validLength / 31), remainder = validLength % 31
  for (let scalar = 0; scalar < 4096; scalar++) {
    const start = scalar * 32
    if (encoded[start] !== 0) throw new Error('nonzero user payload prefix')
    const padding = scalar < complete ? 1 : scalar === complete && remainder ? 32 - remainder : 32
    for (let i = 1; i < padding; i++) if (encoded[start + i] !== 0) throw new Error('nonzero user payload padding')
  }
  const out = new Uint8Array(length)
  for (let i = 0; i < length;) {
    const at = offset + i, scalar = Math.floor(at / 31), position = at % 31
    const count = Math.min(length - i, 31 - position)
    const start = scalar * 32 + (scalar === complete && remainder ? 32 - remainder : 1) + position
    out.set(encoded.subarray(start, start + count), i)
    i += count
  }
  return out
}

export function decodeRetrievalOutput(pin: PinnedGeneration, file: RetrievalFile, window: RetrievalWindow, bytes: Uint8Array): { offset: bigint; bytes: Uint8Array }[] {
  if (bytes.length !== window.blobCount * 131072 || window.slices.length !== window.blobCount) throw new Error('incomplete encoded output')
  const mduStart = (window.mduIndex - pin.metadataMdus) * RAW_MDU
  return window.slices.map((slice, i) => {
    const blobStart = mduStart + BigInt(slice.encodedBlobIndex * RAW_BLOB_BYTES)
    const remaining = file.start_offset + file.size_bytes - blobStart
    const validLength = Number(remaining < BigInt(RAW_BLOB_BYTES) ? remaining : BigInt(RAW_BLOB_BYTES))
    return { offset: slice.outputOffset, bytes: decodeRetrievalSlice(bytes.subarray(i * 131072, (i + 1) * 131072), validLength, slice.rawOffset, slice.length) }
  })
}

export async function waitForRetrievalChallenge(lcd: string, expected: Parameters<typeof fetchFrozenSession>[1], signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<FrozenSession> {
  // The supplied timeout covers body reads and polling. Absence of the committed
  // anchor may delay retrieval; it never selects a replacement seed.
  for (;;) {
    signal.throwIfAborted()
    const session = await fetchFrozenSession(lcd, expected, signal, fetchFn)
    if (session.seed && session.height >= session.openedHeight + 2n) return session
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 750)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

export interface RetrievalFlow {
  open(windows: readonly RetrievalWindow[]): Promise<readonly FrozenSession[]>
  fetchAndVerify(session: FrozenSession): Promise<Uint8Array>
  consume(window: RetrievalWindow, bytes: Uint8Array): Promise<void>
  flush(): Promise<void>
  confirm(sessions: readonly FrozenSession[]): Promise<void>
  progress?(windows: number, encodedBytes: bigint): void
}
// At most waveLimit contexts (default 16, maximum 64) plus two encoded
// windows are live. Fetch/verification overlaps; consumption stays ordered.
// No new wave or receipt starts until this wave is consumed and flushed.
export async function executeRetrievalWindows(windows: Iterable<RetrievalWindow>, flow: RetrievalFlow, signal?: AbortSignal, waveLimit = 16): Promise<void> {
  if (!Number.isSafeInteger(waveLimit) || waveLimit < 1 || waveLimit > 64) throw new Error('invalid wave bound')
  const iterator = windows[Symbol.iterator]()
  let completed = 0, encodedBytes = 0n
  for (;;) {
    const wave: RetrievalWindow[] = []
    while (wave.length < waveLimit) { const next = iterator.next(); if (next.done) break; wave.push(next.value) }
    if (!wave.length) return
    signal?.throwIfAborted()
    const sessions = await flow.open(wave)
    if (sessions.length !== wave.length || sessions.some((s, i) => s.window.mduIndex !== wave[i].mduIndex || s.window.startBlobIndex !== wave[i].startBlobIndex || s.window.blobCount !== wave[i].blobCount || s.window.provider !== wave[i].provider)) throw new Error('opened windows do not match requested order')
    // Observe rejections immediately, even when the preceding window is slow.
    // Drain before returning so recovery cannot race a prior fetch/verifier.
    type Result = { ok: true; bytes: Uint8Array } | { ok: false; error: unknown }
    const pending: Promise<Result>[] = []
    let next = 0
    const state: { failure?: { error: unknown } } = {}
    const throwIfFailed = () => { if (state.failure) throw state.failure.error }
    try {
      for (let i = 0; i < sessions.length; i++) {
        signal?.throwIfAborted()
        throwIfFailed()
        while (pending.length < 2 && next < sessions.length) {
          const session = sessions[next++]
          pending.push(Promise.resolve().then(() => { signal?.throwIfAborted(); return flow.fetchAndVerify(session) }).then(
            (bytes): Result => ({ ok: true, bytes }),
            (error): Result => { state.failure ??= { error }; return { ok: false, error } },
          ))
        }
        const result = await pending.shift()!
        if (!result.ok) throw result.error
        signal?.throwIfAborted()
        throwIfFailed()
        await flow.consume(wave[i], result.bytes)
        completed++; encodedBytes += BigInt(result.bytes.length)
        flow.progress?.(completed, encodedBytes)
      }
    } finally {
      await Promise.all(pending)
    }
    await flow.flush()
    signal?.throwIfAborted()
    // This is the only success path. No receipt is emitted on fetch, crypto,
    // decoding, reconstruction, persistence or cancellation failure.
    await flow.confirm(sessions)
  }
}

export async function createRetrievalOutput(length: bigint, savedId?: string) {
  if (length < 0n || length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsupported output length')
  if (!navigator.storage?.getDirectory) throw new Error('file-backed browser storage is required before payment')
  const { workerClient } = await import('./worker-client')
  const id = await workerClient.retrievalOutput(savedId ? { action: 'resume', id: savedId, length: Number(length) } : { action: 'create', length: Number(length) }) as string
  let removed = false
  return {
    id,
    async release() { await workerClient.retrievalOutput({ action: 'release', id }) },
    async write(offset: bigint, bytes: Uint8Array) {
      if (offset < 0n || offset + BigInt(bytes.length) > length || removed) throw new Error('output write out of range')
      await workerClient.retrievalOutput({ action: 'write', id, offset: Number(offset), bytes })
    },
    async flush() { await workerClient.retrievalOutput({ action: 'flush', id }) },
    async file() { return await workerClient.retrievalOutput({ action: 'file', id }) as File },
    async cleanup() {
      if (removed) return
      await workerClient.retrievalOutput({ action: 'remove', id })
      removed = true
    },
  }
}

// Complete encoded MDU admission for append: preserve the physical allocation
// encoded by each FAT extent, including tombstones and the partial final scalar.
export function validateRetrievalMduPacking(pin: PinnedGeneration, records: readonly RetrievalFile[], ordinal: bigint, bytes: Uint8Array): void {
  if (ordinal < 0n || ordinal >= pin.userMdus || bytes.length !== 8388608) throw new Error('invalid retrieved MDU')
  for (let blob = 0; blob < 64; blob++) {
    const start = ordinal * RAW_MDU + BigInt(blob * RAW_BLOB_BYTES)
    const file = records.find((r) => r.size_bytes > 0n && r.start_offset <= start && r.start_offset + r.size_bytes > start)
    const remaining = file ? file.start_offset + file.size_bytes - start : 0n
    const valid = Number(remaining > BigInt(RAW_BLOB_BYTES) ? BigInt(RAW_BLOB_BYTES) : remaining)
    decodeRetrievalSlice(bytes.subarray(blob * 131072, (blob + 1) * 131072), valid, 0, 0)
  }
}
