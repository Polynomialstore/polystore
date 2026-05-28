import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'

import { chromium } from '@playwright/test'

type WebGpuPreflightResult = {
  userAgent: string
  secureContext: boolean
  crossOriginIsolated: boolean
  gpuPresent: boolean
  adapter: null | {
    features: string[]
    limits: Record<string, number>
    info: unknown
  }
  device: null | {
    label: string
    smokeOutput: number[]
  }
  error: null | string
}

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

function detectChromePath(): string {
  const configured = process.env.POLYSTORE_CHROME_PATH
  if (configured) return configured

  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error(
    `No Chrome executable found. Set POLYSTORE_CHROME_PATH or install one of: ${DEFAULT_CHROME_CANDIDATES.join(', ')}`,
  )
}

function launchArgs(): string[] {
  const extra = process.env.POLYSTORE_WEBGPU_CHROME_ARGS
    ? process.env.POLYSTORE_WEBGPU_CHROME_ARGS.split(/\s+/).filter(Boolean)
    : []
  return [...DEFAULT_WEBGPU_ARGS, ...extra]
}

function headlessMode(): boolean {
  return process.env.POLYSTORE_WEBGPU_HEADLESS !== '0'
}

function allowFallback(): boolean {
  return process.env.POLYSTORE_WEBGPU_ALLOW_FALLBACK === '1'
}

function startStaticServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    })
    res.end('<!doctype html><meta charset="utf-8"><title>PolyStore WebGPU Preflight</title>')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate local preflight server port'))
        return
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` })
    })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function runPreflight(origin: string, chromePath: string, args: string[]): Promise<WebGpuPreflightResult> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: headlessMode(),
      args,
    })
    const page = await browser.newPage()
    await page.goto(origin)
    return await page.evaluate(async () => {
      const result: WebGpuPreflightResult = {
        userAgent: navigator.userAgent,
        secureContext: window.isSecureContext,
        crossOriginIsolated: window.crossOriginIsolated,
        gpuPresent: Boolean(navigator.gpu),
        adapter: null,
        device: null,
        error: null,
      }

      if (!navigator.gpu) {
        result.error = 'navigator.gpu is unavailable'
        return result
      }

      try {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) {
          result.error = 'navigator.gpu.requestAdapter() returned null'
          return result
        }

        const adapterLike = adapter as unknown as {
          requestAdapterInfo?: () => Promise<unknown>
        }
        result.adapter = {
          features: Array.from(adapter.features).sort(),
          limits: {
            maxBufferSize: adapter.limits.maxBufferSize,
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
            maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
            maxComputeWorkgroupSizeY: adapter.limits.maxComputeWorkgroupSizeY,
            maxComputeWorkgroupSizeZ: adapter.limits.maxComputeWorkgroupSizeZ,
            maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
            maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
          },
          info: adapterLike.requestAdapterInfo ? await adapterLike.requestAdapterInfo().catch((error) => String(error)) : null,
        }

        const device = await adapter.requestDevice({ label: 'polystore-webgpu-preflight' })
        const input = new Uint32Array([3, 5, 8, 13])
        const inputBuffer = device.createBuffer({
          label: 'preflight-input',
          size: input.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        const outputBuffer = device.createBuffer({
          label: 'preflight-output',
          size: input.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const readbackBuffer = device.createBuffer({
          label: 'preflight-readback',
          size: input.byteLength,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(inputBuffer, 0, input)

        const shader = device.createShaderModule({
          label: 'preflight-compute-shader',
          code: `
            @group(0) @binding(0) var<storage, read> input: array<u32>;
            @group(0) @binding(1) var<storage, read_write> output: array<u32>;

            @compute @workgroup_size(4)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
              output[id.x] = input[id.x] * 2u;
            }
          `,
        })
        const pipeline = device.createComputePipeline({
          label: 'preflight-compute-pipeline',
          layout: 'auto',
          compute: { module: shader, entryPoint: 'main' },
        })
        const bindGroup = device.createBindGroup({
          label: 'preflight-bind-group',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } },
          ],
        })

        const encoder = device.createCommandEncoder({ label: 'preflight-command-encoder' })
        const pass = encoder.beginComputePass({ label: 'preflight-compute-pass' })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(1)
        pass.end()
        encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, input.byteLength)
        device.queue.submit([encoder.finish()])
        await readbackBuffer.mapAsync(GPUMapMode.READ)
        const smokeOutput = Array.from(new Uint32Array(readbackBuffer.getMappedRange().slice(0)))
        readbackBuffer.unmap()

        result.device = { label: device.label, smokeOutput }
        return result
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
        return result
      }
    })
  } finally {
    await browser?.close()
  }
}

const chromePath = detectChromePath()
const args = launchArgs()
const { server, origin } = await startStaticServer()

try {
  const result = await runPreflight(origin, chromePath, args)
  const payload = {
    preflight: 'chrome-webgpu',
    timestamp: new Date().toISOString(),
    chromePath,
    headless: headlessMode(),
    args,
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemoryGiB: os.totalmem() / 1024 / 1024 / 1024,
      display: process.env.DISPLAY ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
    },
    result,
  }
  console.log(JSON.stringify(payload, null, 2))

  const smokeOk = result.device?.smokeOutput.join(',') === '6,10,16,26'
  if ((!result.adapter || !result.device || !smokeOk) && !allowFallback()) {
    process.exitCode = 1
  }
} finally {
  await closeServer(server)
}
