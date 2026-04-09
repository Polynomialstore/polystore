export interface ServiceHintInfo {
  base: string
  owner?: string
  // Deprecated: Mode 1 (replicas-only) hints are soft-locked and should not be emitted.
  replicas?: number
  rsK?: number
  rsM?: number
  // 'auto' means "Mode 2, profile auto-selected by the chain".
  mode: 'auto' | 'mode2'
}

export function parseServiceHint(raw?: string | null): ServiceHintInfo {
  const trimmed = String(raw || '').trim()
  if (!trimmed) {
    return { base: 'General', mode: 'auto' }
  }

  const [baseRaw, ...extras] = trimmed.split(':')
  const info: ServiceHintInfo = {
    base: baseRaw.trim(),
    mode: 'auto',
  }

  for (const token of extras) {
    const [keyRaw, valRaw] = token.split('=', 2)
    const key = (keyRaw || '').trim().toLowerCase()
    const val = (valRaw || '').trim()
    if (!key || !val) continue
    if (key === 'owner') {
      info.owner = val
      continue
    }
    if (key === 'replicas') {
      const n = Number(val)
      if (Number.isFinite(n) && n > 0) info.replicas = n
    }
    if (key === 'rs') {
      const parts = val.split('+')
      if (parts.length === 2) {
        const k = Number(parts[0])
        const m = Number(parts[1])
        if (Number.isFinite(k) && Number.isFinite(m) && k > 0 && m > 0) {
          info.rsK = k
          info.rsM = m
          info.mode = 'mode2'
        }
      }
    }
  }
  return info
}

export function buildServiceHint(base: string, opts: { owner?: string; rsK?: number; rsM?: number }): string {
  const hintBase = base.trim() || 'General'
  const extras: string[] = []
  if (opts.owner && opts.owner.trim()) {
    extras.push(`owner=${opts.owner.trim()}`)
  }
  if (opts.rsK && opts.rsM) {
    extras.push(`rs=${Math.round(opts.rsK)}+${Math.round(opts.rsM)}`)
  }
  if (extras.length === 0) return hintBase
  return `${hintBase}:${extras.join(':')}`
}
