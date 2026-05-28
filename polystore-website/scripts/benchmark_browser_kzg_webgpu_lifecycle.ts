import os from 'node:os'

import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const BLOB_SIZE = 128 * 1024

const vite = await createServer({
  root: process.cwd(),
  server: {
    host: '127.0.0.1',
    port: 0,
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
  browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' })
  const page = await browser.newPage()
  await page.goto(`${origin}/`)
  await page.addScriptTag({
    content: `
      window.__runPolyStoreKzgWebGpuLifecycleBenchmark = async function(config) {
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

        const wasmMod = await import('/wasm/polystore_core.js');
        const backendMod = await import('/src/lib/kzgCommitBackend.ts');
        const wasmBytes = await fetch('/wasm/polystore_core_bg.wasm').then((response) => response.arrayBuffer());

        const wasmInitStart = performance.now();
        await wasmMod.default({ module_or_path: wasmBytes });
        const trustedSetupBytes = new Uint8Array(
          await fetch('/trusted_setup.txt').then((response) => response.arrayBuffer()),
        );
        const wasmSetupStart = performance.now();
        const polyStoreWasm = new wasmMod.PolyStoreWasm(trustedSetupBytes);
        const wasmSetupMs = performance.now() - wasmSetupStart;
        const wasmInitMs = performance.now() - wasmInitStart;

        const backendStart = performance.now();
        const backend = await backendMod.createBrowserKzgCommitBackend(polyStoreWasm, trustedSetupBytes, {
          preferWebGpu: true,
        });
        const backendInitMs = performance.now() - backendStart;

        const blob = makeValidBlob(41);
        const commitStart = performance.now();
        const profiled = backend.commitBlobsProfiled(blob);
        const commitWallMs = performance.now() - commitStart;

        return {
          backend_status: backend.getStatus(),
          browser: {
            user_agent: navigator.userAgent,
            hardware_concurrency: navigator.hardwareConcurrency ?? null,
            device_memory_gib: 'deviceMemory' in navigator ? navigator.deviceMemory ?? null : null,
            cross_origin_isolated: crossOriginIsolated,
            webgpu_present: Boolean(navigator.gpu),
          },
          wasm: {
            init_ms: wasmInitMs,
            setup_ms: wasmSetupMs,
          },
          backend_init_ms: backendInitMs,
          commitment_smoke: {
            blob_count: 1,
            commitment_bytes: profiled.witnessFlat.byteLength,
            wall_ms: commitWallMs,
            rust_total_ms: profiled.perf.totalMs,
            rust_msm_ms: profiled.perf.msmMs,
          },
        };
      };
    `,
  })

  const result = await page.evaluate(`window.__runPolyStoreKzgWebGpuLifecycleBenchmark(${JSON.stringify({
    blobSize: BLOB_SIZE,
  })})`)

  console.log(
    JSON.stringify(
      {
        benchmark: 'browser-kzg-webgpu-lifecycle',
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
} finally {
  await browser?.close()
  await vite.close()
}
