import type { ErrorClass } from './types'

export class TransportError extends Error {
  readonly errorClass: ErrorClass
  readonly status?: number

  constructor(message: string, errorClass: ErrorClass, status?: number) {
    super(message)
    this.name = 'TransportError'
    this.errorClass = errorClass
    this.status = status
  }
}

export function classifyError(err: unknown): { errorClass: ErrorClass; status?: number; message: string } {
  if (err instanceof TransportError) {
    return { errorClass: err.errorClass, status: err.status, message: err.message }
  }

  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return { errorClass: 'timeout', message: err.message }
    }
    const msg = err.message || 'unknown error'
    if (/provider mismatch/i.test(msg)) {
      return { errorClass: 'provider_mismatch', message: msg }
    }
    if (/cors/i.test(msg)) {
      return { errorClass: 'cors', message: msg }
    }
    if (/failed to fetch|networkerror|network error/i.test(msg)) {
      return { errorClass: 'connection_refused', message: msg }
    }
    if (/dns|not known|not found/i.test(msg)) {
      return { errorClass: 'dns', message: msg }
    }
    return { errorClass: 'unknown', message: msg }
  }

  return { errorClass: 'unknown', message: 'unknown error' }
}

export function classifyStatus(status: number): ErrorClass {
  if (status >= 500) return 'http_5xx'
  if (status >= 400) return 'http_4xx'
  return 'unknown'
}

export function isRetryable(errorClass: ErrorClass): boolean {
  return errorClass === 'timeout' || errorClass === 'connection_refused' || errorClass === 'dns' || errorClass === 'http_5xx'
}

export function isTerminal(errorClass: ErrorClass): boolean {
  return errorClass === 'provider_mismatch' || errorClass === 'invalid_response'
}
