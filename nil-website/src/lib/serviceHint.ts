export interface ServiceHintInfo {
  base: string
  replicas?: number
  rsK?: number
  rsM?: number
  mode: 'mode1' | 'mode2'
}

export function parseServiceHint(raw?: string | null): ServiceHintInfo {
  const trimmed = String(raw || '').trim()
  if (!trimmed) {
    return { base: '', mode: 'mode1' }
  }

  const [baseRaw, ...extras] = trimmed.split(':')
  const info: ServiceHintInfo = {
    base: baseRaw.trim(),
    mode: 'mode1',
  }

  for (const token of extras) {
    const [keyRaw, valRaw] = token.split('=', 2)
    const key = (keyRaw || '').trim().toLowerCase()
    const val = (valRaw || '').trim()
    if (!key || !val) continue
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

export function buildServiceHint(base: string, opts: { replicas?: number; rsK?: number; rsM?: number }): string {
  const hintBase = base.trim() || 'General'
  const extras: string[] = []
  if (opts.replicas && opts.replicas > 0) {
    extras.push(`replicas=${Math.round(opts.replicas)}`)
  }
  if (opts.rsK && opts.rsM) {
    extras.push(`rs=${Math.round(opts.rsK)}+${Math.round(opts.rsM)}`)
  }
  if (extras.length === 0) return hintBase
  return `${hintBase}:${extras.join(':')}`
}
