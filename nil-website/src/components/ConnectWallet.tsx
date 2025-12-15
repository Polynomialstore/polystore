import { useMemo, useState } from 'react'
import { useAccount, useBalance, useChainId, useConnect, useDisconnect } from 'wagmi'
import { Wallet, LogOut, RefreshCw, AlertTriangle } from 'lucide-react'
import { appConfig } from '../config'
import { injectedConnector } from '../lib/web3Config'
import { useNetwork } from '../hooks/useNetwork'
import { formatUnits } from 'viem'

export function ConnectWallet({ className = '' }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connectAsync, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchNetwork } = useNetwork()
  const [error, setError] = useState<string | null>(null)

  const { data: balance } = useBalance({
    address,
    chainId: appConfig.chainId,
    query: { enabled: Boolean(address) },
  })

  const isWrongNetwork = isConnected && chainId !== appConfig.chainId

  const shortAddress = useMemo(() => {
    if (!address) return ''
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }, [address])

  const shortBalance = useMemo(() => {
    if (!balance) return '—'
    const formatted = formatUnits(balance.value, balance.decimals)
    const [whole, frac] = formatted.split('.')
    const trimmed = frac ? `${whole}.${frac.slice(0, 4)}` : whole
    return `${trimmed} ${balance.symbol || 'NIL'}`
  }, [balance])

  const handleConnect = async () => {
    setError(null)
    try {
      // Attempt to auto-add + switch the chain (best-effort).
      await switchNetwork().catch(() => undefined)
      await connectAsync({ connector: injectedConnector })
      await switchNetwork().catch(() => undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e) || 'Failed to connect wallet')
    }
  }

  const handleSwitchNetwork = async () => {
    setError(null)
    try {
      await switchNetwork()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e) || 'Failed to switch network')
    }
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {!isConnected ? (
        <button
          onClick={handleConnect}
          disabled={isConnecting}
          data-testid="connect-wallet"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary/50 hover:bg-secondary border border-transparent hover:border-border text-foreground text-sm font-semibold transition-colors disabled:opacity-60"
        >
          {isConnecting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
          Connect Wallet
        </button>
      ) : (
        <>
          <div className="flex items-center gap-3 px-4 py-2 rounded-full bg-secondary/40 border border-border/40">
            <span className="font-mono text-xs text-foreground" data-testid="wallet-address">
              {shortAddress}
            </span>
            <span className={`text-xs ${isWrongNetwork ? 'text-yellow-600 dark:text-yellow-300' : 'text-muted-foreground'}`}>
              {isWrongNetwork ? `Wrong chain (${chainId})` : shortBalance}
            </span>
          </div>

          {isWrongNetwork && (
            <button
              onClick={handleSwitchNetwork}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20 text-yellow-700 dark:text-yellow-200 text-sm font-semibold transition-colors"
            >
              <AlertTriangle className="w-4 h-4" />
              Switch
            </button>
          )}

          <button
            onClick={() => disconnect()}
            className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-secondary/50 hover:bg-secondary border border-transparent hover:border-border text-muted-foreground hover:text-foreground transition-colors"
            title="Disconnect"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </>
      )}

      {error && (
        <span className="hidden lg:inline text-xs text-destructive max-w-[260px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
