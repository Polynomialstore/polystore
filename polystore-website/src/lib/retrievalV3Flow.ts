import { BLOB_SIZE_BYTES } from '../domain/polyfsLayout'
import { decodeRetrievalSlice } from './retrievalFlow'
import { planV3Chunks, type FrozenSessionV3 } from './retrievalV3'
import type { RetrievalV3ChunkAuthority, RetrievalV3Envelope } from './retrievalWire'
import type { RetrievalProofV3Outcome } from './retrievalV3Settlement'

const RAW_BLOB_BYTES = 126_976n

export interface RetrievalV3Progress {
  cursors: Partial<Record<number, bigint>>
  output: { write(offset: bigint, bytes: Uint8Array): Promise<void>; flush(): Promise<void> }
  advance(slot: number, through: bigint): void
  refresh(session: FrozenSessionV3): void
}

export interface RetrievalV3Flow {
  fetch(chunk: RetrievalV3ChunkAuthority, signal?: AbortSignal): Promise<RetrievalV3Envelope>
  verify(chunk: RetrievalV3ChunkAuthority, envelope: RetrievalV3Envelope): Promise<Uint8Array>
  acknowledge(session: FrozenSessionV3, slot: number): Promise<FrozenSessionV3>
  requestProof(session: FrozenSessionV3, slot: number): Promise<RetrievalProofV3Outcome>
  observe(session: FrozenSessionV3): Promise<FrozenSessionV3>
  progress?(chunks: number, logicalBytes: bigint): void
}

export function retrievalV3SlotEnd(session: Pick<FrozenSessionV3, 'last'>, slot: number): bigint {
  const offset = (session.last % 8n - BigInt(slot) + 8n) % 8n
  return session.last - offset
}

export function retrievalV3OutputComplete(session: FrozenSessionV3, cursors: Partial<Record<number, bigint>>): boolean {
  return session.obligations.every((obligation) => (cursors[obligation.slot] ?? -1n) === retrievalV3SlotEnd(session, obligation.slot))
}

export interface RetrievalV3Execution {
  session: FrozenSessionV3
  outcomes: RetrievalProofV3Outcome[]
}

/** Fetch/verify two bounded chunks ahead; writes, flushes and cursors stay ordered. */
export async function executeRetrievalV3(initial: FrozenSessionV3, checkpoint: RetrievalV3Progress, flow: RetrievalV3Flow,
  signal?: AbortSignal): Promise<RetrievalV3Execution> {
  let session = await flow.observe(initial), chunks = 0, logicalBytes = 0n
  const outcomes: RetrievalProofV3Outcome[] = []
  for (const obligation of session.obligations) {
    const bit = 1 << obligation.slot
    const end = retrievalV3SlotEnd(session, obligation.slot)
    const through = checkpoint.cursors[obligation.slot] ?? -1n
    if ((session.ackedMask & bit) && through < end) throw new Error('v3 obligation was acknowledged before durable output completed')
    if (!(session.ackedMask & bit)) {
      const controller = new AbortController()
      const chunkSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const source = planV3Chunks(session, obligation.slot)
      type Pending = { ok: true; chunk: RetrievalV3ChunkAuthority; encoded: Uint8Array } | { ok: false; error: unknown }
      const pending: Promise<Pending>[] = []
      const enqueue = () => {
        while (pending.length < 2) {
          const next = source.next()
          if (next.done) break
          const chunk = next.value, last = chunk.entries[chunk.entries.length - 1].t
          if (last <= (checkpoint.cursors[obligation.slot] ?? -1n)) continue
          pending.push(flow.fetch(chunk, chunkSignal).then((envelope) => flow.verify(chunk, envelope))
            .then((encoded): Pending => ({ ok: true, chunk, encoded }), (error): Pending => ({ ok: false, error })))
        }
      }
      try {
        enqueue()
        while (pending.length) {
          signal?.throwIfAborted()
          const verified = await pending.shift()!
          if (!verified.ok) throw verified.error
          enqueue()
          const { chunk, encoded } = verified
          const last = chunk.entries[chunk.entries.length - 1].t
          const wantedStart = session.file.start_offset + session.rangeStart
          const wantedEnd = wantedStart + session.rangeLength
          for (let i = 0; i < chunk.entries.length; i++) {
            const blobStart = chunk.entries[i].t * RAW_BLOB_BYTES
            const blobEnd = blobStart + RAW_BLOB_BYTES
            const from = blobStart > wantedStart ? blobStart : wantedStart
            const to = blobEnd < wantedEnd ? blobEnd : wantedEnd
            if (from >= to) throw new Error('v3 chunk lies outside the frozen requested range')
            const valid = session.file.start_offset + session.file.size_bytes - blobStart
            const validLength = Number(valid < RAW_BLOB_BYTES ? valid : RAW_BLOB_BYTES)
            const bytes = decodeRetrievalSlice(encoded.subarray(i * BLOB_SIZE_BYTES, (i + 1) * BLOB_SIZE_BYTES), validLength,
              Number(from - blobStart), Number(to - from))
            await checkpoint.output.write(from - wantedStart, bytes)
            logicalBytes += BigInt(bytes.length)
          }
          await checkpoint.output.flush()
          checkpoint.advance(obligation.slot, last)
          chunks++
          flow.progress?.(chunks, logicalBytes)
        }
      } finally {
        controller.abort()
        await Promise.allSettled(pending)
      }
      session = await flow.acknowledge(session, obligation.slot)
      checkpoint.refresh(session)
    }
    if (!(session.settledMask & bit) && !(session.refundedMask & bit)) {
      for (let attempt = 0; attempt < 3 && !(session.settledMask & bit); attempt++) {
        const outcome = await flow.requestProof(session, obligation.slot)
        if (outcome.slot !== undefined && outcome.slot !== obligation.slot) throw new Error('provider proof outcome has the wrong v3 slot')
        outcomes.push(outcome)
        session = await flow.observe(session)
        checkpoint.refresh(session)
        if (outcome.state !== 'accepted' || !outcome.remaining) break
      }
    }
  }
  return { session, outcomes }
}
