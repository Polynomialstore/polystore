import type { UserMduBrowserKzgResult, UserMduUncommittedExpansion } from './userMduBrowserKzg'
import {
  normalizeUserMduKzgBatchConstraints,
  planUserMduKzgBatch,
  splitUserMduKzgBatch,
  type NormalizedUserMduKzgBatchConstraints,
  type UserMduKzgBatchConstraints,
  type UserMduKzgBatchPlan,
} from './userMduKzgBatch'

// Issue #194 seam inventory:
// - Before this scheduler, each browser expansion worker ran RS expansion and
//   initialized/used its own browser KZG backend for the resulting shard blobs.
// - Expansion workers now return the deterministic uncommitted contract from
//   userMduBrowserKzg.ts; this queue is the single browser-side owner that
//   orders those uncommitted batches and forwards them to the KZG worker owner.
// - Issue #195 extends the same enqueue seam with bounded sequence-ordered
//   batching. Public callers still enqueue one user MDU and receive one promise;
//   the scheduler may commit several ready consecutive MDUs in one owner call.

export type UserMduKzgSchedulerDiagnostics = {
  sequence: number
  queueWaitMs: number
  totalMs: number
  depthAtEnqueue: number
  activeAtEnqueue: number
  queueDepthAtStart: number
  maxQueueDepth: number
  fallbackCount: number
  batchSize: number
  batchPosition: number
  batchBlobs: number
  batchBytes: number
  batchEstimatedMemoryBytes: number
  batchMaxMdus: number
  batchMaxBlobs: number
  batchMaxBytes: number
  batchPlanReason: UserMduKzgBatchPlan['reason']
  batchSplitCount: number
  batchFallbackCount: number
  owner: 'browser-user-mdu-kzg-scheduler-v1'
}

export type UserMduKzgSchedulerCommitContext = UserMduKzgSchedulerDiagnostics & {
  signal?: AbortSignal
}

export type UserMduKzgSchedulerBatchCommitContext = UserMduKzgSchedulerCommitContext & {
  sequences: number[]
}

export type UserMduKzgSchedulerTask = {
  sequence: number
  expansion: Promise<UserMduUncommittedExpansion>
  commit: (
    expansion: UserMduUncommittedExpansion,
    context: UserMduKzgSchedulerCommitContext,
  ) => Promise<UserMduBrowserKzgResult>
  commitBatch?: (
    expansions: UserMduUncommittedExpansion[],
    context: UserMduKzgSchedulerBatchCommitContext,
  ) => Promise<UserMduBrowserKzgResult[]>
  fallback?: (reason: string, context: UserMduKzgSchedulerCommitContext) => Promise<UserMduBrowserKzgResult>
  signal?: AbortSignal
}

export type UserMduKzgSchedulerOptions = {
  maxQueueDepth?: number
  concurrency?: number
  now?: () => number
  batch?: UserMduKzgBatchConstraints & {
    enabled?: boolean
  }
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
  batchSplitCount: number
  batchFallbackCount: number
  lastBatchSize: number | null
  lastBatchBlobs: number | null
  lastBatchBytes: number | null
  lastBatchPlanReason: UserMduKzgBatchPlan['reason'] | null
  lastError: string | null
  lastQueueWaitMs: number | null
  lastTotalMs: number | null
}

type ExpansionState =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: UserMduUncommittedExpansion }
  | { status: 'rejected'; reason: unknown }

type QueuedTask = {
  task: UserMduKzgSchedulerTask
  resolve: (value: UserMduBrowserKzgResult) => void
  reject: (reason?: unknown) => void
  enqueuedAtMs: number
  depthAtEnqueue: number
  activeAtEnqueue: number
  expansionState: ExpansionState
}

type BatchItem = {
  queued: QueuedTask
  expansion: UserMduUncommittedExpansion
}

type BatchMeta = {
  plan: UserMduKzgBatchPlan
  splitCountAtStart: number
  fallbackCountAtStart: number
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
      kzgSchedulerBatchSize: diagnostics.batchSize,
      kzgSchedulerBatchPosition: diagnostics.batchPosition,
      kzgSchedulerBatchBlobs: diagnostics.batchBlobs,
      kzgSchedulerBatchBytes: diagnostics.batchBytes,
      kzgSchedulerBatchEstimatedMemoryBytes: diagnostics.batchEstimatedMemoryBytes,
      kzgSchedulerBatchMaxMdus: diagnostics.batchMaxMdus,
      kzgSchedulerBatchMaxBlobs: diagnostics.batchMaxBlobs,
      kzgSchedulerBatchMaxBytes: diagnostics.batchMaxBytes,
      kzgSchedulerBatchPlanReason: diagnostics.batchPlanReason,
      kzgSchedulerBatchSplitCount: diagnostics.batchSplitCount,
      kzgSchedulerBatchFallbackCount: diagnostics.batchFallbackCount,
      kzgSchedulerOwner: diagnostics.owner,
    },
  }
}

