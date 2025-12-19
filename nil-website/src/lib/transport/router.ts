import type {
  BackendName,
  DecisionTrace,
  RoutePreference,
  TransportCandidate,
  TransportFailure,
  TransportOp,
  TransportOutcome,
} from './types'
import { classifyError, isRetryable, isTerminal, TransportError } from './errors'

export interface TransportRouterOptions {
  preference: RoutePreference
  timeoutMs?: number
  maxAttemptsPerBackend?: number
  maxTotalAttempts?: number
}

export class TransportTraceError extends TransportError {
  readonly trace: DecisionTrace

  constructor(message: string, trace: DecisionTrace) {
    super(message, 'unknown')
    this.trace = trace
  }
}

export function orderCandidates<T>(
  preference: RoutePreference,
  candidates: TransportCandidate<T>[],
): TransportCandidate<T>[] {
  if (preference === 'auto') {
    return candidates
  }
  const preferred: BackendName = preference === 'prefer_gateway' ? 'gateway' : 'direct_sp'
  return [...candidates].sort((a, b) => {
    if (a.backend === b.backend) return 0
    return a.backend === preferred ? -1 : 1
  })
}

export async function executeWithFallback<T>(
  op: TransportOp,
  candidates: TransportCandidate<T>[],
  opts: TransportRouterOptions,
): Promise<TransportOutcome<T>> {
  const startedAtMs = Date.now()
  const ordered = orderCandidates(opts.preference, candidates)
  const attempts: DecisionTrace['attempts'] = []

  let totalAttempts = 0
  const maxTotal = opts.maxTotalAttempts ?? ordered.length
  const maxPerBackend = opts.maxAttemptsPerBackend ?? 1

  for (const candidate of ordered) {
    let backendAttempts = 0
    while (backendAttempts < maxPerBackend && totalAttempts < maxTotal) {
      totalAttempts += 1
      backendAttempts += 1

      const controller = new AbortController()
      const timeoutId = opts.timeoutMs ? globalThis.setTimeout(() => controller.abort(), opts.timeoutMs) : null
      const attemptStart = Date.now()

      try {
        const data = await candidate.execute(controller.signal)
        const elapsedMs = Date.now() - attemptStart
        attempts.push({
          backend: candidate.backend,
          endpoint: candidate.endpoint,
          ok: true,
          elapsedMs,
        })
        const finishedAtMs = Date.now()
        return {
          data,
          backend: candidate.backend,
          trace: {
            op,
            preference: opts.preference,
            startedAtMs,
            finishedAtMs,
            attempts,
            chosen: { backend: candidate.backend, endpoint: candidate.endpoint },
          },
        }
      } catch (err) {
        const elapsedMs = Date.now() - attemptStart
        const { errorClass, status, message } = classifyError(err)
        attempts.push({
          backend: candidate.backend,
          endpoint: candidate.endpoint,
          ok: false,
          status,
          errorClass,
          errorMessage: message,
          elapsedMs,
        })

        if (isTerminal(errorClass)) {
          const finishedAtMs = Date.now()
          const trace: DecisionTrace = {
            op,
            preference: opts.preference,
            startedAtMs,
            finishedAtMs,
            attempts,
            chosen: null,
          }
          throw new TransportTraceError(`Terminal ${op} failure`, trace)
        }

        if (!isRetryable(errorClass)) {
          break
        }
      } finally {
        if (timeoutId) {
          globalThis.clearTimeout(timeoutId)
        }
      }
    }
  }

  const finishedAtMs = Date.now()
  const trace: DecisionTrace = {
    op,
    preference: opts.preference,
    startedAtMs,
    finishedAtMs,
    attempts,
    chosen: null,
  }
  throw new TransportTraceError(`All ${op} attempts failed`, trace)
}

export function attachTraceError(err: unknown, trace: DecisionTrace): TransportFailure {
  if (err instanceof Error) {
    return { error: err, trace }
  }
  return { error: new Error('transport failure'), trace }
}
