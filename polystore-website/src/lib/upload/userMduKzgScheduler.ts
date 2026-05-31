import type { UserMduBrowserKzgResult, UserMduUncommittedExpansion } from './userMduBrowserKzg'

// Issue #194 seam inventory:
// - Before this scheduler, each browser expansion worker ran RS expansion and
//   initialized/used its own browser KZG backend for the resulting shard blobs.
// - Expansion workers now return the deterministic uncommitted contract from
//   userMduBrowserKzg.ts; this queue is the single browser-side owner that
//   orders those uncommitted batches and forwards them to the KZG worker owner.
// - The queue is intentionally MDU-scoped. Cross-MDU batching is only exposed by
//   the stable enqueue/commit seam and remains the follow-up #195 work.

export type UserMduKzgSchedulerDiagnostics = {
  sequence: number
  queueWaitMs: number
  totalMs: number
  depthAtEnqueue: number
  activeAtEnqueue: number
  queueDepthAtStart: number
  maxQueueDepth: number
  fallbackCount: number
  owner: 'browser-user-mdu-kzg-scheduler-v1'
}

export type UserMduKzgSchedulerCommitContext = UserMduKzgSchedulerDiagnostics & {
  signal?: AbortSignal
}

export type UserMduKzgSchedulerTask = {
  sequence: number
  expansion: Promise<UserMduUncommittedExpansion>
  commit: (
    expansion: UserMduUncommittedExpansion,
    context: UserMduKzgSchedulerCommitContext,
  ) => Promise<UserMduBrowserKzgResult>
  fallback?: (reason: string, context: UserMduKzgSchedulerCommitContext) => Promise<UserMduBrowserKzgResult>
  signal?: AbortSignal
}

export type UserMduKzgSchedulerOptions = {
  maxQueueDepth?: number
  concurrency?: number
  now?: () => number
}

export type UserMduKzgSchedulerStatus = {
  active: number
  queued: number
  maxQueueDepth: number
  concurrency: number
  nextSequence: number
  completed: number
  failed: number
  fallbackCount: number
  lastError: string | null
  lastQueueWaitMs: number | null
  lastTotalMs: number | null
}

type QueuedTask = {
  task: UserMduKzgSchedulerTask
  resolve: (value: UserMduBrowserKzgResult) => void
  reject: (reason?: unknown) => void
  enqueuedAtMs: number
  depthAtEnqueue: number
  activeAtEnqueue: number
}

const OWNER = 'browser-user-mdu-kzg-scheduler-v1' as const

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