export class UserMduKzgScheduler {
  private readonly maxQueueDepth: number
  private readonly concurrency: number
  private readonly now: () => number
  private readonly batchEnabled: boolean
  private readonly batchConstraints: NormalizedUserMduKzgBatchConstraints
  private queue: QueuedTask[] = []
  private active = 0
  private completed = 0
  private failed = 0
  private fallbackCount = 0
  private batchSplitCount = 0
  private batchFallbackCount = 0
  private lastBatchSize: number | null = null
  private lastBatchBlobs: number | null = null
  private lastBatchBytes: number | null = null
  private lastBatchPlanReason: UserMduKzgBatchPlan['reason'] | null = null
  private lastError: string | null = null
  private lastQueueWaitMs: number | null = null
  private lastTotalMs: number | null = null

  constructor(options: UserMduKzgSchedulerOptions = {}) {
    const maxQueueDepth = Math.floor(Number(options.maxQueueDepth ?? 32))
    const concurrency = Math.floor(Number(options.concurrency ?? 1))
    this.maxQueueDepth = Number.isFinite(maxQueueDepth) && maxQueueDepth > 0 ? maxQueueDepth : 32
    this.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1
    this.now = options.now ?? defaultNow
    this.batchEnabled = options.batch?.enabled !== false
    this.batchConstraints = normalizeUserMduKzgBatchConstraints(options.batch)
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
      batchSplitCount: this.batchSplitCount,
      batchFallbackCount: this.batchFallbackCount,
      lastBatchSize: this.lastBatchSize,
      lastBatchBlobs: this.lastBatchBlobs,
      lastBatchBytes: this.lastBatchBytes,
      lastBatchPlanReason: this.lastBatchPlanReason,
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
      const item: QueuedTask = {
        task,
        resolve,
        reject,
        enqueuedAtMs: this.now(),
        depthAtEnqueue: this.queue.length,
        activeAtEnqueue: this.active,
        expansionState: { status: 'pending' },
      }
      task.expansion.then(
        (value) => {
          item.expansionState = { status: 'fulfilled', value }
        },
        (reason) => {
          item.expansionState = { status: 'rejected', reason }
        },
      )
      this.queue.push(item)
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

  private makeDiagnostics(
    item: QueuedTask,
    startedAtMs: number,
    finishedAtMs: number,
    batch: BatchItem[],
    meta: BatchMeta,
    position: number,
  ): UserMduKzgSchedulerDiagnostics {
    return {
      sequence: item.task.sequence,
      queueWaitMs: Math.max(0, startedAtMs - item.enqueuedAtMs),
      totalMs: Math.max(0, finishedAtMs - item.enqueuedAtMs),
      depthAtEnqueue: item.depthAtEnqueue,
      activeAtEnqueue: item.activeAtEnqueue,
      queueDepthAtStart: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
      fallbackCount: this.fallbackCount,
      batchSize: batch.length,
      batchPosition: position,
      batchBlobs: meta.plan.blobs,
      batchBytes: meta.plan.bytes,
      batchEstimatedMemoryBytes: meta.plan.estimatedMemoryBytes,
      batchMaxMdus: this.batchConstraints.maxBatchMdus,
      batchMaxBlobs: this.batchConstraints.maxBatchBlobs,
      batchMaxBytes: this.batchConstraints.maxBatchBytes,
      batchPlanReason: meta.plan.reason,
      batchSplitCount: this.batchSplitCount - meta.splitCountAtStart,
      batchFallbackCount: this.batchFallbackCount - meta.fallbackCountAtStart,
      owner: OWNER,
    }
  }

  private async awaitExpansion(item: QueuedTask): Promise<UserMduUncommittedExpansion> {
    if (item.expansionState.status === 'fulfilled') return item.expansionState.value
    if (item.expansionState.status === 'rejected') throw item.expansionState.reason
    return item.task.expansion
  }

  private collectReadyBatch(first: QueuedTask, firstExpansion: UserMduUncommittedExpansion): { batch: BatchItem[]; plan: UserMduKzgBatchPlan } {
    const batch: BatchItem[] = [{ queued: first, expansion: firstExpansion }]
    let acceptedFromQueue = 0
    let plan = planUserMduKzgBatch([firstExpansion], this.batchConstraints)

    if (!this.batchEnabled || !first.task.commitBatch) {
      return { batch, plan }
    }

    for (const queued of this.queue) {
      if (!queued.task.commitBatch || queued.task.signal?.aborted) break
      if (queued.expansionState.status !== 'fulfilled') break
      const candidateExpansions = [...batch.map((item) => item.expansion), queued.expansionState.value]
      const candidatePlan = planUserMduKzgBatch(candidateExpansions, this.batchConstraints)
      if (candidatePlan.count !== candidateExpansions.length) {
        plan = candidatePlan.count === batch.length ? candidatePlan : plan
        break
      }
      batch.push({ queued, expansion: queued.expansionState.value })
      plan = candidatePlan
      acceptedFromQueue += 1
    }

    if (acceptedFromQueue > 0) this.queue.splice(0, acceptedFromQueue)
    return { batch, plan }
  }

  private async commitSingle(
    item: BatchItem,
    startedAtMs: number,
    meta: BatchMeta,
    reason?: string,
  ): Promise<{ result: UserMduBrowserKzgResult; usedFallback: boolean }> {
    const baseContext = this.makeDiagnostics(item.queued, startedAtMs, this.now(), [item], meta, 0)
    try {
      if (item.queued.task.signal?.aborted) throw abortError()
      const result = await item.queued.task.commit(item.expansion, { ...baseContext, signal: item.queued.task.signal })
      return { result, usedFallback: false }
    } catch (error) {
      if (!item.queued.task.fallback) throw error
      this.fallbackCount += 1
      this.batchFallbackCount += 1
      const message = reason ? `${reason}; ${errorMessage(error)}` : errorMessage(error)
      const result = await item.queued.task.fallback(message, {
        ...baseContext,
        fallbackCount: this.fallbackCount,
        batchFallbackCount: this.batchFallbackCount - meta.fallbackCountAtStart,
        signal: item.queued.task.signal,
      })
      return { result, usedFallback: true }
    }
  }

  private async commitBatchItems(
    batch: BatchItem[],
    startedAtMs: number,
    meta: BatchMeta,
  ): Promise<Array<{ result: UserMduBrowserKzgResult; usedFallback: boolean }>> {
    if (batch.length === 1 || !batch[0].queued.task.commitBatch) {
      return [await this.commitSingle(batch[0], startedAtMs, meta)]
    }

    const context = this.makeDiagnostics(batch[0].queued, startedAtMs, this.now(), batch, meta, 0)
    try {
      const results = await batch[0].queued.task.commitBatch(
        batch.map((item) => item.expansion),
        {
          ...context,
          sequences: batch.map((item) => item.queued.task.sequence),
          signal: batch[0].queued.task.signal,
        },
      )
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error(`batch KZG owner returned ${results?.length ?? 0} results for ${batch.length} user MDUs`)
      }
      return results.map((result) => ({ result, usedFallback: false }))
    } catch (error) {
      if (batch.length <= 1) throw error
      this.batchSplitCount += 1
      const [leftCount, rightCount] = splitUserMduKzgBatch(batch.length)
      if (leftCount <= 0 || rightCount <= 0) {
        return Promise.all(batch.map((item) => this.commitSingle(item, startedAtMs, meta, errorMessage(error))))
      }
      const left = batch.slice(0, leftCount)
      const right = batch.slice(leftCount)
      const leftResults = await this.commitBatchItems(left, startedAtMs, meta)
      const rightResults = await this.commitBatchItems(right, startedAtMs, meta)
      return [...leftResults, ...rightResults]
    }
  }

