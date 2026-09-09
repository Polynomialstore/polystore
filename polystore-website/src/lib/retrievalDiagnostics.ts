// Opt-in, observational test hook. Never feeds payment or recovery decisions.
export type RetrievalDiagnostic = { phase: string; atMs: number; edge?: 'start' | 'end'; sessionId?: string; offset?: number; bytes?: number; sessionIds?: readonly string[]; height?: string }
export function retrievalDiagnostic(event: Omit<RetrievalDiagnostic, 'atMs'>): void {
  if (typeof window === 'undefined') return
  const observer = (window as unknown as { __polystoreRetrievalDiagnostic?: (event: RetrievalDiagnostic) => void }).__polystoreRetrievalDiagnostic
  if (observer) { try { observer({ ...event, atMs: performance.now() }) } catch { /* Diagnostics cannot alter retrieval. */ } }
}
export async function timeRetrieval<T>(phase: string, work: () => Promise<T>, sessionId?: string): Promise<T> {
  retrievalDiagnostic({ phase, edge: 'start', sessionId })
  try { return await work() }
  finally { retrievalDiagnostic({ phase, edge: 'end', sessionId }) }
}
