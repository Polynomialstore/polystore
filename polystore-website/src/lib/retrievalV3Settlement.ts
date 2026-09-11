import { readBoundedResponse, record, unhex, uint } from './retrieval'

const MAX_OUTCOME_BYTES = 16 * 1024
const REQUEST_TIMEOUT_MS = 95_000

export interface RetrievalProofV3Outcome {
  state: 'accepted' | 'pending' | 'failed' | 'busy' | 'unknown'
  sessionId: string
  slot?: number
  proofCount?: number
  remaining?: number
  txHash?: string
  message?: string
  responseUnknown?: true
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('unknown v3 proof outcome field')
}

/**
 * Parses the provider's bounded diagnostic response. Canonical chain state,
 * rather than this HTTP outcome, remains the payment authority.
 */
export async function requestRetrievalProofV3(base: string, request: { sessionId: string; slot: number },
  signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<RetrievalProofV3Outcome> {
  unhex(request.sessionId, 32)
  uint(request.slot, 7)
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const response = await fetchFn(`${base.replace(/\/$/, '')}/gateway/retrieval/session-proof/continue`, {
      method: 'POST', redirect: 'error', signal: activeSignal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: request.sessionId, slot: request.slot }),
    })
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); throw new Error('invalid v3 proof outcome content type')
    }
    const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedResponse(response, MAX_OUTCOME_BYTES, activeSignal))))
    if (response.status === 429) {
      exactKeys(value, ['error', 'hint'])
      if (!['retrieval submission busy', 'retrieval continuation busy'].includes(String(value.error)) || typeof value.hint !== 'string') throw new Error('invalid busy v3 proof outcome')
      return { state: 'busy', sessionId: request.sessionId, message: value.hint.slice(0, 256) }
    }
    if (value.recorded_session_id !== undefined || value.retry_required !== undefined) {
      exactKeys(value, ['status', 'recorded_session_id', 'tx_hash', 'proof_count', 'cleanup_status', 'retry_required', 'error'])
      if (value.retry_required !== true || typeof value.recorded_session_id !== 'string' || typeof value.status !== 'string') throw new Error('invalid v3 proof recovery outcome')
      return { state: 'pending', sessionId: request.sessionId,
        message: 'The provider is reconciling another retained signer operation; retry this same session after it completes.' }
    }
    exactKeys(value, ['status', 'session_id', 'tx_hash', 'slot', 'proof_count', 'remaining', 'cleanup_status', 'error', 'timing'])
    if (value.session_id !== request.sessionId || typeof value.status !== 'string' || typeof value.tx_hash !== 'string' ||
      (value.tx_hash !== '' && !/^[0-9a-fA-F]{64}$/.test(value.tx_hash)) || typeof value.cleanup_status !== 'string' ||
      !['complete', 'pending', 'retained'].includes(value.cleanup_status) || (value.error !== undefined && typeof value.error !== 'string')) throw new Error('mismatched v3 proof outcome')
    const slot = uint(value.slot, 7), proofCount = uint(value.proof_count, 64), remaining = uint(value.remaining, 132)
    const txHash = value.tx_hash || undefined
    if (response.status === 200 && (value.status === 'success' || value.status === 'reconciled')) {
      return { state: 'accepted', sessionId: request.sessionId, slot, proofCount, remaining, txHash }
    }
    if (response.status === 202 && value.status === 'pending') return { state: 'pending', sessionId: request.sessionId, slot, proofCount, remaining, txHash }
    if (response.status === 409 && value.status === 'failed') return { state: 'failed', sessionId: request.sessionId, slot, proofCount, remaining, txHash,
      message: typeof value.error === 'string' ? value.error.slice(0, 256) : 'provider retained a failed proof submission' }
    throw new Error('unexpected v3 proof outcome')
  } catch (error) {
    signal?.throwIfAborted()
    return { state: 'unknown', sessionId: request.sessionId, responseUnknown: true,
      message: error instanceof Error ? error.message : 'no valid provider proof response' }
  }
}