  private async run(first: QueuedTask): Promise<void> {
    const startedAtMs = this.now()
    this.lastQueueWaitMs = Math.max(0, startedAtMs - first.enqueuedAtMs)
    let activeBatch: BatchItem[] | null = null

    try {
      if (first.task.signal?.aborted) throw abortError()
      const firstExpansion = await this.awaitExpansion(first)
      if (first.task.signal?.aborted) throw abortError()
      const { batch, plan } = this.collectReadyBatch(first, firstExpansion)
      activeBatch = batch
      const meta: BatchMeta = {
        plan,
        splitCountAtStart: this.batchSplitCount,
        fallbackCountAtStart: this.batchFallbackCount,
      }
      this.lastBatchSize = batch.length
      this.lastBatchBlobs = plan.blobs
      this.lastBatchBytes = plan.bytes
      this.lastBatchPlanReason = plan.reason

      const outcomes = await this.commitBatchItems(batch, startedAtMs, meta)
      const finishedAtMs = this.now()
      outcomes.forEach((outcome, index) => {
        const item = batch[index]
        const diagnostics = this.makeDiagnostics(item.queued, startedAtMs, finishedAtMs, batch, meta, index)
        this.completed += 1
        this.lastTotalMs = diagnostics.totalMs
        this.lastError = null
        const decorated = attachUserMduKzgSchedulerDiagnostics(outcome.result, diagnostics)
        if (outcome.usedFallback) {
          decorated.perf.browserKzgCommitFallbackReason =
            decorated.perf.browserKzgCommitFallbackReason || 'scheduler fallback used'
        }
        item.queued.resolve(decorated)
      })
    } catch (error) {
      const message = errorMessage(error)
      const failedItems = activeBatch?.length ? activeBatch : [{ queued: first, expansion: first.expansionState.status === 'fulfilled' ? first.expansionState.value : ({} as UserMduUncommittedExpansion) }]
      this.failed += failedItems.length
      this.lastError = message
      for (const item of failedItems) item.queued.reject(error)
    } finally {
      this.active -= 1
      this.pump()
    }
  }
}
