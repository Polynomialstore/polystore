import { useEffect, useState } from 'react'

type MetaMaskUnlockState = 'unavailable' | 'unknown' | 'locked' | 'unlocked'

type EthereumProvider = {
  isMetaMask?: boolean
  request?: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>
  _metamask?: {
    isUnlocked?: () => Promise<boolean>
  }
}

function getEthereum(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eth = (window as any).ethereum as EthereumProvider | undefined
  return eth ?? null
}

async function queryMetaMaskUnlockState(eth: EthereumProvider | null): Promise<MetaMaskUnlockState> {
  if (!eth || typeof eth.request !== 'function') return 'unavailable'
  if (!eth.isMetaMask) return 'unavailable'
  const fn = eth._metamask?.isUnlocked
  if (typeof fn !== 'function') return 'unknown'
  try {
    const unlocked = await fn()
    return unlocked ? 'unlocked' : 'locked'
  } catch {
    return 'unknown'
  }
}

export function useMetaMaskUnlockState(options?: { enabled?: boolean; pollMs?: number }) {
  const enabled = options?.enabled ?? true
  const pollMs = options?.pollMs ?? 1500
  const [state, setState] = useState<MetaMaskUnlockState>('unknown')

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let timer: number | undefined

    async function refresh() {
      const eth = getEthereum()
      const next = await queryMetaMaskUnlockState(eth)
      if (!cancelled) setState(next)
    }

    refresh()
    if (pollMs > 0) {
      timer = window.setInterval(refresh, pollMs)
    }

    const handleFocus = () => refresh()
    const handleVis = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVis)

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVis)
    }
  }, [enabled, pollMs])

  return state
}

