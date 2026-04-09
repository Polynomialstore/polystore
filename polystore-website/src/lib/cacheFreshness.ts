export type CacheFreshnessStatus = 'fresh' | 'stale' | 'unknown'

export type CacheFreshnessReason =
  | 'fresh'
  | 'chain_manifest_missing'
  | 'local_manifest_missing'
  | 'stale_manifest_mismatch'

export interface CacheFreshnessResult {
  status: CacheFreshnessStatus
  reason: CacheFreshnessReason
  localManifestRoot: string
  chainManifestRoot: string
}

export function normalizeManifestRoot(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
}

export function evaluateCacheFreshness(
  localManifestRoot: string | null | undefined,
  chainManifestRoot: string | null | undefined,
): CacheFreshnessResult {
  const local = normalizeManifestRoot(localManifestRoot)
  const chain = normalizeManifestRoot(chainManifestRoot)
  if (!chain) {
    return {
      status: 'unknown',
      reason: 'chain_manifest_missing',
      localManifestRoot: local,
      chainManifestRoot: chain,
    }
  }
  if (!local) {
    return {
      status: 'unknown',
      reason: 'local_manifest_missing',
      localManifestRoot: local,
      chainManifestRoot: chain,
    }
  }
  if (local === chain) {
    return {
      status: 'fresh',
      reason: 'fresh',
      localManifestRoot: local,
      chainManifestRoot: chain,
    }
  }
  return {
    status: 'stale',
    reason: 'stale_manifest_mismatch',
    localManifestRoot: local,
    chainManifestRoot: chain,
  }
}
