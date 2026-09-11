import { account, readBoundedResponse, record, unhex, uint, type FrozenSession } from './retrieval'

const MAX_OUTCOME_BYTES = 16 * 1024
// The provider waits up to 90 seconds before returning its durable pending state.
const REQUEST_TIMEOUT_MS = 95_000

export interface RetrievalSettlementOutcome {
  state: 'committed' | 'pending' | 'failed' | 'unavailable'
  sessionId: string
  txHash?: string
  responseUnknown?: true
  message?: string
}

// Already-ACKed recovery needs only the frozen request identity. Metadata,
// challenge contexts and decoding slices remain in the active retrieval flow.
export type RetrievalSettlementSession = Pick<FrozenSession, 'sessionId' | 'payee' | 'browserTransactionKey'> & {
  pin: Pick<FrozenSession['pin'], 'dealId'>
  window: Pick<FrozenSession['window'], 'blobCount'>
}
interface SettlementOptions<S extends RetrievalSettlementSession> {
  confirm: (sessions: readonly S[]) => Promise<void>
  onConfirmed?: () => void
  resolveProviderBase?: (provider: string, signal: AbortSignal) => Promise<string | undefined>
  gatewayBase?: string
  signal?: AbortSignal
  fetchFn?: typeof fetch
}

function pending(session: RetrievalSettlementSession, detail: string, txHash?: string): RetrievalSettlementOutcome {
  return { state: 'pending', sessionId: session.sessionId, txHash,
    message: `Provider settlement pending for session ${session.sessionId}${txHash ? ` (transaction ${txHash})` : ' (transaction outcome unknown)'}. ${detail} Reconcile this same session with the provider; do not blindly rebroadcast.` }
}

function withSignal<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      complete()
    }
    const abort = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()
    Promise.resolve().then(start).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

async function requestProof(session: RetrievalSettlementSession, base: string, throughGateway: boolean, options: Pick<SettlementOptions<RetrievalSettlementSession>, 'fetchFn' | 'signal'>): Promise<RetrievalSettlementOutcome> {
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])])
  try {
    signal.throwIfAborted()
    const path = throughGateway ? '/gateway/retrieval/session-proof/continue' : '/sp/retrieval/session-proof/continue'
    const response = await (options.fetchFn ?? fetch)(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.sessionId }),
    })
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel()
      throw new Error('invalid outcome content type')
    }
    const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedResponse(response, MAX_OUTCOME_BYTES, signal))))
    // Preflight errors have no transaction outcome. A gateway 5xx may follow a
    // broadcast, so only explicit client rejection is classified as failed.
    if (response.status >= 400 && response.status < 500 && value.status === undefined) {
      if (Object.keys(value).some((k) => !['error', 'hint'].includes(k)) || typeof value.error !== 'string' ||
          (value.hint !== undefined && typeof value.hint !== 'string')) throw new Error('invalid rejection outcome')
      return { state: 'failed', sessionId: session.sessionId,
        message: `Provider settlement request rejected for session ${session.sessionId} (HTTP ${response.status}): ${value.error.slice(0, 256)}` }
    }
    if (Object.keys(value).some((k) => !['status', 'session_id', 'proof_count', 'tx_hash', 'cleanup_status', 'error'].includes(k)) ||
        value.session_id !== session.sessionId || uint(value.proof_count, 64) !== session.window.blobCount ||
        typeof value.tx_hash !== 'string' || (value.tx_hash !== '' && !/^[0-9a-fA-F]{64}$/.test(value.tx_hash)) ||
        (value.cleanup_status !== undefined && (typeof value.cleanup_status !== 'string' || !['complete', 'pending', 'retained'].includes(value.cleanup_status))) ||
        (value.error !== undefined && typeof value.error !== 'string')) throw new Error('mismatched or malformed outcome')
    const txHash = value.tx_hash || undefined
    if (response.status === 200 && (value.status === 'reconciled' || (value.status === 'success' && txHash))) {
      if (value.cleanup_status === 'complete') return { state: 'committed', sessionId: session.sessionId, txHash }
      return { state: 'pending', sessionId: session.sessionId, txHash,
        message: `Provider settlement is committed for session ${session.sessionId}${txHash ? ` (transaction ${txHash})` : ''}, but durable provider cleanup is pending. Reconcile this same session with the provider; do not rebroadcast.` }
    }
    if (response.status === 202 && value.status === 'pending') return pending(session, 'The provider retained the proof and submission state.', txHash)
    if (response.status === 409 && value.status === 'failed') {
      return { state: 'failed', sessionId: session.sessionId, txHash,
        message: `Provider settlement failed for session ${session.sessionId}${txHash ? ` (transaction ${txHash})` : ''}. The provider retained the proof for diagnosis.` }
    }
    throw new Error('unexpected outcome status')
  } catch {
    // Never discard verified bytes or ACK state because an HTTP response was
    // lost. The provider owns durable reconciliation, including no-hash cases.
    return { ...pending(session, 'No valid final response was received.'), responseUnknown: true }
  }
}

/** Called only after verified output is flushed. ACK failure prevents every POST. */
export async function confirmAndRequestRetrievalProofs<S extends RetrievalSettlementSession>(sessions: readonly S[], options: SettlementOptions<S>): Promise<RetrievalSettlementOutcome[]> {
  if (!sessions.length || sessions.length > 64 || new Set(sessions.map((s) => s.sessionId)).size !== sessions.length) throw new Error('invalid settlement session list')
  for (const session of sessions) { unhex(session.sessionId, 32); account(session.payee); if (!uint(session.window.blobCount, 64)) throw new Error('empty settlement proof range') }
  await options.confirm(sessions)
  options.onConfirmed?.()
  const outcomes: RetrievalSettlementOutcome[] = []
  // The ACK has committed. Canceling the download cannot undo it or suppress
  // its authorized provider request. One deadline bounds the entire wave,
  // including the maximum 64 sessions; later requests stop at that deadline.
  const proofSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  // Providers verify that the frozen payee is their actual signing account.
  // Different payees can submit concurrently; a shared deputy stays serial.
  const byPayee = new Map<string, number[]>()
  sessions.forEach((session, index) => {
    const indexes = byPayee.get(session.payee) ?? []
    indexes.push(index)
    byPayee.set(session.payee, indexes)
  })
  const groups = Array.from(byPayee.values())
  let nextGroup = 0
  const worker = async () => {
    while (nextGroup < groups.length) {
      const indexes = groups[nextGroup++]
      let base: string | undefined
      const throughGateway = Boolean(options.gatewayBase)
      try {
        base = options.gatewayBase || (options.resolveProviderBase
          ? await withSignal(() => options.resolveProviderBase!(sessions[indexes[0]].payee, proofSignal), proofSignal)
          : undefined)
      } catch { /* unavailable below */ }
      for (const index of indexes) {
        const session = sessions[index]
        if (proofSignal.aborted || !base || !/^https?:\/\//.test(base)) {
          const reason = proofSignal.aborted ? 'the proof request deadline expired before dispatch' : 'the provider endpoint could not be resolved'
          outcomes[index] = { state: 'unavailable', sessionId: session.sessionId,
            message: `Provider settlement unavailable for session ${session.sessionId}: ${reason}. Verified output and owner confirmation are preserved; provider proof submission is still required. Use the file menu's provider download action to retry settlement using the saved bytes.` }
          continue
        }
        outcomes[index] = await requestProof(session, base, throughGateway, { ...options, signal: proofSignal })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, worker))
  return outcomes
}
