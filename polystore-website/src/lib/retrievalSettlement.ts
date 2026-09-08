import { account, readBoundedResponse, record, unhex, uint, type FrozenSession } from './retrieval'
import { isTrustedLocalGatewayBase } from './transport/mode'

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
  gatewayBase?: string
  signal?: AbortSignal
  fetchFn?: typeof fetch
}

function pending(session: RetrievalSettlementSession, detail: string, txHash?: string): RetrievalSettlementOutcome {
  return { state: 'pending', sessionId: session.sessionId, txHash,
    message: `Provider settlement pending for session ${session.sessionId}${txHash ? ` (transaction ${txHash})` : ' (transaction outcome unknown)'}. ${detail} Reconcile this same session with the provider; do not blindly rebroadcast.` }
}

async function requestProof(session: RetrievalSettlementSession, base: string, options: Pick<SettlementOptions<RetrievalSettlementSession>, 'fetchFn' | 'signal'>): Promise<RetrievalSettlementOutcome> {
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])])
  try {
    signal.throwIfAborted()
    const response = await (options.fetchFn ?? fetch)(`${base.replace(/\/$/, '')}/gateway/session-proof?deal_id=${session.pin.dealId}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.sessionId, provider: session.payee }),
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
      return { state: 'committed', sessionId: session.sessionId, txHash }
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
  const base = options.gatewayBase
  if (!base || !isTrustedLocalGatewayBase(base) || !/^https?:\/\//.test(base)) {
    return sessions.map((session) => ({ state: 'unavailable', sessionId: session.sessionId,
      message: `Provider settlement unavailable for session ${session.sessionId}: the trusted local gateway is unavailable. Verified output and owner confirmation are preserved; provider proof submission is still required.` }))
  }
  const outcomes: RetrievalSettlementOutcome[] = []
  // The ACK has committed. Canceling the download cannot undo it or suppress
  // its authorized provider request. One deadline bounds the entire wave,
  // including the maximum 64 sessions; later requests stop at that deadline.
  const proofSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  for (const session of sessions) outcomes.push(await requestProof(session, base, { ...options, signal: proofSignal }))
  return outcomes
}