function abortError(): Error {
  const error = new Error('user MDU KZG scheduler task aborted')
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function attachUserMduKzgSchedulerDiagnostics(
  result: UserMduBrowserKzgResult,
  diagnostics: UserMduKzgSchedulerDiagnostics,
): UserMduBrowserKzgResult {
  return {
    ...result,
    perf: {
      ...result.perf,
      kzgSchedulerSequence: diagnostics.sequence,
      kzgSchedulerQueueWaitMs: diagnostics.queueWaitMs,
      kzgSchedulerCommitMs: result.perf.commitMs,
      kzgSchedulerTotalMs: diagnostics.totalMs,
      kzgSchedulerDepthAtEnqueue: diagnostics.depthAtEnqueue,
      kzgSchedulerActiveAtEnqueue: diagnostics.activeAtEnqueue,
      kzgSchedulerQueueDepthAtStart: diagnostics.queueDepthAtStart,
      kzgSchedulerMaxQueueDepth: diagnostics.maxQueueDepth,
      kzgSchedulerFallbackCount: diagnostics.fallbackCount,
      kzgSchedulerOwner: diagnostics.owner,
    },
  }
}

export class UserMduKzgScheduler {
  private readonly maxQueueDepth: number
  private readonly concurrency: number
  private readonly now: () => number
  private queue: QueuedTask[] = []
  private active = 0
  private completed = 0
  private failed = 0
  private fallbackCount = 0
  private lastError: string | null = null
  private lastQueueWaitMs: number | null = null
  private lastTotalMs: number | null = null

  constructor(options: UserMduKzgSchedulerOptions = {}) {
    const maxQueueDepth = Math.floor(Number(options.maxQueueDepth ?? 32))
    const concurrency = Math.floor(Number(options.concurrency ?? 1))
    this.maxQueueDepth = Number.isFinite(maxQueueDepth) && maxQueueDepth > 0 ? maxQueueDepth : 32
    this.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1
    this.now = options.now ?? defaultNow
  }

  getStatus(): UserMduKzgSchedulerStatus {
    return {
      active: this.active,
      queued: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
      concurrency: this.concurrency,
      nextSequence: this.queue[0]?.task.sequence ?? -1,
      completed: this.completed,
      failed: this.failed,
      fallbackCount: this.fallbackCount,
      lastError: this.lastError,
      lastQueueWaitMs: this.lastQueueWaitMs,
      lastTotalMs: this.lastTotalMs,
    }
  }

  enqueue(task: UserMduKzgSchedulerTask): Promise<UserMduBrowserKzgResult> {
    if (!Number.isInteger(task.sequence) || task.sequence < 0) {
      return Promise.reject(new Error('scheduler task sequence must be a non-negative integer'))
    }
    if (this.active + this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new Error(`user MDU KZG scheduler queue is full (${this.maxQueueDepth})`))
    }
    if (task.signal?.aborted) {
      return Promise.reject(abortError())
    }

    return new Promise<UserMduBrowserKzgResult>((resolve, reject) => {
      this.queue.push({
        task,
        resolve,
        reject,
        enqueuedAtMs: this.now(),
        depthAtEnqueue: this.queue.length,
        activeAtEnqueue: this.active,
      })
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()
      if (!item) return
      this.active += 1
      void this.run(item)
    }
  }

  private async run(item: QueuedTask): Promise<void> {
    const startedAtMs = this.now()
    const baseDiagnostics: UserMduKzgSchedulerDiagnostics = {
      sequence: item.task.sequence,
      queueWaitMs: Math.max(0, startedAtMs - item.enqueuedAtMs),
      totalMs: 0,
      depthAtEnqueue: item.depthAtEnqueue,
      activeAtEnqueue: item.activeAtEnqueue,
      queueDepthAtStart: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
      fallbackCount: this.fallbackCount,
      owner: OWNER,
    }
    this.lastQueueWaitMs = baseDiagnostics.queueWaitMs

    try {
      if (item.task.signal?.aborted) throw abortError()
      const expansion = await item.task.expansion
      if (item.task.signal?.aborted) throw abortError()
      let result: UserMduBrowserKzgResult
      let usedFallback = false
      try {
        result = await item.task.commit(expansion, { ...baseDiagnostics, signal: item.task.signal })
      } catch (error) {
        if (!item.task.fallback) throw error
        usedFallback = true
        this.fallbackCount += 1
        const reason = errorMessage(error)
        result = await item.task.fallback(reason, {
          ...baseDiagnostics,
          fallbackCount: this.fallbackCount,
          signal: item.task.signal,
        })
      }
      const diagnostics: UserMduKzgSchedulerDiagnostics = {
        ...baseDiagnostics,
        totalMs: Math.max(0, this.now() - item.enqueuedAtMs),
        fallbackCount: this.fallbackCount,
      }
      this.completed += 1
      this.lastTotalMs = diagnostics.totalMs
      this.lastError = null
      const decorated = attachUserMduKzgSchedulerDiagnostics(result, diagnostics)
      if (usedFallback) {
        decorated.perf.browserKzgCommitFallbackReason = decorated.perf.browserKzgCommitFallbackReason || 'scheduler fallback used'
      }
      item.resolve(decorated)
    } catch (error) {
      const message = errorMessage(error)
      this.failed += 1
      this.lastError = message
      item.reject(error)
    } finally {
      this.active -= 1
      this.pump()
    }
  }
}
