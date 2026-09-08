import { account, u64, uint, unhex, type FrozenSession } from './retrieval'
import type { RetrievalSettlementOutcome, RetrievalSettlementSession } from './retrievalSettlement'
import { createRetrievalOutput } from './retrievalFlow'
import { browserRetrievalStore, retrievalIntentKey, type RetrievalStore } from './retrievalTransactions'

export interface RetrievalCheckpointState {
  id: string
  length: bigint
  through: bigint
  confirmed?: number
  unsettled?: number
  firstSettlementIssue?: RetrievalSettlementOutcome
  settlementFrom?: bigint
  cleanupOrdinal?: bigint
  cleanup?: readonly Pick<FrozenSession, 'sessionId' | 'browserTransactionKey'>[]
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
      (saved.settlementFrom !== undefined && (typeof saved.settlementFrom !== 'bigint' || saved.settlementFrom < 0n || saved.settlementFrom > saved.through)) ||
      (saved.cleanupOrdinal !== undefined && (typeof saved.cleanupOrdinal !== 'bigint' || !saved.cleanup || saved.cleanupOrdinal < 0n || saved.cleanupOrdinal > saved.through)) ||
      (saved.unsettled !== undefined && (!Number.isSafeInteger(saved.unsettled) || saved.unsettled < 0)) ||
      (saved.cleanup && (!Array.isArray(saved.cleanup) || !saved.cleanup.length || saved.cleanup.length > 64)) ||
      (saved.pending && (typeof saved.pending.ordinal !== 'bigint' || saved.pending.ordinal <= saved.through || !Array.isArray(saved.pending.sessions) || !saved.pending.sessions.length || saved.pending.sessions.length > 64)))) throw new Error('invalid saved retrieval checkpoint')
    output = await createRetrievalOutput(length, saved?.id)
    const state = saved ?? { id: output.id, length, through: -1n }
    try { store.put(key, state) } catch (error) { if (!saved) await output.cleanup(); else await output.release(); throw error }
    const cursor = retrievalCheckpointCursor(store, key, state)
    return {
      key, output, get state() { return cursor.state }, prepare: cursor.prepare, complete: cursor.complete, cleaned: cursor.cleaned, reconcile: cursor.reconcile,
      async retain() { try { await output.release() } finally { release() } },
      // A successful gateway-free download releases the handle and tab lock,
      // but the checkpoint still owns the output until settlement is final.
      async handoff() {
        if (cursor.state.pending || cursor.state.cleanup) throw new Error('retrieval reconciliation is incomplete')
        if (cursor.state.unsettled) {
          try { await output.release() } finally { release() }
          return undefined
        }
        store.remove(key); release()
        return output.cleanup
      },
      // Append may expose a mutable base only after settlement is complete.
      finish() {
        if (cursor.state.pending || cursor.state.cleanup || cursor.state.unsettled) throw new Error('retrieval reconciliation is incomplete')
        store.remove(key); release()
      },
    }
  } catch (error) { release(); throw error }
}

interface SettlementWave {
  sessions: readonly RetrievalSettlementSession[]
  outcomes: readonly RetrievalSettlementOutcome[]
  proofBase?: string
}
function validateSettlementWave(row: SettlementWave) {
  validateOutcomes(row.sessions, row.outcomes)
  for (const s of row.sessions) {
    unhex(s.sessionId, 32); account(s.payee)
    if (typeof s.pin?.dealId !== 'bigint') throw new Error('invalid settlement deal ID')
    u64(String(s.pin.dealId))
    if (!uint(s.window?.blobCount, 64) || typeof s.browserTransactionKey !== 'string' || !/^open:[0-9a-f]{64}$/.test(s.browserTransactionKey)) throw new Error('invalid settlement journal reference or range')
  }
}
const unknownSettlement = 'Provider proof request outcome is unknown. Retry this saved retrieval to reconcile the same session; its ACK is already committed.'
function validateOutcomes(sessions: readonly Pick<FrozenSession, 'sessionId'>[], outcomes: readonly RetrievalSettlementOutcome[]) {
  if (!sessions.length || sessions.length > 64 || outcomes.length !== sessions.length ||
    new Set(sessions.map((s) => s.sessionId)).size !== sessions.length ||
    outcomes.some((o, i) => o.sessionId !== sessions[i].sessionId || !['committed', 'pending', 'failed', 'unavailable'].includes(o.state))) throw new Error('invalid settlement checkpoint outcomes')
}

