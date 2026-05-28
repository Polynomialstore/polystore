import fs from 'node:fs'
import os from 'node:os'

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

const blobCount = Number.parseInt(process.env.POLYSTORE_WEBGPU_MSM_BLOBS ?? '1', 10)
if (!Number.isInteger(blobCount) || blobCount < 1) {
  throw new Error('POLYSTORE_WEBGPU_MSM_BLOBS must be a positive integer')
}
const bucketWidth = Number.parseInt(process.env.POLYSTORE_WEBGPU_MSM_BUCKET_WIDTH ?? '10', 10)
if (!Number.isInteger(bucketWidth) || bucketWidth < 4 || bucketWidth > 13) {
  throw new Error('POLYSTORE_WEBGPU_MSM_BUCKET_WIDTH must be an integer between 4 and 13')
}
const runs = Number.parseInt(process.env.POLYSTORE_WEBGPU_MSM_RUNS ?? '1', 10)
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('POLYSTORE_WEBGPU_MSM_RUNS must be a positive integer')
}

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

        const wasmMod = await import('/wasm/polystore_core.js');
        const msmMod = await import('/src/lib/webgpuKzgMsm.ts');
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
        const committer = await msmMod.createWebGpuKzgMsmCommitter(polyStoreWasm, navigator, {
          bucketWidth: config.bucketWidth,
        });
        const gpuInitMs = performance.now() - gpuInitStart;

        const runResults = [];
        let wasmCommitments = null;
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
            parity: hex(wasmCommitments) === hex(gpu.commitments),
            commitment_bytes: gpu.commitments.byteLength,
            first_commitment: hex(gpu.commitments.slice(0, 48)),
          });
        }
        committer.destroy();

        const totals = runResults.map((run) => run.gpu_timings.totalMs);
        const wasmTotals = runResults.map((run) => run.wasm_ms);

        return {
          browser: {
            user_agent: navigator.userAgent,
            hardware_concurrency: navigator.hardwareConcurrency ?? null,
            cross_origin_isolated: crossOriginIsolated,
            webgpu_present: Boolean(navigator.gpu),
          },
          blob_count: config.blobCount,
          bucket_width: config.bucketWidth,
          runs: config.runs,
          wasm_ms: stats(wasmTotals),
          gpu_init_ms: gpuInitMs,
          gpu_total_ms: stats(totals),
          run_results: runResults,
          parity: runResults.every((run) => run.parity),
          commitment_bytes: runResults[0]?.commitment_bytes ?? 0,
          first_commitment: runResults[0]?.first_commitment ?? '',
        };
      };
    `,
  })

  const result = await page.evaluate(`window.__runPolyStoreKzgWebGpuMsmBenchmark(${JSON.stringify({
    blobSize: BLOB_SIZE,
    blobCount,
    bucketWidth,
    runs,
  })})`)

  console.log(
    JSON.stringify(
      {
        benchmark: 'browser-kzg-webgpu-msm',
        timestamp: new Date().toISOString(),
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

  if (!(result as { parity?: boolean }).parity) {
    throw new Error('WebGPU MSM commitment parity failed')
  }
} finally {
  await browser?.close()
  await vite.close()
}
