import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EXPANSION_WORKER_AUTOTUNE_VERSION,
  ExpansionWorkerAutotuneCacheStore,
  buildExpansionWorkerAutotuneCandidates,
  buildExpansionWorkerCalibrationPlan,
  createExpansionWorkerAutotuneCacheKey,
  finalizeExpansionWorkerAutotuneSelection,
  getCachedExpansionWorkerAutotuneSelection,
  isUsableExpansionWorkerAutotuneCache,
  pickExpansionWorkerCount,
  selectExpansionWorkerCountFromSamples,
} from './expansionWorkers'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

const defaultShape = {
  hardwareConcurrency: 12,
  totalJobs: 13,
  rsK: 8,
  rsM: 4,
  kzgCommitBackend: 'webgpu-scheduler',
  rustCommitBackend: 'webgpu-msm',
  kzgWebGpuAvailable: true,
  kzgWebGpuProbeStatus: 'passed',
  kzgWebGpuBucketWidth: 12,
  kzgWebGpuReductionMode: 'parallel16',
  kzgWebGpuCalibrationStatus: 'cached',
  kzgWebGpuCalibrationSource: 'benchmark-matrix',
  kzgWebGpuCalibrationCacheKey: 'adapter-cache-key',
  schedulerOwner: 'browser-user-mdu-kzg-scheduler-v1',
  schedulerConcurrency: 1,
  schedulerMaxQueueDepth: 32,
}

test('pickExpansionWorkerCount falls back safely for undefined and NaN hardware concurrency', () => {
  assert.equal(pickExpansionWorkerCount(undefined), 3)
  assert.equal(pickExpansionWorkerCount(Number.NaN), 3)
})

test('pickExpansionWorkerCount clamps zero or one hardware concurrency to one worker', () => {
  assert.equal(pickExpansionWorkerCount(0), 1)
  assert.equal(pickExpansionWorkerCount(1), 1)
})

test('pickExpansionWorkerCount scales by hardware concurrency thresholds', () => {
  assert.equal(pickExpansionWorkerCount(2), 1)
  assert.equal(pickExpansionWorkerCount(3), 2)
  assert.equal(pickExpansionWorkerCount(4), 3)
  assert.equal(pickExpansionWorkerCount(6), 4)
  assert.equal(pickExpansionWorkerCount(8), 5)
  assert.equal(pickExpansionWorkerCount(12), 6)
})

test('pickExpansionWorkerCount honors small total job caps', () => {
  assert.equal(pickExpansionWorkerCount(12, 1), 1)
  assert.equal(pickExpansionWorkerCount(12, 2), 2)
  assert.equal(pickExpansionWorkerCount(12, 3), 3)
  assert.equal(pickExpansionWorkerCount(12, 4), 4)
  assert.equal(pickExpansionWorkerCount(12, 5), 5)
})

test('pickExpansionWorkerCount floors fractional inputs and clamps invalid job caps', () => {
  assert.equal(pickExpansionWorkerCount(5.9, 2.9), 2)
  assert.equal(pickExpansionWorkerCount(12, 0), 1)
  assert.equal(pickExpansionWorkerCount(12, Number.NaN), 6)
})

test('buildExpansionWorkerAutotuneCandidates includes low-risk sweep points and static default', () => {
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(12, 32), [1, 3, 5, 6])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(8, 12), [1, 3, 5])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(6, 16), [1, 3, 4])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(4, 16), [1, 2, 3])
})

test('buildExpansionWorkerAutotuneCandidates skips tiny jobs and single-worker machines', () => {
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(12, 1), [1])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(12, 3), [3])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(2, 16), [1])
})

