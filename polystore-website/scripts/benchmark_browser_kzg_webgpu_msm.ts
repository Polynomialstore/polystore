import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const BLOB_SIZE = 128 * 1024
const DEFAULT_CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
const DEFAULT_WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,UseSkiaRenderer,WebGPUDeveloperFeatures',
  '--ignore-gpu-blocklist',
  '--disable-software-rasterizer',
]
const REDUCTION_MODES = ['auto', 'serial', 'parallel16', 'parallel32', 'parallel64'] as const
type ReductionModeName = (typeof REDUCTION_MODES)[number]
type BenchmarkStats = {
  min?: number
  median?: number
  p95?: number
  max?: number
  mean?: number
}
type BenchmarkRunResult = {
  diagnostic?: boolean
  blob_count?: number
  bucket_width?: number
  reduction_mode?: string | null
  requested_reduction_mode?: string | null
  parity?: boolean
  error?: unknown
  wasm_ms?: BenchmarkStats
  gpu_total_ms?: BenchmarkStats
  gpu_throughput?: { blobs_per_sec?: BenchmarkStats; mib_per_sec?: BenchmarkStats }
}

function detectChromePath(): string | undefined {
  if (process.env.POLYSTORE_CHROME_PATH) return process.env.POLYSTORE_CHROME_PATH
  return DEFAULT_CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
}

function launchArgs(): string[] {
  const extra = process.env.POLYSTORE_WEBGPU_CHROME_ARGS
    ? process.env.POLYSTORE_WEBGPU_CHROME_ARGS.split(/\s+/).filter(Boolean)
    : []
  return [...DEFAULT_WEBGPU_ARGS, ...extra]
}

function gitValue(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function gitMetadata() {
  const status = gitValue(['status', '--porcelain'])
  return {
    branch: gitValue(['branch', '--show-current']),
    commit: gitValue(['rev-parse', 'HEAD']),
    short_commit: gitValue(['rev-parse', '--short=8', 'HEAD']),
    dirty: status === null ? null : status.length > 0,
  }
}

function parsePositiveIntegerList(value: string | undefined, fallback: number[], label: string): number[] {
  const raw = value?.trim()
  if (!raw) return fallback
  const values = raw.split(',').map((part) => Number.parseInt(part.trim(), 10))
  if (values.some((item) => !Number.isInteger(item) || item < 1)) {
    throw new Error(`${label} must be a comma-separated list of positive integers`)
  }
  return [...new Set(values)]
}

function parseBucketWidthList(value: string | undefined): number[] {
  const values = parsePositiveIntegerList(
    value ?? process.env.POLYSTORE_WEBGPU_MSM_BUCKET_WIDTH,
    [10],
    'POLYSTORE_WEBGPU_MSM_BUCKET_WIDTHS',
  )
  if (values.some((item) => item < 4 || item > 13)) {
    throw new Error('POLYSTORE_WEBGPU_MSM_BUCKET_WIDTHS must only contain integers between 4 and 13')
  }
  return values
}

function assertReductionModeName(mode: string, label: string): asserts mode is ReductionModeName {
  if (!(REDUCTION_MODES as readonly string[]).includes(mode)) {
    throw new Error(`${label} must contain auto, serial, parallel16, parallel32, or parallel64`)
  }
}

function parseReductionModes(value: string | undefined): Array<string | undefined> {
  const raw = value?.trim()
  if (!raw) {
    const legacy = process.env.POLYSTORE_WEBGPU_MSM_REDUCTION?.trim()
    if (!legacy) return [undefined]
    assertReductionModeName(legacy, 'POLYSTORE_WEBGPU_MSM_REDUCTION')
    return [legacy === 'auto' ? undefined : legacy]
  }
  const modes = raw.split(',').map((part) => part.trim()).filter(Boolean)
  for (const mode of modes) assertReductionModeName(mode, 'POLYSTORE_WEBGPU_MSM_REDUCTIONS')
  return modes.map((mode) => (mode === 'auto' ? undefined : mode))
}

function successfulBenchmarkResults(matrixResults: BenchmarkRunResult[]): BenchmarkRunResult[] {
  return matrixResults.filter((result) => {
    return !result.error && result.parity
  })
}

function recommendMatrixThreshold(matrixResults: BenchmarkRunResult[]) {
  const winners = successfulBenchmarkResults(matrixResults)
    .filter((result) => Number(result.gpu_total_ms?.median ?? 0) <= Number(result.wasm_ms?.median ?? 0))
    .sort((a, b) => {
      const blobDelta = Number(a.blob_count ?? 0) - Number(b.blob_count ?? 0)
      if (blobDelta !== 0) return blobDelta
      return Number(a.gpu_total_ms?.median ?? 0) - Number(b.gpu_total_ms?.median ?? 0)
    })
  const firstWinner = winners[0]
  if (!firstWinner) {
    return {
      webgpu_recommended: false,
      min_blobs: null,
      min_mib: null,
      reason: 'No successful WebGPU run beat or matched WASM in this matrix',
    }
  }
  const minBlobs = firstWinner.blob_count ?? 1
  return {
    webgpu_recommended: true,
    min_blobs: minBlobs,
    min_mib: (minBlobs * BLOB_SIZE) / 1024 / 1024,
    bucket_width: firstWinner.bucket_width ?? null,
    reduction_mode: firstWinner.reduction_mode ?? firstWinner.requested_reduction_mode ?? null,
    gpu_median_ms: firstWinner.gpu_total_ms?.median ?? null,
    wasm_median_ms: firstWinner.wasm_ms?.median ?? null,
    gpu_blobs_per_sec: firstWinner.gpu_throughput?.blobs_per_sec?.median ?? null,
    gpu_mib_per_sec: firstWinner.gpu_throughput?.mib_per_sec?.median ?? null,
  }
}

const blobCounts = parsePositiveIntegerList(
  process.env.POLYSTORE_WEBGPU_MSM_BLOBS_LIST ?? process.env.POLYSTORE_WEBGPU_MSM_BLOBS,
  [1],
  'POLYSTORE_WEBGPU_MSM_BLOBS_LIST',
)
const bucketWidths = parseBucketWidthList(process.env.POLYSTORE_WEBGPU_MSM_BUCKET_WIDTHS)
const runs = Number.parseInt(process.env.POLYSTORE_WEBGPU_MSM_RUNS ?? '1', 10)
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('POLYSTORE_WEBGPU_MSM_RUNS must be a positive integer')
}
const diagnostic = process.env.POLYSTORE_WEBGPU_MSM_DIAGNOSTIC === '1'
const reductionModes = parseReductionModes(process.env.POLYSTORE_WEBGPU_MSM_REDUCTIONS)

