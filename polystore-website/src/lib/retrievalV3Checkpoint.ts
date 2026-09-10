import { createRetrievalOutput } from './retrievalFlow'
import { planV3Chunks, sameFrozenGenerationV3, type FrozenGenerationV3, type FrozenSessionV3 } from './retrievalV3'
import type { RetrievalFile } from './retrieval'
import { browserRetrievalStore, retrievalIntentKey, type RetrievalStore } from './retrievalTransactions'

export interface RetrievalV3CheckpointState {
  version: 3
  id: string
  length: bigint
  authority: FrozenGenerationV3
  fileRecordIndex: number
  file: RetrievalFile
  rangeStart: bigint
  rangeLength: bigint
  session?: FrozenSessionV3
  cursors: Partial<Record<number, bigint>>
}

export async function retrievalV3CheckpointKey(intent: unknown): Promise<string> {
  return 'output-v3:' + await retrievalIntentKey(intent)
}

function sameFile(a: RetrievalFile, b: RetrievalFile): boolean {
  return a.path === b.path && a.start_offset === b.start_offset && a.size_bytes === b.size_bytes && a.flags === b.flags
}

function sessionMatchesState(state: RetrievalV3CheckpointState, session: FrozenSessionV3): boolean {
  return sameFrozenGenerationV3(state.authority, session.authority) && state.fileRecordIndex === session.fileRecordIndex &&
    sameFile(state.file, session.file) && state.rangeStart === session.rangeStart && state.rangeLength === session.rangeLength
}

function cursorIsChunkBoundary(session: FrozenSessionV3, slot: number, through: bigint): boolean {
  if (through < 0n || through % 8n !== BigInt(slot)) return false
  for (const chunk of planV3Chunks(session, slot)) if (chunk.entries[chunk.entries.length - 1].t === through) return true
  return false
}

export function readRetrievalV3Checkpoint(key: string, store: RetrievalStore = browserRetrievalStore()): RetrievalV3CheckpointState | undefined {
  const saved = store.get<RetrievalV3CheckpointState>(key)
  if (!saved) return undefined
  if (saved.version !== 3 || typeof saved.id !== 'string' || !saved.id || typeof saved.length !== 'bigint' || saved.length < 0n || saved.length > 1n << 30n ||
    typeof saved.rangeStart !== 'bigint' || typeof saved.rangeLength !== 'bigint' || saved.rangeLength !== saved.length || !saved.authority || !saved.file ||
    !Number.isSafeInteger(saved.fileRecordIndex) || saved.fileRecordIndex < 0 || typeof saved.cursors !== 'object' || saved.cursors === null ||
    (saved.session !== undefined && !sessionMatchesState(saved, saved.session)) ||
    Object.entries(saved.cursors).some(([rawSlot, through]) => {
      if (!/^[0-7]$/.test(rawSlot) || typeof through !== 'bigint' || !saved.session) return true
      return !cursorIsChunkBoundary(saved.session, Number(rawSlot), through)
    })) throw new Error('invalid saved v3 retrieval checkpoint')
  return saved
}

export async function openRetrievalV3Checkpoint(key: string, initial?: Omit<RetrievalV3CheckpointState, 'version' | 'id' | 'cursors'>) {
  if (!navigator.locks) throw new Error('browser retrieval recovery locks are unavailable')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error('this retrieval is already running in another tab')); return }
      resolve(); await held
    }).catch(reject)
  })
  try {
    const store = browserRetrievalStore()
    const saved = readRetrievalV3Checkpoint(key, store)
    if (!saved && !initial) throw new Error('missing frozen v3 retrieval checkpoint')
    if (saved && initial && (saved.length !== initial.length || saved.rangeStart !== initial.rangeStart || saved.rangeLength !== initial.rangeLength ||
      saved.fileRecordIndex !== initial.fileRecordIndex || !sameFile(saved.file, initial.file) || !sameFrozenGenerationV3(saved.authority, initial.authority))) {
      throw new Error('saved v3 retrieval does not match request')
    }
    const source = saved ?? initial!
    const output = await createRetrievalOutput(source.length, saved?.id)
    let state: RetrievalV3CheckpointState = saved ?? { version: 3, id: output.id, ...initial!, cursors: {} }
    const save = (next: RetrievalV3CheckpointState) => { store.put(key, next); state = next }
    try { store.put(key, state) } catch (error) { if (saved) await output.release(); else await output.cleanup(); throw error }
    return {
      key, output, get state() { return state }, get cursors() { return state.cursors },
      bind(session: FrozenSessionV3) {
        if (!sessionMatchesState(state, session) || (state.session && state.session.sessionId !== session.sessionId)) throw new Error('saved v3 retrieval is bound to another request')
        save({ ...state, session })
      },
      advance(slot: number, through: bigint) {
        const current = state.cursors[slot] ?? -1n
        if (!Number.isSafeInteger(slot) || slot < 0 || slot > 7 || through <= current) throw new Error('invalid v3 retrieval cursor')
        save({ ...state, cursors: { ...state.cursors, [slot]: through } })
      },
      refresh(session: FrozenSessionV3) {
        if (!state.session || state.session.sessionId !== session.sessionId || !sessionMatchesState(state, session)) throw new Error('v3 session checkpoint mismatch')
        save({ ...state, session })
      },
      async retain() { try { await output.release() } finally { release() } },
      async handoff() {
        // Keep verified bytes under the frozen request key so settlement can
        // resume and repeated downloads cannot open another session.
        try { await output.release() } finally { release() }
        return undefined
      },
      async discard() { try { store.remove(key); await output.cleanup() } finally { release() } },
    }
  } catch (error) { release(); throw error }
}
