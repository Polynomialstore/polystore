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
    kzgWebGpuReductionMode: 'serial',
  })

  assert.equal(status.display, 'webgpu-msm')
  assert.equal(status.label, 'WebGPU MSM (serial)')
  assert.equal(status.webGpuAvailable, true)
  assert.equal(status.probeStatus, 'passed')
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
  assert.equal(next.timing.elapsedMs, 150)
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