test('buildExpansionWorkerCalibrationPlan bounds large-upload sampling', () => {
  const plan = buildExpansionWorkerCalibrationPlan(defaultShape)
  assert.equal(plan.shouldCalibrate, true)
  assert.deepEqual(plan.candidates, [1, 3, 5, 6])
  assert.deepEqual(plan.sampleBatches, [
    { workerCount: 5, sampleJobs: 5 },
    { workerCount: 6, sampleJobs: 6 },
  ])
  assert.equal(plan.staticWorkerCount, 6)
})

test('buildExpansionWorkerCalibrationPlan disables calibration for small uploads or explicit opt-out', () => {
  assert.equal(buildExpansionWorkerCalibrationPlan({ ...defaultShape, totalJobs: 3 }).shouldCalibrate, false)
  assert.equal(buildExpansionWorkerCalibrationPlan(defaultShape, { enabled: false }).source, 'static-disabled')
})

test('selectExpansionWorkerCountFromSamples picks the fastest allowed normalized sample', () => {
  assert.equal(
    selectExpansionWorkerCountFromSamples(
      [
        { workerCount: 1, wallMs: 1100, sampleJobs: 1 },
        { workerCount: 3, wallMs: 2400, sampleJobs: 3 },
        { workerCount: 5, wallMs: 3000, sampleJobs: 5 },
        { workerCount: 9, wallMs: 100, sampleJobs: 1 },
      ],
      12,
      32,
    ),
    5,
  )
})

test('selectExpansionWorkerCountFromSamples falls back to static count when samples are invalid', () => {
  assert.equal(
    selectExpansionWorkerCountFromSamples(
      [
        { workerCount: 9, wallMs: 100 },
        { workerCount: 6, wallMs: Number.NaN },
      ],
      12,
      32,
    ),
    6,
  )
})

test('cache key changes for hardware, backend, scheduler, profile, and version contract shape', () => {
  const baseline = createExpansionWorkerAutotuneCacheKey(defaultShape)
  assert.notEqual(createExpansionWorkerAutotuneCacheKey({ ...defaultShape, hardwareConcurrency: 8 }), baseline)
  assert.notEqual(createExpansionWorkerAutotuneCacheKey({ ...defaultShape, rsK: 4, rsM: 2 }), baseline)
  assert.notEqual(createExpansionWorkerAutotuneCacheKey({ ...defaultShape, kzgWebGpuCalibrationCacheKey: 'other' }), baseline)
  assert.notEqual(createExpansionWorkerAutotuneCacheKey({ ...defaultShape, schedulerMaxQueueDepth: 64 }), baseline)
  assert.match(baseline, new RegExp(`v${EXPANSION_WORKER_AUTOTUNE_VERSION}`))
})

test('cache store validates and invalidates selected worker count by shape', () => {
  const store = new ExpansionWorkerAutotuneCacheStore({ storage: memoryStorage() })
  const selection = finalizeExpansionWorkerAutotuneSelection(
    defaultShape,
    [
      { workerCount: 1, wallMs: 1000, sampleJobs: 1 },
      { workerCount: 3, wallMs: 2100, sampleJobs: 3 },
      { workerCount: 5, wallMs: 2500, sampleJobs: 5 },
    ],
    { cacheStore: store, nowMs: 1234 },
  )

  assert.equal(selection.workerCount, 5)
  assert.equal(selection.cacheWritable, true)
  const cached = getCachedExpansionWorkerAutotuneSelection(defaultShape, store)
  assert.equal(cached?.workerCount, 5)
  assert.equal(cached?.source, 'cache-hit')
  assert.equal(getCachedExpansionWorkerAutotuneSelection({ ...defaultShape, hardwareConcurrency: 8 }, store), null)
  assert.equal(getCachedExpansionWorkerAutotuneSelection({ ...defaultShape, rsM: 5 }, store), null)
  assert.equal(getCachedExpansionWorkerAutotuneSelection({ ...defaultShape, kzgCommitBackend: 'wasm-blst' }, store), null)
})

