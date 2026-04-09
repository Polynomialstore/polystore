import type { LcdProvider } from '../domain/lcd'
import { multiaddrToHttpUrl } from './multiaddr'

export function normalizeHttpBase(input: string): string | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      url.hash = ''
      url.search = ''
      url.pathname = url.pathname.replace(/\/+$/, '')
      return url.toString().replace(/\/$/, '')
    } catch {
      return null
    }
  }

  const derived = multiaddrToHttpUrl(raw)
  if (!derived) return null
  return derived.replace(/\/$/, '')
}

export function extractProviderHttpBases(endpoints?: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const ep of Array.isArray(endpoints) ? endpoints : []) {
    const base = normalizeHttpBase(ep)
    if (!base) continue
    if (seen.has(base)) continue
    seen.add(base)
    out.push(base)
  }
  return out
}

export function isLikelyLocalHttpBase(base: string): boolean {
  try {
    const url = new URL(base)
    const host = String(url.hostname || '').toLowerCase()
    if (host === 'localhost') return true
    if (host === '::1') return true
    if (/^127\./.test(host)) return true
    return false
  } catch {
    return false
  }
}

export function isLocalDemoProvider(provider: LcdProvider): boolean {
  const bases = extractProviderHttpBases(provider.endpoints)
  return bases.some(isLikelyLocalHttpBase)
}

