import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import init, { PolyStoreWasm } from '../public/wasm/polystore_core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const websiteRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(websiteRoot, '..')

const BLOB_SIZE = 128 * 1024
const MDU_SIZE_BYTES = 8 * 1024 * 1024
const SCALAR_BYTES = 32
const SCALAR_PAYLOAD_BYTES = 31
const RAW_MDU_CAPACITY = Math.floor(MDU_SIZE_BYTES / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES

type Stats = {
  min: number
  median: number
  mean: number
  max: number
}

type CommitPerf = {
  decode_ms?: number
  transform_ms?: number
  msm_scalar_prep_ms?: number
  msm_bucket_fill_ms?: number
  msm_reduce_ms?: number
  msm_double_ms?: number
  msm_ms?: number
  compress_ms?: number
  total_ms?: number
  blobs?: number
}

type StagesSummary = {
  file_bytes: number
  raw_mdu_capacity: number
  total_user_mdus: number
  rs_k: number
  rs_m: number
  basis_mode: string
  warmup_runs: number
  measure_runs: number
  init: { polystore_wasm_ms: number }
  stages: {
    total_ms: Stats
    user_stage_ms: Stats
    witness_stage_ms: Stats
    meta_stage_ms: Stats
    manifest_ms: Stats
  }
  phase_totals: {
    user: { phase_totals: Record<string, number> }
    witness: { phase_totals: Record<string, number> }
    meta: { phase_totals: Record<string, number> }
  }
}

type ConcurrencySummary = {
  file_bytes: number
  total_user_mdus: number
  basis_mode: string
  pipeline_modes: string[]
  cycles: number
  concurrencies: number[]
  results: Record<string, { pipeline_mode: string; concurrency: number; worker_count: number; runs: number[]; stats: Stats }>
}

function makeDeterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 17 + 31) & 0xff
  return bytes
}

function toU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value as ArrayBufferLike)
}

function readStats(values: number[]): Stats {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return { min: 0, median: 0, mean: 0, max: 0 }
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { min: sorted[0], median, mean, max: sorted[sorted.length - 1] }
}

function fmtMs(value: number | undefined): string {
  if (!Number.isFinite(value ?? Number.NaN)) return 'n/a'
  return `${(value as number).toFixed(2)} ms`
}

