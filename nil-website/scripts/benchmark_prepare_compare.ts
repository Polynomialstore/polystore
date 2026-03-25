import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Stats = {
  min: number
  median: number
  mean: number
  max: number
}

type ModeResult = {
  mode: string
  totals: number[]
  userStage: number[]
  witnessStage: number[]
  metaStage: number[]
  manifest: number[]
  stats: {
    total_ms: Stats
    user_stage_ms: Stats
    witness_stage_ms: Stats
    meta_stage_ms: Stats
    manifest_ms: Stats
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

const modes = (process.env.BASIS_MODES || 'blst,affine,projective')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const cycles = Number(process.env.CYCLES || 3)
const fileBytes = process.env.FILE_BYTES || '8126464'

if (modes.length === 0) {
  throw new Error('BASIS_MODES must include at least one mode')
}
if (!Number.isFinite(cycles) || cycles <= 0) {
  throw new Error(`invalid CYCLES: ${process.env.CYCLES ?? ''}`)
}

function readStats(values: number[]): Stats {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return { min: 0, median: 0, mean: 0, max: 0 }
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { min: sorted[0], median, mean, max: sorted[sorted.length - 1] }
}

const results = new Map<string, ModeResult>()
for (const mode of modes) {
  results.set(mode, {
    mode,
    totals: [],
    userStage: [],
    witnessStage: [],
    metaStage: [],
    manifest: [],
    stats: {
      total_ms: { min: 0, median: 0, mean: 0, max: 0 },
      user_stage_ms: { min: 0, median: 0, mean: 0, max: 0 },
      witness_stage_ms: { min: 0, median: 0, mean: 0, max: 0 },
      meta_stage_ms: { min: 0, median: 0, mean: 0, max: 0 },
      manifest_ms: { min: 0, median: 0, mean: 0, max: 0 },
    },
  })
}

for (let cycle = 0; cycle < cycles; cycle += 1) {
  for (const mode of modes) {
    const child = spawnSync(
      'npm',
      ['--silent', '--prefix', 'nil-website', 'run', 'perf:prepare-stages'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BASIS_MODE: mode,
          FILE_BYTES: fileBytes,
          WARMUP_RUNS: '0',
          MEASURE_RUNS: '1',
        },
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
    )

    if (child.status !== 0) {
      throw new Error(
        `benchmark failed for mode=${mode} cycle=${cycle + 1}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
      )
    }

    const parsed = JSON.parse(child.stdout) as {
      stages: {
        total_ms: { median: number }
        user_stage_ms: { median: number }
        witness_stage_ms: { median: number }
        meta_stage_ms: { median: number }
        manifest_ms: { median: number }
      }
    }

    const result = results.get(mode)!
    result.totals.push(parsed.stages.total_ms.median)
    result.userStage.push(parsed.stages.user_stage_ms.median)
    result.witnessStage.push(parsed.stages.witness_stage_ms.median)
    result.metaStage.push(parsed.stages.meta_stage_ms.median)
    result.manifest.push(parsed.stages.manifest_ms.median)
  }
}

for (const result of results.values()) {
  result.stats = {
    total_ms: readStats(result.totals),
    user_stage_ms: readStats(result.userStage),
    witness_stage_ms: readStats(result.witnessStage),
    meta_stage_ms: readStats(result.metaStage),
    manifest_ms: readStats(result.manifest),
  }
}

const summary = {
  file_bytes: Number(fileBytes),
  cycles,
  modes,
  results: Object.fromEntries(
    [...results.entries()].map(([mode, result]) => [
      mode,
      {
        totals: result.totals,
        user_stage: result.userStage,
        witness_stage: result.witnessStage,
        meta_stage: result.metaStage,
        manifest: result.manifest,
        stats: result.stats,
      },
    ]),
  ),
}

console.log(JSON.stringify(summary, null, 2))
