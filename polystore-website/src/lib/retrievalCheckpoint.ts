import type { FrozenSession } from './retrieval'
import type { RetrievalSettlementOutcome } from './retrievalSettlement'
import { createRetrievalOutput } from './retrievalFlow'
import { browserRetrievalStore, retrievalIntentKey, type RetrievalStore } from './retrievalTransactions'

export interface RetrievalCheckpointState {
  id: string
  length: bigint
  through: bigint
  confirmed?: number
  unsettled?: number
  firstSettlementIssue?: RetrievalSettlementOutcome
  cleanup?: readonly FrozenSession[]
  pending?: { ordinal: bigint; sessions: readonly FrozenSession[]; proofBase?: string }
}
// The persisted cursor describes bytes already verified and flushed by this
// origin, not untrusted provider data. A pending wave is recorded BEFORE ACK.
// Retry uses this same output and these same sessions, including after reload.
export async function openRetrievalCheckpoint(intent: unknown, length: bigint) {
  const key = 'output:' + await retrievalIntentKey(intent)
  if (!navigator.locks) throw new Error('browser retrieval recovery locks are unavailable')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error('this retrieval is already running in another tab')); return }
      resolve(); await held
    }).catch(reject)
  })
  let output: Awaited<ReturnType<typeof createRetrievalOutput>>
  try {
    const store = browserRetrievalStore()
    const saved = store.get<RetrievalCheckpointState>(key)
    if (saved && (saved.length !== length || typeof saved.through !== 'bigint' || saved.through < -1n ||
      (saved.cleanup && (!Array.isArray(saved.cleanup) || !saved.cleanup.length || saved.cleanup.length > 64)) ||
      (saved.pending && (typeof saved.pending.ordinal !== 'bigint' || saved.pending.ordinal <= saved.through || !Array.isArray(saved.pending.sessions) || !saved.pending.sessions.length || saved.pending.sessions.length > 64)))) throw new Error('invalid saved retrieval checkpoint')
    output = await createRetrievalOutput(length, saved?.id)
    const state = saved ?? { id: output.id, length, through: -1n }
    try { store.put(key, state) } catch (error) { if (!saved) await output.cleanup(); else await output.release(); throw error }
    const cursor = retrievalCheckpointCursor(store, key, state)
    return {
      key, output, get state() { return cursor.state }, prepare: cursor.prepare, complete: cursor.complete, cleaned: cursor.cleaned,
      async retain() { try { await output.release() } finally { release() } },
      // Called only after the complete file has been handed to the existing
      // consumer. Success follows normal OPFS cleanup; uncertainty retains it.
      finish() {
        if (cursor.state.pending || cursor.state.cleanup) throw new Error('retrieval reconciliation is incomplete')
        store.remove(key); release()
      },
    }
  } catch (error) { release(); throw error }
}

export function retrievalCheckpointCursor(store: RetrievalStore, key: string, initial: RetrievalCheckpointState) {
  let state = initial
  return {
    get state() { return state },
    prepare(ordinal: bigint, sessions: readonly FrozenSession[], proofBase?: string) {
      if (state.cleanup) throw new Error('retrieval journal cleanup is pending')
      if (!sessions.length || sessions.length > 64 || ordinal <= state.through) throw new Error('invalid verified retrieval checkpoint')
      if (state.pending && (state.pending.ordinal !== ordinal || state.pending.sessions.map((s) => s.sessionId).join() !== sessions.map((s) => s.sessionId).join())) throw new Error('unreconciled retrieval checkpoint')
      const next = { ...state, pending: { ordinal, sessions, proofBase: state.pending?.proofBase ?? proofBase } }
      store.put(key, next); state = next
    },
    cleaned() {
      const next = { ...state, cleanup: undefined }
      store.put(key, next); state = next
    },
    complete(ordinal: bigint, outcomes: readonly RetrievalSettlementOutcome[]) {
      if (!state.pending || state.pending.ordinal !== ordinal) throw new Error('missing verified retrieval checkpoint')
      const next = { ...state, through: ordinal, pending: undefined, cleanup: state.pending.sessions, confirmed: (state.confirmed ?? 0) + state.pending.sessions.length,
        unsettled: (state.unsettled ?? 0) + outcomes.filter((o) => o.state !== 'committed').length,
        firstSettlementIssue: state.firstSettlementIssue ?? outcomes.find((o) => o.state !== 'committed') }
      store.put(key, next); state = next
    },
  }
}