function runCommandJson<T>(label: string, args: string[], env: Record<string, string>): T {
  const child = spawnSync('npm', args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (child.status !== 0) {
    throw new Error(`${label} failed with exit ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`)
  }
  try {
    return JSON.parse(child.stdout) as T
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${child.stdout}`)
  }
}

function gitValue(args: string[]): string {
  const child = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (child.status !== 0) return 'unknown'
  return child.stdout.trim()
}

async function benchmarkSingleBlob(measureRuns: number, warmupRuns: number) {
  const wasmPath = path.resolve(websiteRoot, 'public', 'wasm', 'polystore_core_bg.wasm')
  const wasmBuffer = await fs.readFile(wasmPath)
  const initStart = performance.now()
  await init({ module_or_path: wasmBuffer })
  const trustedSetup = new Uint8Array(await fs.readFile(path.resolve(websiteRoot, 'public', 'trusted_setup.txt')))
  const wasm = new PolyStoreWasm(trustedSetup)
  wasm.set_wasm_msm_basis_mode('blst')
  const initMs = performance.now() - initStart
  const blob = makeDeterministicBytes(BLOB_SIZE)
  const runs: number[] = []
  const msmRuns: number[] = []
  const totalRuns: number[] = []
  let lastPerf: CommitPerf = {}

  for (let i = 0; i < warmupRuns + measureRuns; i += 1) {
    const start = performance.now()
    const raw = wasm.commit_blobs_profiled(blob) as unknown
    const wallMs = performance.now() - start
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const witnessFlat = toU8((parsed as { witness_flat?: unknown }).witness_flat)
    if (witnessFlat.byteLength !== 48) {
      throw new Error(`single-blob witness length mismatch: ${witnessFlat.byteLength}`)
    }
    const perf = ((parsed as { perf?: unknown }).perf ?? {}) as CommitPerf
    if (i >= warmupRuns) {
      runs.push(wallMs)
      msmRuns.push(Number(perf.msm_ms ?? 0))
      totalRuns.push(Number(perf.total_ms ?? wallMs))
      lastPerf = perf
    }
  }

  return {
    blob_bytes: BLOB_SIZE,
    warmup_runs: warmupRuns,
    measure_runs: measureRuns,
    init_ms: initMs,
    wall_ms: readStats(runs),
    rust_total_ms: readStats(totalRuns),
    rust_msm_ms: readStats(msmRuns),
    last_perf: lastPerf,
  }
}

const outputDir = path.resolve(repoRoot, process.env.OUTPUT_DIR || 'polystore-website/perf')
const outputBase = process.env.OUTPUT_BASENAME || 'browser-kzg-baseline-latest'
const singleBlobRuns = Number(process.env.SINGLE_BLOB_RUNS || 5)
const singleBlobWarmups = Number(process.env.SINGLE_BLOB_WARMUPS || 1)
const oneMduRuns = Number(process.env.ONE_MDU_RUNS || 1)
const largeCycles = Number(process.env.LARGE_CYCLES || 1)
const largeFileBytes = Number(process.env.LARGE_FILE_BYTES || 49_103_158)
const concurrencies = process.env.CONCURRENCIES || '5,6,7'
const pipelineModes = process.env.PIPELINE_MODES || 'fused_batch_sampled'

const singleBlob = await benchmarkSingleBlob(singleBlobRuns, singleBlobWarmups)
const oneMdu = runCommandJson<StagesSummary>(
  'one-MDU prepare-stages benchmark',
  ['--silent', '--prefix', 'polystore-website', 'run', 'perf:prepare-stages'],
  {
    FILE_BYTES: String(RAW_MDU_CAPACITY),
    WARMUP_RUNS: '0',
    MEASURE_RUNS: String(oneMduRuns),
    BASIS_MODE: 'blst',
  },
)
const largeWorker = runCommandJson<ConcurrencySummary>(
  'large user-stage worker benchmark',
  ['--silent', '--prefix', 'polystore-website', 'run', 'perf:user-stage-concurrency'],
  {
    FILE_BYTES: String(largeFileBytes),
    CYCLES: String(largeCycles),
    CONCURRENCIES: concurrencies,
    PIPELINE_MODES: pipelineModes,
    BASIS_MODE: 'blst',
  },
)

const generatedAt = new Date().toISOString()
const userPhase = oneMdu.phase_totals.user.phase_totals
const commitmentsPerRawMdu = 64 * (1 + oneMdu.rs_m / oneMdu.rs_k)
const perBlobFromMdu = userPhase.rust_commit_msm_ms / Math.max(1, commitmentsPerRawMdu * oneMdu.measure_runs)
const baseline = {
  generated_at: generatedAt,
  git: {
    branch: gitValue(['branch', '--show-current']),
    commit: gitValue(['rev-parse', 'HEAD']),
    commit_short: gitValue(['rev-parse', '--short', 'HEAD']),
  },
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
    logical_cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
  },
  commands: {
    baseline: `env SINGLE_BLOB_WARMUPS=${singleBlobWarmups} SINGLE_BLOB_RUNS=${singleBlobRuns} ONE_MDU_RUNS=${oneMduRuns} LARGE_CYCLES=${largeCycles} LARGE_FILE_BYTES=${largeFileBytes} CONCURRENCIES=${concurrencies} PIPELINE_MODES=${pipelineModes} npm --prefix polystore-website run perf:browser-kzg-baseline --silent`,
    one_mdu: `env FILE_BYTES=${RAW_MDU_CAPACITY} WARMUP_RUNS=0 MEASURE_RUNS=${oneMduRuns} BASIS_MODE=blst npm --prefix polystore-website run perf:prepare-stages --silent`,
    large_worker: `env FILE_BYTES=${largeFileBytes} CYCLES=${largeCycles} CONCURRENCIES=${concurrencies} PIPELINE_MODES=${pipelineModes} BASIS_MODE=blst npm --prefix polystore-website run perf:user-stage-concurrency --silent`,
  },
  summary: {
    single_blob_wall_median_ms: singleBlob.wall_ms.median,
    one_mdu_total_prepare_median_ms: oneMdu.stages.total_ms.median,
    one_mdu_user_stage_median_ms: oneMdu.stages.user_stage_ms.median,
    one_mdu_user_msm_total_ms: userPhase.rust_commit_msm_ms,
    one_mdu_implied_per_blob_msm_ms: perBlobFromMdu,
    commitments_per_raw_user_mdu: commitmentsPerRawMdu,
  },
  single_blob: singleBlob,
  one_mdu_prepare: oneMdu,
  large_worker_sweep: largeWorker,
}

const workerRows = Object.entries(largeWorker.results)
  .sort(([, a], [, b]) => a.concurrency - b.concurrency || a.pipeline_mode.localeCompare(b.pipeline_mode))
  .map(
    ([key, result]) =>
      `| ${key} | ${result.worker_count} | ${fmtMs(result.stats.median)} | ${fmtMs(result.stats.min)} | ${fmtMs(result.stats.max)} |`,
  )
  .join('\n')

const markdown = `# Browser-Only WASM KZG Baseline

Generated: ${generatedAt}

## Context

| Field | Value |
| --- | --- |
| Branch | \`${baseline.git.branch}\` |
| Commit | \`${baseline.git.commit}\` |
| Node | \`${baseline.runtime.node}\` |
| V8 | \`${baseline.runtime.v8}\` |
| Platform | \`${baseline.runtime.platform}/${baseline.runtime.arch}\` |
| OS release | \`${baseline.runtime.os_release}\` |
| CPU | ${baseline.runtime.cpu_model} |
| Logical CPUs | ${baseline.runtime.logical_cpus} |
| Memory | ${(baseline.runtime.total_memory_bytes / 1024 / 1024 / 1024).toFixed(2)} GiB |

## Summary

| Workload | Key Result | Notes |
| --- | ---: | --- |
| One nonzero 128 KiB blob | ${fmtMs(singleBlob.wall_ms.median)} | Median wall time over ${singleBlob.measure_runs} measured runs. |
| One raw user MDU prepare | ${fmtMs(oneMdu.stages.total_ms.median)} | ${oneMdu.total_user_mdus} user MDU, RS ${oneMdu.rs_k}+${oneMdu.rs_m}. |
| One raw user MDU user stage | ${fmtMs(oneMdu.stages.user_stage_ms.median)} | KZG-dominated stage. |
| One raw user MDU user MSM total | ${fmtMs(userPhase.rust_commit_msm_ms)} | Aggregated profiled Rust/WASM MSM time across measured runs. |
| Implied per-blob MSM from one MDU | ${fmtMs(perBlobFromMdu)} | ${commitmentsPerRawMdu} commitments per raw user MDU. |

## Single Blob Commitment

| Metric | Median | Min | Max |
| --- | ---: | ---: | ---: |
| Wall time | ${fmtMs(singleBlob.wall_ms.median)} | ${fmtMs(singleBlob.wall_ms.min)} | ${fmtMs(singleBlob.wall_ms.max)} |
| Rust total | ${fmtMs(singleBlob.rust_total_ms.median)} | ${fmtMs(singleBlob.rust_total_ms.min)} | ${fmtMs(singleBlob.rust_total_ms.max)} |
| Rust MSM | ${fmtMs(singleBlob.rust_msm_ms.median)} | ${fmtMs(singleBlob.rust_msm_ms.min)} | ${fmtMs(singleBlob.rust_msm_ms.max)} |

## One Raw User MDU Prepare

| Stage | Median |
| --- | ---: |
| Total prepare | ${fmtMs(oneMdu.stages.total_ms.median)} |
| User stage | ${fmtMs(oneMdu.stages.user_stage_ms.median)} |
| Witness stage | ${fmtMs(oneMdu.stages.witness_stage_ms.median)} |
| Metadata stage | ${fmtMs(oneMdu.stages.meta_stage_ms.median)} |
| Manifest | ${fmtMs(oneMdu.stages.manifest_ms.median)} |

## Large User-Stage Worker Sweep

| Mode / Concurrency | Workers Used | Median | Min | Max |
| --- | ---: | ---: | ---: | ---: |
${workerRows}

## Commands

\`\`\`bash
${baseline.commands.baseline}
${baseline.commands.one_mdu}
${baseline.commands.large_worker}
\`\`\`

The single-blob benchmark is run inside \`scripts/benchmark_browser_kzg_baseline.ts\`; set \`SINGLE_BLOB_RUNS\`, \`ONE_MDU_RUNS\`, \`LARGE_CYCLES\`, \`LARGE_FILE_BYTES\`, \`CONCURRENCIES\`, and \`PIPELINE_MODES\` to adjust runtime and coverage.

Browser-runtime evidence is intentionally separate from this Node/V8 baseline. Use this artifact as the stable dependency contract for Rust/WASM KZG algorithm work and worker-thread scheduling comparisons.
`

await fs.mkdir(outputDir, { recursive: true })
await fs.writeFile(path.join(outputDir, `${outputBase}.json`), `${JSON.stringify(baseline, null, 2)}\n`)
await fs.writeFile(path.join(outputDir, `${outputBase}.md`), markdown)
console.log(JSON.stringify(baseline, null, 2))
