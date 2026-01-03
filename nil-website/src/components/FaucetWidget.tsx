import { useAccount } from 'wagmi'
import { useFaucet } from '../hooks/useFaucet'
import { Coins, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useState } from 'react'
import { useConnect } from 'wagmi'
import { injectedConnector } from '../lib/web3Config'
import { useMetaMaskUnlockState } from '../hooks/useMetaMaskUnlockState'

export function FaucetWidget({ className = "" }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { requestFunds, loading } = useFaucet()
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [unlocking, setUnlocking] = useState(false)
  const unlockState = useMetaMaskUnlockState({ enabled: isConnected, pollMs: 1500 })
  const isLocked = isConnected && unlockState === 'locked'

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
            onClick={() => (isLocked ? handleUnlock() : connect({ connector: injectedConnector }))}
            disabled={unlocking}
            className={`flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md font-medium transition-colors shadow-lg shadow-indigo-900/20 ${className}`}
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
            className={`flex items-center gap-2 px-4 py-2 font-medium rounded-md transition-all shadow-lg disabled:opacity-70 disabled:cursor-not-allowed ${
                status === 'success' 
                ? 'bg-green-500/20 text-green-400 border border-green-500/30' 
                : status === 'error'
                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                : 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border border-yellow-500/20'
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
