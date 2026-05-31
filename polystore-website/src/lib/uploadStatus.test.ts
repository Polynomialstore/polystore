import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createUploadPipelineStatus,
  normalizeKzgBackendStatus,
  patchUploadPipelineStatus,
  sanitizeUploadPipelineStatus,
} from './uploadStatus'

test('normalizeKzgBackendStatus names WebGPU MSM with reduction mode', () => {
  const status = normalizeKzgBackendStatus({
    rustCommitBackend: 'webgpu-msm',
    kzgCommitBackend: 'webgpu',
    kzgWebGpuAvailable: true,
    kzgWebGpuProbeStatus: 'passed',
    kzgWebGpuBucketWidth: 12,
    kzgWebGpuReductionMode: 'serial',
    kzgWebGpuCalibrationSource: 'benchmark-matrix',
    kzgWebGpuCalibrationStatus: 'passed',
  })

  assert.equal(status.display, 'webgpu-msm')
  assert.equal(status.label, 'WebGPU MSM (serial, bucket 12, benchmark-matrix)')
  assert.equal(status.webGpuAvailable, true)
  assert.equal(status.probeStatus, 'passed')
  assert.equal(status.bucketWidth, 12)
  assert.equal(status.calibrationStatus, 'passed')
  assert.equal(status.calibrationSource, 'benchmark-matrix')
})

test('normalizeKzgBackendStatus reports WASM fallback reason', () => {
  const status = normalizeKzgBackendStatus({
    rustCommitBackend: 'blst',
    kzgCommitBackend: 'webgpu-wasm-fallback',
    kzgWebGpuAvailable: false,
    kzgWebGpuFallbackReason: 'WebGPU fallback adapter rejected',
  })

  assert.equal(status.display, 'fallback')
  assert.equal(status.label, 'WASM blst fallback')
  assert.equal(status.fallbackReason, 'WebGPU fallback adapter rejected')
})

test('normalizeKzgBackendStatus ignores zero-valued scheduler defaults', () => {
  const status = normalizeKzgBackendStatus({
    rustCommitBackend: 'blst',
    kzgCommitBackend: 'wasm-blst',
    kzgWebGpuProbeTimeoutMs: 0,
    kzgWebGpuCommitTimeoutMs: 0,
    kzgWebGpuMinBlobs: 0,
    commitWorkerCount: 0,
  })

  assert.equal(status.probeTimeoutMs, null)
  assert.equal(status.commitTimeoutMs, null)
  assert.equal(status.minBlobs, null)
  assert.equal(status.commitWorkerCount, null)
})

test('normalizeKzgBackendStatus surfaces browser KZG scheduler diagnostics', () => {
  const status = normalizeKzgBackendStatus({
    rustCommitBackend: 'webgpu-msm',
    kzgCommitBackend: 'webgpu',
    kzgSchedulerQueueWaitMs: 12,
    kzgSchedulerTotalMs: 34,
    kzgSchedulerDepthAtEnqueue: 3,
    kzgSchedulerActiveAtEnqueue: 1,
    kzgSchedulerMaxQueueDepth: 32,
    kzgSchedulerFallbackCount: 2,
    kzgSchedulerBatchSize: 4,
    kzgSchedulerBatchBlobs: 384,
    kzgSchedulerBatchBytes: 50_331_648,
    kzgSchedulerBatchSplitCount: 1,
    kzgSchedulerBatchFallbackCount: 0,
  })

  assert.equal(status.schedulerQueueWaitMs, 12)
  assert.equal(status.schedulerTotalMs, 34)
  assert.equal(status.schedulerQueueDepth, 3)
  assert.equal(status.schedulerActive, 1)
  assert.equal(status.schedulerMaxQueueDepth, 32)
  assert.equal(status.schedulerFallbackCount, 2)
  assert.equal(status.schedulerBatchSize, 4)
  assert.equal(status.schedulerBatchBlobs, 384)
  assert.equal(status.schedulerBatchBytes, 50_331_648)
  assert.equal(status.schedulerBatchSplitCount, 1)
  assert.equal(status.schedulerBatchFallbackCount, null)
})

test('patchUploadPipelineStatus preserves nested state and records elapsed time', () => {
  const initial = createUploadPipelineStatus({
    dealId: '42',
    runId: 7,
    fileName: 'upload.bin',
    fileBytes: 1024,
    nowMs: 100,
  })
  const next = patchUploadPipelineStatus(
    initial,
    {
      phase: 'plan_upload',
      phaseLabel: 'Planning slab layout',
      totals: { totalMdus: 3, workDone: 1 },
      storage: { stage: 'browser_memory', browserMemoryBytes: 1024 },
    },
    250,
  )

  assert.equal(next.file.name, 'upload.bin')
  assert.equal(next.totals.bytesTotal, 1024)
  assert.equal(next.totals.totalMdus, 3)
  assert.equal(next.totals.workDone, 1)
  assert.equal(next.storage.stage, 'browser_memory')
  assert.equal(next.storage.activeArtifacts, null)
  assert.equal(next.storage.stagedArtifacts, null)
  assert.equal(next.timing.elapsedMs, 150)
})

test('patchUploadPipelineStatus tracks staged provider artifacts', () => {
  const initial = createUploadPipelineStatus({ dealId: '42', nowMs: 0 })
  const next = patchUploadPipelineStatus(
    initial,
    {
      phase: 'upload_transport',
      phaseLabel: 'Staging artifacts',
      storage: {
        stage: 'provider_staged',
        queuedArtifacts: 4,
        activeArtifacts: 1,
        stagedArtifacts: 3,
        uploadedArtifacts: 3,
      },
    },
    50,
  )

  assert.equal(next.storage.stage, 'provider_staged')
  assert.equal(next.storage.queuedArtifacts, 4)
  assert.equal(next.storage.activeArtifacts, 1)
  assert.equal(next.storage.stagedArtifacts, 3)
  assert.equal(next.storage.uploadedArtifacts, 3)
})

test('sanitizeUploadPipelineStatus truncates user-controlled text', () => {
  const status = createUploadPipelineStatus({
    dealId: 'd'.repeat(300),
    fileName: 'x'.repeat(300),
    nowMs: 0,
  })
  const sanitized = sanitizeUploadPipelineStatus({
    ...status,
    phaseLabel: 'p'.repeat(800),
    latestEvent: 'l'.repeat(800),
    error: 'e'.repeat(800),
    transport: {
      ...status.transport,
      fallbackReason: 't'.repeat(800),
    },
    kzg: {
      ...status.kzg,
      fallbackReason: 'f'.repeat(800),
    },
  })

  assert.equal(sanitized.dealId.length, 160)
  assert.equal(sanitized.phaseLabel.length, 240)
  assert.equal(sanitized.latestEvent?.length, 160)
  assert.equal(sanitized.file.name?.length, 160)
  assert.equal(sanitized.error?.length, 500)
  assert.equal(sanitized.transport.fallbackReason?.length, 500)
  assert.equal(sanitized.kzg.fallbackReason?.length, 500)
})
