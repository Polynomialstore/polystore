import { useEffect, useState } from 'react'
import { appConfig } from '../config'

export interface ProofRow {
  id: string
  creator: string
  commitment: string
  valid: boolean
  blockHeight: number
  dealId?: string
  epochId?: string
  tier?: string
}

export interface UseProofsOptions {
  pollMs?: number
  hiddenPollMs?: number
  enabled?: boolean
}

type UseProofsConfig = number | UseProofsOptions

function parseCommitment(commitment: string): Pick<ProofRow, 'dealId' | 'epochId' | 'tier'> {
  try {
    // Supports both legacy and current formats:
    // - "deal:<id>/epoch:<epoch>/tier:<tier>"
    // - "evidence:... deal=<id> ... tier=<tier>"
    const out: { dealId?: string; epochId?: string; tier?: string } = {}
    const normalized = String(commitment || '').replace(/\//g, ' ')
    const kvPattern = /\b(deal|epoch|tier)\s*[:=]\s*([^\s/]+)/gi
    let match: RegExpExecArray | null
    while ((match = kvPattern.exec(normalized)) !== null) {
      const key = String(match[1] || '').trim().toLowerCase()
      const value = String(match[2] || '').trim()
      if (!value) continue
      if (key === 'deal') out.dealId = value
      else if (key === 'epoch') out.epochId = value
      else if (key === 'tier') out.tier = value
    }
    return out
  } catch {
    return {}
  }
}

export function useProofs(options: UseProofsConfig = {}) {
  const normalizedOptions: UseProofsOptions =
    typeof options === 'number' ? { pollMs: options } : options
  const pollMs = normalizedOptions.pollMs ?? 120_000
  const hiddenPollMs = normalizedOptions.hiddenPollMs ?? 600_000
  const enabled = normalizedOptions.enabled ?? true
  const [proofs, setProofs] = useState<ProofRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setProofs([])
      return
    }

    let cancelled = false
    let timer: number | undefined
    let inFlight = false

    async function load() {
      if (cancelled || inFlight) return
      inFlight = true
      setLoading(true)
      try {
        // This endpoint is paginated; without an explicit limit most LCDs default
        // to a small page size which hides additional retrieval proofs (e.g. when
        // a full-file download is chunked into many blob-sized receipts).
        const url = `${appConfig.lcdBase}/nilchain/nilchain/v1/proofs?pagination.limit=1000&pagination.reverse=true`
        const res = await fetch(url)
        if (!res.ok) return
        const json = await res.json()
        const arr = (Array.isArray(json.proof) ? json.proof : []) as Record<string, unknown>[]
        const mapped: ProofRow[] = arr.map((p) => {
          const base: ProofRow = {
            id: String(p.id ?? ''),
            creator: String(p.creator ?? ''),
            commitment: String(p.commitment ?? ''),
            valid: Boolean(p.valid),
            blockHeight: Number(p.block_height ?? 0),
          }
          const parsed = parseCommitment(base.commitment)
          return { ...base, ...parsed }
        })
        if (!cancelled) setProofs(mapped)
      } catch {
        // ignore, UI will simply show no proofs
      } finally {
        inFlight = false
        if (!cancelled) setLoading(false)
      }
    }

    const schedule = (delayMs: number) => {
      if (cancelled || delayMs <= 0) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runLoop()
      }, delayMs)
    }

    const runLoop = async () => {
      if (cancelled) return
      await load()
      if (cancelled) return
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      schedule(hidden ? hiddenPollMs : pollMs)
    }

    void runLoop()

    const handleVisibility = () => {
      if (cancelled || typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        void runLoop()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }

    return () => {
      cancelled = true
      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }, [enabled, hiddenPollMs, pollMs])

  return { proofs, loading }
}
