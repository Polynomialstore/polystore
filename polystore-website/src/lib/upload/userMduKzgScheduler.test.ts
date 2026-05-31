import assert from 'node:assert/strict'
import test from 'node:test'

import { KZG_BLOB_SIZE } from '../kzgCommitBackend'
import { UserMduKzgScheduler } from './userMduKzgScheduler'
import type { UserMduBrowserKzgResult, UserMduUncommittedExpansion } from './userMduBrowserKzg'

function expansion(sequence: number): UserMduUncommittedExpansion {
  return {
    contract: 'mode2-user-mdu-uncommitted-v1',
    kind: 'payload',
    k: 2,
    m: 1,
    payloadId: `payload:${sequence}`,
    profile: true,
    sequence,
    shardsFlat: new Uint8Array(KZG_BLOB_SIZE * 3),
    shardLen: KZG_BLOB_SIZE,
    perf: { encode_ms: 1, rs_ms: 2, total_ms: 3, rows: 1, shards_total: 3, shard_len: KZG_BLOB_SIZE },
  }
}

function resultFor(sequence: number): UserMduBrowserKzgResult {
  return {
    witness_flat: new Uint8Array(3 * 48).fill(sequence),
    mdu_root: new Uint8Array(32).fill(sequence),
    shards_flat: new Uint8Array(KZG_BLOB_SIZE * 3).fill(sequence),
    shard_len: KZG_BLOB_SIZE,
    perf: {
      expandMs: 3,
      commitMs: 4,
      rootMs: 5,
      totalMs: 12,
      shardCount: 3,
      shardLen: KZG_BLOB_SIZE,
      rustEncodeMs: 1,
      rustRsMs: 2,
      rustCommitDecodeMs: 0,
      rustCommitTransformMs: 0,
      rustCommitMsmScalarPrepMs: 0,
      rustCommitMsmBucketFillMs: 0,
      rustCommitMsmReduceMs: 0,
      rustCommitMsmDoubleMs: 0,
      rustCommitMsmMs: 0,
      rustCommitCompressMs: 0,
      rustCommitMs: 4,
      rustTotalMs: 12,
      rustCommitBackend: 'webgpu-msm',
      rustCommitMsmSubphasesAvailable: false,
      rows: 1,
      shardsTotal: 3,
      kzgCommitBackend: 'webgpu',
      kzgWebGpuAvailable: true,
      kzgWebGpuFallbackReason: '',
      kzgWebGpuProbeStatus: 'passed',
      kzgWebGpuCircuitOpen: false,
      kzgWebGpuProbeTimeoutMs: 0,
      kzgWebGpuCommitTimeoutMs: 0,
      kzgWebGpuMinBlobs: 0,
      kzgWebGpuBucketWidth: 12,
      kzgWebGpuReductionMode: 'parallel16',
      kzgWebGpuCalibrationStatus: 'cached',
      kzgWebGpuCalibrationSource: 'cache',
      kzgWebGpuCalibrationCacheKey: 'test',
    },
  }
}

test('KZG scheduler preserves enqueue order even when later RS expansion finishes first', async () => {
  let now = 0
  let resolveFirst!: (value: UserMduUncommittedExpansion) => void
  const first = new Promise<UserMduUncommittedExpansion>((resolve) => {
    resolveFirst = resolve
  })
  const calls: number[] = []
  const scheduler = new UserMduKzgScheduler({ now: () => now, maxQueueDepth: 4 })

  const p0 = scheduler.enqueue({
    sequence: 0,
    expansion: first,
    commit: async (expanded) => {
      calls.push(expanded.sequence ?? -1)
      return resultFor(expanded.sequence ?? 0)
    },
  })
  const p1 = scheduler.enqueue({
    sequence: 1,
    expansion: Promise.resolve(expansion(1)),
    commit: async (expanded) => {
      calls.push(expanded.sequence ?? -1)
      return resultFor(expanded.sequence ?? 0)
    },
  })

  await Promise.resolve()
  assert.deepEqual(calls, [])
  now = 10
  resolveFirst(expansion(0))
  const [r0, r1] = await Promise.all([p0, p1])

  assert.deepEqual(calls, [0, 1])
  assert.equal(r0.perf.kzgSchedulerSequence, 0)
  assert.equal(r1.perf.kzgSchedulerSequence, 1)
  assert.equal(r1.perf.kzgSchedulerOwner, 'browser-user-mdu-kzg-scheduler-v1')
})

test('KZG scheduler rejects commit errors when no fallback is provided', async () => {
  const scheduler = new UserMduKzgScheduler({ maxQueueDepth: 4 })
  await assert.rejects(
    scheduler.enqueue({
      sequence: 0,
      expansion: Promise.resolve(expansion(0)),
      commit: async () => {
        throw new Error('synthetic commit failure')
      },
    }),
    /synthetic commit failure/,
  )
  assert.equal(scheduler.getStatus().failed, 1)
})

test('KZG scheduler uses fallback and records queue diagnostics', async () => {
  let now = 100
  const scheduler = new UserMduKzgScheduler({ now: () => now, maxQueueDepth: 4 })
  const promise = scheduler.enqueue({
    sequence: 7,
    expansion: Promise.resolve(expansion(7)),
    commit: async () => {
      now += 5
      throw new Error('backend validation failed')
    },
    fallback: async (reason) => {
      now += 9
      const fallback = resultFor(7)
      fallback.perf.browserKzgCommitFallbackReason = reason
      fallback.perf.rustCommitBackend = 'blst'
      return fallback
    },
  })
  now += 3
  const result = await promise
  assert.equal(result.perf.rustCommitBackend, 'blst')
  assert.match(result.perf.browserKzgCommitFallbackReason ?? '', /backend validation failed/)
  assert.equal(result.perf.kzgSchedulerSequence, 7)
  assert.equal(result.perf.kzgSchedulerFallbackCount, 1)
  assert.equal(result.perf.kzgSchedulerMaxQueueDepth, 4)
  assert.ok((result.perf.kzgSchedulerTotalMs ?? 0) >= (result.perf.kzgSchedulerQueueWaitMs ?? 0))
})

test('KZG scheduler honors abort before a queued task starts', async () => {
  let release!: (value: UserMduUncommittedExpansion) => void
  const scheduler = new UserMduKzgScheduler({ maxQueueDepth: 4 })
  const controller = new AbortController()
  const first = scheduler.enqueue({
    sequence: 0,
    expansion: new Promise<UserMduUncommittedExpansion>((resolve) => {
      release = resolve
    }),
    commit: async (expanded) => resultFor(expanded.sequence ?? 0),
  })
  const second = scheduler.enqueue({
    sequence: 1,
    expansion: Promise.resolve(expansion(1)),
    signal: controller.signal,
    commit: async (expanded) => resultFor(expanded.sequence ?? 0),
  })

  controller.abort()
  release(expansion(0))
  await first
  await assert.rejects(second, (error) => error instanceof Error && error.name === 'AbortError')
})

test('KZG scheduler bounds queue depth', async () => {
  const scheduler = new UserMduKzgScheduler({ maxQueueDepth: 1 })
  await assert.rejects(
    Promise.all([
      scheduler.enqueue({
        sequence: 0,
        expansion: new Promise<UserMduUncommittedExpansion>(() => undefined),
        commit: async (expanded) => resultFor(expanded.sequence ?? 0),
      }),
      scheduler.enqueue({
        sequence: 1,
        expansion: Promise.resolve(expansion(1)),
        commit: async (expanded) => resultFor(expanded.sequence ?? 0),
      }),
    ]),
    /queue is full/,
  )
})
