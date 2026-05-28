import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')
const publicRoot = path.resolve(websiteRoot, 'public')

const BLOB_SIZE = 128 * 1024

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseBlobMatrix(): number[] {
  const raw = process.env.KZG_BENCH_BLOBS || '1,4,16,64,256'
  const values = raw.split(',').map((part) => {
    const token = part.trim()
    const value = Number(token)
    if (token.length === 0 || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error('KZG_BENCH_BLOBS must be a comma-separated list of positive integers')
    }
    return value
  })
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('KZG_BENCH_BLOBS must be a comma-separated list of positive integers')
  }
  return values
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.wasm')) return 'application/wasm'
  if (filePath.endsWith('.txt')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

async function startStaticServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const pathname = url.pathname === '/' ? '/benchmark.html' : url.pathname
      if (pathname === '/benchmark.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><title>PolyStore KZG Browser Benchmark</title>')
        return
      }

      const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
      const filePath = path.join(publicRoot, normalized)
      if (!filePath.startsWith(publicRoot)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const bytes = await fs.readFile(filePath)
      res.writeHead(200, { 'content-type': contentType(filePath) })
      res.end(bytes)
    } catch (error) {
      res.writeHead(404)
      res.end(error instanceof Error ? error.message : 'not found')
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to allocate benchmark server port')
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

const config = {
  blobCounts: parseBlobMatrix(),
  warmupRuns: parsePositiveInt('KZG_BENCH_WARMUP_RUNS', 1),
  measureRuns: parsePositiveInt('KZG_BENCH_MEASURE_RUNS', 3),
}

const server = await startStaticServer()
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' })
  const page = await browser.newPage()
  await page.goto(`${server.origin}/benchmark.html`)
  await page.addScriptTag({
    content: `
      window.__runPolyStoreKzgBenchmark = async function(config) {
        const { blobCounts, warmupRuns, measureRuns, blobSize } = config;

        function makeValidBlob(seed) {
          const blob = new Uint8Array(blobSize);
          const chunks = blobSize / 32;
          for (let i = 0; i < chunks; i += 1) {
            const offset = i * 32;
            blob[offset] = 0;
            for (let j = 1; j < 32; j += 1) {
              blob[offset + j] = (seed + i * 17 + j * 29) & 0xff;
            }
          }
          return blob;
        }

        function makeBatch(blobCount) {
          const batch = new Uint8Array(blobSize * blobCount);
          for (let i = 0; i < blobCount; i += 1) {
            batch.set(makeValidBlob(11 + i), i * blobSize);
          }
          return batch;
        }

        function summarize(values) {
          const sorted = [...values].sort((a, b) => a - b);
          const middle = Math.floor(sorted.length / 2);
          const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
          const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
          return { min: sorted[0], median, mean, max: sorted[sorted.length - 1] };
        }

        const mod = await import('/wasm/polystore_core.js');
        const wasmBytes = await fetch('/wasm/polystore_core_bg.wasm').then((response) => response.arrayBuffer());
        const initStart = performance.now();
        await mod.default({ module_or_path: wasmBytes });
        const trustedSetupBytes = new Uint8Array(
          await fetch('/trusted_setup.txt').then((response) => response.arrayBuffer()),
        );
        const setupStart = performance.now();
        const polyStoreWasm = new mod.PolyStoreWasm(trustedSetupBytes);
        const setupMs = performance.now() - setupStart;
        const initMs = performance.now() - initStart;

        const batches = [];
        for (const blobCount of blobCounts) {
          const data = makeBatch(blobCount);
          for (let i = 0; i < warmupRuns; i += 1) {
            polyStoreWasm.commit_blobs_profiled(data);
          }

          const runs = [];
          for (let i = 0; i < measureRuns; i += 1) {
            const start = performance.now();
            const raw = polyStoreWasm.commit_blobs_profiled(data);
            const wallMs = performance.now() - start;
            const witnessBytes =
              raw.witness_flat instanceof Uint8Array
                ? raw.witness_flat.byteLength
                : new Uint8Array(raw.witness_flat).byteLength;
            runs.push({
              wall_ms: wallMs,
              rust_total_ms: Number(raw.perf?.total_ms ?? 0),
              rust_msm_ms: Number(raw.perf?.msm_ms ?? 0),
              rust_decode_ms: Number(raw.perf?.decode_ms ?? 0),
              rust_compress_ms: Number(raw.perf?.compress_ms ?? 0),
              witness_bytes: witnessBytes,
            });
          }

          const wallMs = runs.map((run) => run.wall_ms);
          const perBlobMs = wallMs.map((ms) => ms / blobCount);
          const perMduMs = perBlobMs.map((ms) => ms * 64);
          const throughputMibSec = wallMs.map((ms) => ((blobCount * blobSize) / (1024 * 1024)) / (ms / 1000));
          batches.push({
            blob_count: blobCount,
            input_mib: (blobCount * blobSize) / (1024 * 1024),
            wall_ms: summarize(wallMs),
            per_blob_ms: summarize(perBlobMs),
            per_mdu_ms: summarize(perMduMs),
            throughput_mib_sec: summarize(throughputMibSec),
            rust_total_ms: summarize(runs.map((run) => run.rust_total_ms)),
            rust_msm_ms: summarize(runs.map((run) => run.rust_msm_ms)),
            rust_decode_ms: summarize(runs.map((run) => run.rust_decode_ms)),
            rust_compress_ms: summarize(runs.map((run) => run.rust_compress_ms)),
            runs,
          });
        }

        return {
          backend: 'wasm-blst',
          scheduling_mode: 'direct-browser-wasm-profiled',
          worker_count: 0,
          browser: {
            user_agent: navigator.userAgent,
            hardware_concurrency: navigator.hardwareConcurrency ?? null,
            device_memory_gib: 'deviceMemory' in navigator ? navigator.deviceMemory ?? null : null,
            cross_origin_isolated: crossOriginIsolated,
          },
          wasm: {
            init_ms: initMs,
            setup_ms: setupMs,
          },
          batches,
        };
      };
    `,
  })
  const result = await page.evaluate(`window.__runPolyStoreKzgBenchmark(${JSON.stringify({
    blobCounts: config.blobCounts,
    warmupRuns: config.warmupRuns,
    measureRuns: config.measureRuns,
    blobSize: BLOB_SIZE,
  })})`) as {
    batches: Array<{
      blob_count: number
      wall_ms: { median: number }
      per_blob_ms: { median: number }
      per_mdu_ms: { median: number }
      throughput_mib_sec: { median: number }
    }>
  }

  console.log(
    JSON.stringify(
      {
        benchmark: 'browser-kzg-commit-baseline',
        timestamp: new Date().toISOString(),
        config,
        host: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpus: os.cpus().length,
          total_memory_gib: os.totalmem() / 1024 / 1024 / 1024,
        },
        result,
        summary: result.batches.map((batch) => ({
          blob_count: batch.blob_count,
          wall_ms_median: batch.wall_ms.median,
          per_blob_ms_median: batch.per_blob_ms.median,
          per_mdu_ms_median: batch.per_mdu_ms.median,
          throughput_mib_sec_median: batch.throughput_mib_sec.median,
        })),
      },
      null,
      2,
    ),
  )
} finally {
  await browser?.close()
  await server.close()
}
