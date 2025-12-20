export type TransportOp =
  | 'upload'
  | 'fetch'
  | 'list_files'
  | 'slab'
  | 'plan'
  | 'manifest_info'
  | 'mdu_kzg'

export type RoutePreference = 'auto' | 'prefer_gateway' | 'prefer_direct_sp' | 'prefer_p2p'

export type BackendName = 'gateway' | 'direct_sp' | 'libp2p'

export type ErrorClass =
  | 'timeout'
  | 'connection_refused'
  | 'dns'
  | 'http_429'
  | 'http_4xx'
  | 'http_5xx'
  | 'cors'
  | 'provider_mismatch'
  | 'invalid_response'
  | 'unknown'

export interface TransportAttempt {
  backend: BackendName
  endpoint: string
  ok: boolean
  status?: number
  errorClass?: ErrorClass
  errorMessage?: string
  elapsedMs: number
}

export interface DecisionTrace {
  op: TransportOp
  preference: RoutePreference
  startedAtMs: number
  finishedAtMs: number
  attempts: TransportAttempt[]
  chosen: { backend: BackendName; endpoint: string } | null
}

export interface TransportOutcome<T> {
  data: T
  backend: BackendName
  trace: DecisionTrace
}

export interface TransportFailure {
  error: Error
  trace: DecisionTrace
}

export interface TransportCandidate<T> {
  backend: BackendName
  endpoint: string
  execute: (signal: AbortSignal) => Promise<T>
}