test('isUsableExpansionWorkerAutotuneCache rejects malformed and out-of-candidate entries', () => {
  const cache = {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    contract: 'mode2-user-mdu-rs-kzg-v2',
    cacheKey: createExpansionWorkerAutotuneCacheKey(defaultShape),
    hardwareConcurrency: 12,
    totalJobs: 13,
    jobBucket: '8-15',
    rsK: 8,
    rsM: 4,
    backendKey: 'kzg:webgpu-scheduler:webgpu-msm:true:passed:unknown:12:parallel16:cached:benchmark-matrix:adapter-cache-key',
    schedulerKey: 'scheduler:browser-user-mdu-kzg-scheduler-v1:1:32:unknown:unknown:unknown',
    selectedWorkerCount: 5,
    staticWorkerCount: 6,
    candidates: [1, 3, 5, 6],
    sampledCandidates: [1, 3, 5],
    measuredAtMs: 1000,
    scoreMs: 500,
    sampleCount: 3,
    reason: 'selected 5 workers',
  }

  assert.equal(isUsableExpansionWorkerAutotuneCache(cache, defaultShape), true)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, version: 0 }, defaultShape), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, selectedWorkerCount: 9 }, defaultShape), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, measuredAtMs: 0 }, defaultShape), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, scoreMs: Number.NaN }, defaultShape), false)
})

test('finalizeExpansionWorkerAutotuneSelection fails closed on timeout without samples, error, and invalid samples', () => {
  const timedOut = finalizeExpansionWorkerAutotuneSelection(defaultShape, [], { timedOut: true })
  assert.equal(timedOut.workerCount, 6)
  assert.equal(timedOut.source, 'fallback-timeout')
  assert.equal(timedOut.sampleCount, 0)
  assert.equal(timedOut.cacheWritable, false)

  const failed = finalizeExpansionWorkerAutotuneSelection(defaultShape, [], { error: new Error('boom') })
  assert.equal(failed.workerCount, 6)
  assert.equal(failed.source, 'fallback-error')

  const noSamples = finalizeExpansionWorkerAutotuneSelection(defaultShape, [{ workerCount: 9, wallMs: 1 }])
  assert.equal(noSamples.workerCount, 6)
  assert.equal(noSamples.source, 'fallback-no-samples')
})

test('finalizeExpansionWorkerAutotuneSelection uses valid timed-out samples without caching partial results', () => {
  const store = new ExpansionWorkerAutotuneCacheStore({ storage: memoryStorage() })
  const timedOut = finalizeExpansionWorkerAutotuneSelection(
    { ...defaultShape, totalJobs: 9 },
    [
      { workerCount: 3, wallMs: 29_004, sampleJobs: 3 },
      { workerCount: 5, wallMs: 54_080, sampleJobs: 5 },
    ],
    { timedOut: true, cacheStore: store },
  )

  assert.equal(timedOut.workerCount, 3)
  assert.equal(timedOut.source, 'calibrated')
  assert.equal(timedOut.timedOut, true)
  assert.deepEqual(timedOut.sampledCandidates, [3, 5])
  assert.equal(timedOut.sampleCount, 2)
  assert.equal(timedOut.cacheWritable, false)
  assert.match(timedOut.reason, /partial timed-out runtime calibration/)
  assert.equal(getCachedExpansionWorkerAutotuneSelection({ ...defaultShape, totalJobs: 9 }, store), null)
})

test('finalizeExpansionWorkerAutotuneSelection does not cache incomplete calibration', () => {
  const store = new ExpansionWorkerAutotuneCacheStore({ storage: memoryStorage() })
  const selection = finalizeExpansionWorkerAutotuneSelection(
    defaultShape,
    [{ workerCount: 5, wallMs: 2500, sampleJobs: 5 }],
    { calibrationComplete: false, cacheStore: store },
  )
  assert.equal(selection.workerCount, 5)
  assert.equal(selection.cacheWritable, false)
  assert.equal(getCachedExpansionWorkerAutotuneSelection(defaultShape, store), null)
})