export function retrievalCheckpointCursor(store: RetrievalStore, key: string, initial: RetrievalCheckpointState) {
  let state = initial
  const save = (next: RetrievalCheckpointState) => { store.put(key, next); state = next }
  const waveKey = (ordinal: bigint) => `${key}:settlement:${ordinal}`
  const cleaned = () => {
    // Journal deletion has already succeeded. Retain cleanup in the cursor if
    // either removal or the following cursor write fails; both are retryable.
    if (state.cleanupOrdinal !== undefined) store.remove(waveKey(state.cleanupOrdinal))
    save({ ...state, cleanup: undefined, cleanupOrdinal: undefined })
  }
  return {
    get state() { return state },
    prepare(ordinal: bigint, sessions: readonly FrozenSession[], proofBase?: string) {
      if (state.cleanup) throw new Error('retrieval journal cleanup is pending')
      if (!sessions.length || sessions.length > 64 || ordinal <= state.through) throw new Error('invalid verified retrieval checkpoint')
      if (state.pending && (state.pending.ordinal !== ordinal || state.pending.sessions.map((s) => s.sessionId).join() !== sessions.map((s) => s.sessionId).join())) throw new Error('unreconciled retrieval checkpoint')
      save({ ...state, pending: { ordinal, sessions, proofBase: state.pending?.proofBase ?? proofBase } })
    },
    cleaned,
    complete(ordinal: bigint, outcomes: readonly RetrievalSettlementOutcome[]) {
      if (!state.pending || state.pending.ordinal !== ordinal) throw new Error('missing verified retrieval checkpoint')
      const { sessions, proofBase } = state.pending
      validateOutcomes(sessions, outcomes)
      if (outcomes.some((o) => o.responseUnknown)) throw new Error(unknownSettlement)
      const unsettled = outcomes.filter((o) => o.state !== 'committed').length
      // Only a committed ACK reaches this point. Persist the whole original
      // wave before advancing bytes: its ordered IDs also identify the ACK
      // journal, even if only one provider still needs settlement.
      if (unsettled) store.put(waveKey(ordinal), {
        sessions: sessions.map((s) => ({ sessionId: s.sessionId, payee: s.payee, pin: { dealId: s.pin.dealId }, window: { blobCount: s.window.blobCount }, browserTransactionKey: s.browserTransactionKey })),
        outcomes, proofBase,
      } satisfies SettlementWave)
      save({ ...state, through: ordinal, pending: undefined,
        cleanup: unsettled ? undefined : sessions, cleanupOrdinal: unsettled ? undefined : ordinal,
        settlementFrom: state.settlementFrom ?? (unsettled ? ordinal : undefined),
        confirmed: (state.confirmed ?? 0) + sessions.length,
        unsettled: (state.unsettled ?? 0) + unsettled,
        firstSettlementIssue: state.firstSettlementIssue ?? outcomes.find((o) => o.state !== 'committed') })
    },
    async reconcile(
      settle: (sessions: readonly RetrievalSettlementSession[], proofBase?: string) => Promise<readonly RetrievalSettlementOutcome[]>,
      forget: (sessions: readonly Pick<FrozenSession, 'sessionId' | 'browserTransactionKey'>[]) => Promise<void>,
      signal?: AbortSignal,
    ) {
      if (state.cleanup) { await forget(state.cleanup); cleaned() }
      if (state.settlementFrom === undefined) return
      let unsettled = 0, firstSettlementIssue: RetrievalSettlementOutcome | undefined
      // Rows are keyed by MDU ordinal, never collected into a file-sized list.
      // A reload reads at most one <=64-session wave at a time.
      for (let ordinal = state.settlementFrom; ordinal <= state.through; ordinal++) {
        signal?.throwIfAborted()
        const row = store.get<SettlementWave>(waveKey(ordinal))
        if (!row) continue
        validateSettlementWave(row)
        const remaining = row.sessions.filter((_, i) => row.outcomes[i].state !== 'committed')
        if (remaining.length) {
          const outcomes = await settle(remaining, row.proofBase)
          validateOutcomes(remaining, outcomes)
          let next = 0
          row.outcomes = row.outcomes.map((o) => o.state === 'committed' ? o : outcomes[next++])
          store.put(waveKey(ordinal), row)
        }
        if (row.outcomes.every((o) => o.state === 'committed')) {
          // Cursor cleanup must be durable before removing either transaction
          // journal. Replay never confirms or funds these already ACKed IDs.
          save({ ...state, cleanup: row.sessions, cleanupOrdinal: ordinal })
          await forget(row.sessions); cleaned()
        } else {
          unsettled += row.outcomes.filter((o) => o.state !== 'committed').length
          firstSettlementIssue ??= row.outcomes.find((o) => o.state !== 'committed')
          if (row.outcomes.some((o) => o.responseUnknown)) throw new Error(unknownSettlement)
        }
      }
      // Recount from durable rows instead of trusting an increment across two
      // localStorage writes. A crash between them cannot double-count progress.
      save({ ...state, unsettled, firstSettlementIssue, settlementFrom: unsettled ? state.settlementFrom : undefined })
    },
  }
}
