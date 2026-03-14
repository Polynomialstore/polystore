import { useAccount } from 'wagmi'
import { useFaucet } from '../hooks/useFaucet'
import { Coins, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useState } from 'react'
import { useMetaMaskUnlockState } from '../hooks/useMetaMaskUnlockState'
import { appConfig } from '../config'
import { useConnectModal } from '@rainbow-me/rainbowkit'

export function FaucetWidget({ className = "" }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { requestFunds, loading } = useFaucet()
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [unlocking, setUnlocking] = useState(false)
  const unlockState = useMetaMaskUnlockState({ enabled: isConnected, pollMs: 15_000 })
  const isLocked = isConnected && unlockState === 'locked'

  if (!appConfig.faucetEnabled) {
    return null
  }

  const handleUnlock = async () => {
    setUnlocking(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ethereum = (window as any).ethereum as { request?: (args: { method: string }) => Promise<unknown> } | undefined
      if (!ethereum || typeof ethereum.request !== 'function') return
      await ethereum.request({ method: 'eth_requestAccounts' })
    } finally {
      setUnlocking(false)
    }
  }

  const handleRequest = async () => {
    if (!address) return
    setStatus('idle')
    try {
        await requestFunds(address)
        setStatus('success')
        setTimeout(() => setStatus('idle'), 5000)
    } catch (e) {
        setStatus('error')
        setTimeout(() => setStatus('idle'), 5000)
    }
  }

  if (!isConnected || isLocked) {
    return (
        <button
            onClick={() => (isLocked ? handleUnlock() : openConnectModal?.())}
            disabled={unlocking}
            className={`inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.22)] dark:drop-shadow-[0_0_8px_hsl(var(--primary)_/_0.30)] hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-60 ${className}`}
        >
            {unlocking ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
            {isLocked ? 'Unlock to Request Funds' : 'Connect to Request Funds'}
        </button>
    )
  }

  return (
    <div className="flex items-center gap-3">
        <button 
            onClick={handleRequest}
            disabled={loading || status === 'success'}
            className={`inline-flex items-center gap-2 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data transition-all disabled:opacity-70 disabled:cursor-not-allowed border ${
                status === 'success' 
                ? 'bg-success/10 text-success border-success/40 dark:shadow-[0_0_24px_hsl(var(--success)_/_0.18)]' 
                : status === 'error'
                ? 'bg-destructive/10 text-destructive border-destructive/40 dark:shadow-[0_0_24px_hsl(var(--destructive)_/_0.16)]'
                : 'bg-primary/10 text-primary hover:bg-primary/20 border-primary/30 dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.16)]'
            } ${className}`}
        >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : 
             status === 'success' ? <CheckCircle2 className="w-4 h-4" /> :
             status === 'error' ? <AlertCircle className="w-4 h-4" /> :
             <Coins className="w-4 h-4" />
            }
            {loading ? 'Requesting...' : 
             status === 'success' ? 'Sent!' : 
             status === 'error' ? 'Failed' :
             'Get 10 NIL'
            }
        </button>
    </div>
  )
}
