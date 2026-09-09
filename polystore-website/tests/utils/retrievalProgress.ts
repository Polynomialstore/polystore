import type { RetrievalDiagnostic } from '../../src/lib/retrievalDiagnostics'

// Harness observations never authorize payment. Output ranges are merged so
// retries and recovery rewrites cannot postpone the no-progress deadline.
export class RetrievalProgress {
  readonly started: number
  phase = 'fixture'
  private lastProgress: number
  private phaseStarted: number
  private phaseUnits = 0
  private ranges: Array<[number, number]> = []
  private verified = new Set<string>()
  private terminal = new Set<string>()
  writtenBytes = 0
  flushedBytes = 0
  private acked = new Set<string>()
  firstVerifiedByteMs: number | null = null
  completedSessions: number | null = null
  lastHeight: string | null = null
  events: RetrievalDiagnostic[] = []
  phases: Array<{ phase: string; startMs: number; endMs: number }> = []
  constructor(private now: () => number = () => performance.now(), readonly stallMs = 600_000) {
    this.started = this.lastProgress = this.phaseStarted = now()
  }
  enter(phase: string) {
    if (phase === this.phase) return
    this.phases.push({ phase: this.phase, startMs: this.phaseStarted - this.started, endMs: this.now() - this.started })
    this.phase = phase; this.phaseStarted = this.lastProgress = this.now(); this.phaseUnits = 0
  }
  advance(units: number) {
    if (units > this.phaseUnits) { this.phaseUnits = units; this.lastProgress = this.now() }
  }
  event(event: RetrievalDiagnostic) {
    if (this.events.length >= 100_000) throw new Error('retrieval diagnostic event bound exceeded')
    this.events.push(event)
    if (event.height) this.lastHeight = event.height
    if (event.phase === 'verified_window' && event.sessionId) this.verified.add(event.sessionId)
    if (event.phase === 'acked') for (const id of event.sessionIds ?? []) this.acked.add(id)
    if (event.phase === 'flushed') this.flushedBytes = this.writtenBytes
    if (event.phase !== 'verified_write') return
    const start = event.offset!, end = start + event.bytes!
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('invalid output observation')
    this.ranges.push([start, end]); this.ranges.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const range of this.ranges) {
      const previous = merged[merged.length - 1]
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
      else merged.push([...range])
    }
    this.ranges = merged
    const total = merged.reduce((sum, [a, b]) => sum + b - a, 0)
    if (total > this.writtenBytes) { this.writtenBytes = total; this.lastProgress = this.now(); this.firstVerifiedByteMs ??= this.now() - this.started }
  }
  completed(id: string, height: string) {
    if (!this.terminal.has(id)) { this.terminal.add(id); this.lastProgress = this.now() }
    this.completedSessions = this.terminal.size; this.lastHeight = height
  }
  check() {
    if (this.now() - this.lastProgress >= this.stallMs) throw new Error(`retrieval qualification stalled in ${this.phase}: no substantive progress for ${this.stallMs}ms`)
  }
  snapshot() {
    return { phase: this.phase, browserStage: this.events[this.events.length - 1]?.phase ?? null, elapsedMs: this.now() - this.started, phaseMs: this.now() - this.phaseStarted,
      lastProgressAgoMs: this.now() - this.lastProgress, phaseUnits: this.phaseUnits,
      verifiedLogicalBytesWritten: this.writtenBytes, flushedLogicalBytes: this.flushedBytes,
      verifiedWindows: this.verified.size, ackedSessions: this.acked.size, firstVerifiedByteMs: this.firstVerifiedByteMs,
      chainConfirmedCompletedSessions: this.completedSessions, lastSuccessfulHeight: this.lastHeight }
  }
}

// Independent of browser evaluation and final-stream reads. The failure handler
// closes only the harness's context, preserving resumable financial records.
export function startRetrievalWatchdog(progress: RetrievalProgress, heartbeat: () => void, fail: (error: Error) => void,
  timers = { setInterval, clearInterval }, now = () => performance.now()) {
  let lastHeartbeat = -Infinity, stopped = false
  const stop = () => { if (!stopped) { stopped = true; timers.clearInterval(timer) } }
  const timer = timers.setInterval(() => {
    if (stopped) return
    try {
      if (now() - lastHeartbeat >= 60_000) { heartbeat(); lastHeartbeat = now() }
      progress.check()
    } catch (error) { stop(); fail(error instanceof Error ? error : new Error(String(error))) }
  }, 1000)
  return stop
}
