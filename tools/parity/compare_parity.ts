import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
}

function getPath(obj: Record<string, unknown>, pathExpr: string): unknown {
  return pathExpr.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

const nativeRaw = run('cargo', ['run', '--release', '--bin', 'parity_native'], path.join(repoRoot, 'nil_core'))
const tsxBin = path.join(
  repoRoot,
  'nil-website',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
)
const wasmRaw = run(tsxBin, ['scripts/parity_wasm.ts'], path.join(repoRoot, 'nil-website'))

const native = JSON.parse(nativeRaw) as Record<string, unknown>
const wasm = JSON.parse(wasmRaw) as Record<string, unknown>

const fields = [
  'fixture.mdu_bytes',
  'fixture.blob_bytes',
  'fixture.root_count',
  'fixture.root_indices',
  'expand_mdu.witness_sha256',
  'expand_mdu.shards_sha256',
  'expand_mdu.mdu_root',
  'expand_mdu_rs.k',
  'expand_mdu_rs.m',
  'expand_mdu_rs.witness_sha256',
  'expand_mdu_rs.shards_sha256',
  'expand_mdu_rs.mdu_root',
  'blob_commitment.commitment_hex',
  'blob_commitment.commitment_sha256',
  'commit_mdu.witness_sha256',
  'commit_mdu.mdu_root',
  'manifest.manifest_root',
  'manifest.manifest_blob_sha256',
]

const diffs: string[] = []
for (const field of fields) {
  const left = getPath(native, field)
  const right = getPath(wasm, field)
  if (!isDeepStrictEqual(left, right)) {
    const leftText = typeof left === 'string' ? left : JSON.stringify(left)
    const rightText = typeof right === 'string' ? right : JSON.stringify(right)
    diffs.push(`${field}: native=${leftText} wasm=${rightText}`)
  }
}

if (diffs.length > 0) {
  console.error('Native/WASM parity mismatch:')
  for (const diff of diffs) console.error(`- ${diff}`)
  process.exit(1)
}

console.log('Native/WASM parity OK')
