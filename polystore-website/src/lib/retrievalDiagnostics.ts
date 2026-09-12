// Opt-in, observational test hook. Never feeds payment or recovery decisions.
export type RetrievalDiagnostic = { phase: string; atMs: number; edge?: 'start' | 'end'; sessionId?: string; chunkId?: string; slot?: number; offset?: number; bytes?: number; sessionIds?: readonly string[]; height?: string; durationMs?: number; calls?: number }

// Server durations are observations from a different clock, never timestamps
// to subtract from performance.now(). Ignore arbitrary metric names/content.
export function retrievalServerTiming(header: string | null, context: Pick<RetrievalDiagnostic, 'sessionId' | 'chunkId' | 'slot'>) {
  if (!header || header.length > 4096) return
  const seen = new Set<string>()
  for (const field of header.split(',')) {
    const match = /^\s*ps3([pg])_(admission|lcd|keys|generation|metadata|index|read|hash|path|encode|endpoint);dur=(\d+(?:\.\d{1,3})?);desc="(\d+)"\s*$/.exec(field)
    if (!match) continue
    const name = `${match[1]}_${match[2]}`, durationMs = Number(match[3]), calls = Number(match[4])
    if (seen.has(name) || !Number.isFinite(durationMs) || durationMs > 3_600_000 || !Number.isSafeInteger(calls) || calls < 1 || calls > 1_000_000) continue
    seen.add(name)
    retrievalDiagnostic({ ...context, phase: `server_${match[1] === 'p' ? 'provider' : 'gateway'}_${match[2]}`, durationMs, calls })
  }
}
export function retrievalDiagnostic(event: Omit<RetrievalDiagnostic, 'atMs'>): void {
  if (typeof window === 'undefined') return
  const observer = (window as unknown as { __polystoreRetrievalDiagnostic?: (event: RetrievalDiagnostic) => void }).__polystoreRetrievalDiagnostic
  if (observer) { try { observer({ ...event, atMs: performance.now() }) } catch { /* Diagnostics cannot alter retrieval. */ } }
}
export async function timeRetrieval<T>(phase: string, work: () => Promise<T>, sessionId?: string,
  context: Pick<RetrievalDiagnostic, 'chunkId' | 'slot'> = {}): Promise<T> {
  retrievalDiagnostic({ ...context, phase, edge: 'start', sessionId })
  try { return await work() }
  finally { retrievalDiagnostic({ ...context, phase, edge: 'end', sessionId }) }
}