const vite = await createServer({
  root: process.cwd(),
  server: {
    host: '127.0.0.1',
    port: 0,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  logLevel: 'error',
})

await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') {
  throw new Error('failed to allocate Vite benchmark server port')
}

const origin = `http://127.0.0.1:${address.port}`
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  const chromePath = detectChromePath()
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: process.env.POLYSTORE_WEBGPU_HEADLESS !== '0',
    args: launchArgs(),
  })
  const page = await browser.newPage()
  await page.goto(`${origin}/`)
  await page.addScriptTag({
    content: `
      window.__runPolyStoreKzgWebGpuMsmBenchmark = async function(config) {
        function serializeError(error) {
          if (!error) return null;
          return {
            name: error.name ?? null,
            message: error.message ?? String(error),
            stack: error.stack ?? null,
          };
        }
        function serializeRecord(record) {
          if (!record) return null;
          const out = {};
          for (const key of Object.keys(record)) out[key] = record[key];
          for (const key of [
            'vendor',
            'architecture',
            'device',
            'description',
            'subgroupMinSize',
            'subgroupMaxSize',
            'isFallbackAdapter',
          ]) {
            if (typeof record[key] !== 'undefined') out[key] = record[key];
          }
          return out;
        }
        function pickLimits(limits) {
          if (!limits) return null;
          const keys = [
            'maxTextureDimension1D',
            'maxTextureDimension2D',
            'maxTextureDimension3D',
            'maxTextureArrayLayers',
            'maxBindGroups',
            'maxBindGroupsPlusVertexBuffers',
            'maxBindingsPerBindGroup',
            'maxDynamicUniformBuffersPerPipelineLayout',
            'maxDynamicStorageBuffersPerPipelineLayout',
            'maxSampledTexturesPerShaderStage',
            'maxSamplersPerShaderStage',
            'maxStorageBuffersPerShaderStage',
            'maxStorageTexturesPerShaderStage',
            'maxUniformBuffersPerShaderStage',
            'maxUniformBufferBindingSize',
            'maxStorageBufferBindingSize',
            'minUniformBufferOffsetAlignment',
            'minStorageBufferOffsetAlignment',
            'maxVertexBuffers',
            'maxBufferSize',
            'maxVertexAttributes',
            'maxVertexBufferArrayStride',
            'maxInterStageShaderComponents',
            'maxInterStageShaderVariables',
            'maxColorAttachments',
            'maxColorAttachmentBytesPerSample',
            'maxComputeWorkgroupStorageSize',
            'maxComputeInvocationsPerWorkgroup',
            'maxComputeWorkgroupSizeX',
            'maxComputeWorkgroupSizeY',
            'maxComputeWorkgroupSizeZ',
            'maxComputeWorkgroupsPerDimension',
          ];
          const out = {};
          for (const key of keys) {
            if (typeof limits[key] !== 'undefined') out[key] = limits[key];
          }
          return out;
        }
        async function collectWebGpuDiagnostics() {
          const diagnostics = {
            present: Boolean(navigator.gpu),
            adapter: null,
            adapter_error: null,
          };
          if (!navigator.gpu) return diagnostics;
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
              diagnostics.adapter_error = 'requestAdapter returned null';
              return diagnostics;
            }
            let info = null;
            try {
              if (adapter.info) info = serializeRecord(adapter.info);
              else if (typeof adapter.requestAdapterInfo === 'function') {
                info = serializeRecord(await adapter.requestAdapterInfo());
              }
            } catch (error) {
              info = { error: serializeError(error) };
            }
            diagnostics.adapter = {
              info,
              features: adapter.features ? Array.from(adapter.features).sort() : [],
              limits: pickLimits(adapter.limits),
            };
            return diagnostics;
          } catch (error) {
            diagnostics.adapter_error = serializeError(error);
            return diagnostics;
          }
        }
        function makeValidBlob(seed) {
          const blob = new Uint8Array(config.blobSize);
          const chunks = config.blobSize / 32;
          for (let i = 0; i < chunks; i += 1) {
            const offset = i * 32;
            blob[offset] = 0;
            for (let j = 1; j < 32; j += 1) {
              blob[offset + j] = (seed + i * 17 + j * 29) & 0xff;
            }
          }
          return blob;
        }
        function hex(bytes) {
          return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        }
        function stats(values) {
          const sorted = [...values].sort((a, b) => a - b);
          const pick = (quantile) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
          return {
            min: sorted[0] ?? 0,
            median: pick(0.5),
            p95: pick(0.95),
            max: sorted[sorted.length - 1] ?? 0,
            mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
          };
        }
        function throughputStats(totalMsValues) {
          return {
            blobs_per_sec: stats(totalMsValues.map((ms) => ms > 0 ? (config.blobCount * 1000) / ms : 0)),
            mib_per_sec: stats(totalMsValues.map((ms) => ms > 0 ? ((config.blobCount * config.blobSize) / 1024 / 1024 * 1000) / ms : 0)),
          };
        }
        function timingStats(runResults, key) {
          return stats(runResults.map((run) => run.gpu_timings[key] ?? 0));
        }

        const wasmMod = await import('/wasm/polystore_core.js');
        const msmMod = await import('/src/lib/webgpuKzgMsm.ts');
        const webgpuDiagnostics = await collectWebGpuDiagnostics();
        const wasmBytes = await fetch('/wasm/polystore_core_bg.wasm').then((response) => response.arrayBuffer());
        await wasmMod.default({ module_or_path: wasmBytes });
        const trustedSetupBytes = new Uint8Array(
          await fetch('/trusted_setup.txt').then((response) => response.arrayBuffer()),
        );
        const polyStoreWasm = new wasmMod.PolyStoreWasm(trustedSetupBytes);

        if (typeof polyStoreWasm.webgpu_g1_srs_lagrange !== 'function') {
          throw new Error('wasm bundle is missing webgpu_g1_srs_lagrange; run npm run wasm:build');
        }

        const blobs = new Uint8Array(config.blobSize * config.blobCount);
        for (let i = 0; i < config.blobCount; i += 1) {
          blobs.set(makeValidBlob(41 + i), i * config.blobSize);
        }

        const gpuInitStart = performance.now();
        let committer = null;
        let gpuInitMs = 0;

        const runResults = [];
        let wasmCommitments = null;
        let error = null;
        let deviceLost = null;
        try {
          committer = await msmMod.createWebGpuKzgMsmCommitter(polyStoreWasm, navigator, {
            bucketWidth: config.bucketWidth,
            reductionMode: config.reductionMode,
          });
          gpuInitMs = performance.now() - gpuInitStart;

          for (let run = 0; run < config.runs; run += 1) {
            const wasmStart = performance.now();
            wasmCommitments = polyStoreWasm.commit_blobs(blobs);
            const wasmMs = performance.now() - wasmStart;
            const gpu = await committer.commitBlobs(blobs);
            runResults.push({
              run,
              wasm_ms: wasmMs,
              gpu_timings: gpu.timings,
              gpu_debug: gpu.debug ?? null,
              device_lost_after_run: await committer.getDeviceLostInfo(25),
              parity: hex(wasmCommitments) === hex(gpu.commitments),
              commitment_bytes: gpu.commitments.byteLength,
              first_commitment: hex(gpu.commitments.slice(0, 48)),
            });
          }
        } catch (caught) {
          error = serializeError(caught);
          if (committer) deviceLost = await committer.getDeviceLostInfo(500);
          if (!config.diagnostic) throw caught;
        } finally {
          committer?.destroy();
        }

        const totals = runResults.map((run) => run.gpu_timings.totalMs);
        const wasmTotals = runResults.map((run) => run.wasm_ms);

        return {
          diagnostic: config.diagnostic,
          browser: {
            user_agent: navigator.userAgent,
            hardware_concurrency: navigator.hardwareConcurrency ?? null,
            cross_origin_isolated: crossOriginIsolated,
            webgpu_present: Boolean(navigator.gpu),
          },
          webgpu_diagnostics: webgpuDiagnostics,
          timing_source: {
            selected: 'cpu-wall-clock',
            gpu_timestamp_query_available: Boolean(webgpuDiagnostics.adapter?.features?.includes('timestamp-query')),
            reason: 'Browser benchmark uses performance.now around upload, dispatch/readback, and WASM fold stages so it also works on adapters without timestamp-query.',
          },
          blob_count: config.blobCount,
          bucket_width: config.bucketWidth,
          requested_reduction_mode: config.reductionMode ?? null,
          reduction_mode: runResults[0]?.gpu_debug?.reductionMode ?? config.reductionMode ?? null,
          runs: config.runs,
          wasm_ms: stats(wasmTotals),
          wasm_throughput: throughputStats(wasmTotals),
          gpu_init_ms: gpuInitMs,
          gpu_total_ms: stats(totals),
          gpu_throughput: throughputStats(totals),
          gpu_stage_ms: {
            scalar_prep: timingStats(runResults, 'scalarPrepMs'),
            bucket_build: timingStats(runResults, 'bucketBuildMs'),
            upload: timingStats(runResults, 'uploadMs'),
            dispatch_readback: timingStats(runResults, 'dispatchReadbackMs'),
            fold: timingStats(runResults, 'foldMs'),
          },
          run_results: runResults,
          error,
          device_lost: deviceLost,
          parity: runResults.length > 0 && runResults.every((run) => run.parity),
          commitment_bytes: runResults[0]?.commitment_bytes ?? 0,
          first_commitment: runResults[0]?.first_commitment ?? '',
        };
      };
    `,
  })

  const matrixResults: BenchmarkRunResult[] = []
  for (const blobCount of blobCounts) {
    for (const bucketWidth of bucketWidths) {
      for (const reductionMode of reductionModes) {
        const result = await page.evaluate(`window.__runPolyStoreKzgWebGpuMsmBenchmark(${JSON.stringify({
          blobSize: BLOB_SIZE,
          blobCount,
          bucketWidth,
          runs,
          diagnostic,
          reductionMode,
        })})`)
        matrixResults.push(result as BenchmarkRunResult)
      }
    }
  }

  const result = matrixResults.length === 1 ? matrixResults[0] : {
    diagnostic,
    matrix: {
      blob_counts: blobCounts,
      bucket_widths: bucketWidths,
      reduction_modes: reductionModes.map((mode) => mode ?? 'auto'),
      runs,
      results: matrixResults,
      recommendation: recommendMatrixThreshold(matrixResults),
    },
  }

  console.log(
    JSON.stringify(
      {
        benchmark: 'browser-kzg-webgpu-msm',
        timestamp: new Date().toISOString(),
        git: gitMetadata(),
        host: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpus: os.cpus().length,
          total_memory_gib: os.totalmem() / 1024 / 1024 / 1024,
        },
        result,
      },
      null,
      2,
    ),
  )

  if (!diagnostic && matrixResults.some((item) => (item as { error?: unknown }).error)) {
    throw new Error('WebGPU MSM diagnostic captured a benchmark failure')
  }

  if (!diagnostic && matrixResults.some((item) => !(item as { parity?: boolean }).parity)) {
    throw new Error('WebGPU MSM commitment parity failed')
  }
} finally {
  await browser?.close()
  await vite.close()
}
