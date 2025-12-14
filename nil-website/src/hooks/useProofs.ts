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

function parseCommitment(commitment: string): Pick<ProofRow, 'dealId' | 'epochId' | 'tier'> {
  try {
    // Expected shape: "deal:<id>/epoch:<epoch>/tier:<tier>"
    const parts = commitment.split('/')
    const out: { dealId?: string; epochId?: string; tier?: string } = {}
    for (const part of parts) {
      const [k, v] = part.split(':')
      if (!k || v === undefined) continue
      const key = k.trim().toLowerCase()
      const val = v.trim()
      if (key === 'deal') out.dealId = val
      else if (key === 'epoch') out.epochId = val
      else if (key === 'tier') out.tier = val
    }
    return out
  } catch {
    return {}
  }
}

export function useProofs(pollMs: number = 10000) {
  const [proofs, setProofs] = useState<ProofRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function load() {
      if (cancelled) return
      setLoading(true)
      try {
        // This endpoint is paginated; without an explicit limit most LCDs default
        // to a small page size which hides additional retrieval proofs (e.g. when
        // a full-file download is chunked into many blob-sized receipts).
        const url = `${appConfig.lcdBase}/nilchain/nilchain/v1/proofs?pagination.limit=1000&pagination.reverse=true`
        const res = await fetch(url)
        if (!res.ok) return
        const json = await res.json()
        const arr = Array.isArray(json.proof) ? json.proof : []
        const mapped: ProofRow[] = arr.map((p: any) => {
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
        if (!cancelled) setLoading(false)
      }
    }
    ;(async () => {
      await load()
      if (pollMs > 0) {
        timer = window.setInterval(load, pollMs)
      }
    })()

    return () => {
      cancelled = true
      if (timer !== undefined) {
        window.clearInterval(timer)
      }
    }
  }, [pollMs])

  return { proofs, loading }
}
