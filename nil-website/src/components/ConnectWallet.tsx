import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useEffect, useRef, useState } from 'react'
import { useDisconnect } from 'wagmi'
import { AlertTriangle, CircleUserRound, Copy, LogOut, Wallet, X } from 'lucide-react'
import { appConfig } from '../config'
import { useNetwork } from '../hooks/useNetwork'

export function ConnectWallet({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { switchNetwork } = useNetwork()
  const { disconnect } = useDisconnect()
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!accountMenuOpen) return

    function handlePointerDown(event: MouseEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setAccountMenuOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [accountMenuOpen])

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openChainModal,
        openConnectModal,
      }) => {
        const ready = mounted && authenticationStatus !== 'loading'
        const connected =
          ready &&
          Boolean(account) &&
          Boolean(chain) &&
          (!authenticationStatus || authenticationStatus === 'authenticated')
        const wrongNetwork = Boolean(chain && (chain.unsupported || chain.id !== appConfig.chainId))

        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              data-testid="connect-wallet"
              className={`inline-flex items-center gap-2 border border-transparent bg-secondary/50 text-foreground font-semibold transition-colors hover:border-border hover:bg-secondary ${
                compact ? 'px-3 py-2 text-[11px] uppercase tracking-[0.18em] font-mono-data' : 'px-4 py-2 text-sm'
              } ${className}`}
            >
              <Wallet className="w-4 h-4" />
              {compact ? 'Connect' : 'Connect Wallet'}
            </button>
          )
        }

        const currentAccount = account!
        const rawLabel = currentAccount.address || currentAccount.displayName
        const accountLabel =
          rawLabel.length > 12 ? `${rawLabel.slice(0, 6)}...${rawLabel.slice(-4)}` : rawLabel
        const handleCopyAddress = async () => {
          if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
          await navigator.clipboard.writeText(currentAccount.address)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }

        return (
          <div ref={accountMenuRef} className={`relative flex items-center gap-2 ${className}`}>
            <button
              type="button"
              onClick={() => setAccountMenuOpen((open) => !open)}
              data-testid="wallet-address"
              className={`inline-flex items-center gap-2 border border-primary/30 bg-primary/10 text-primary transition-colors hover:bg-primary/15 ${
                compact ? 'max-w-[9.75rem] px-2.5 py-2' : 'px-3 py-2'
              }`}
              title={currentAccount.address}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary">
                <CircleUserRound className="h-3.5 w-3.5" />
              </span>
              <span className={`font-mono-data font-bold text-primary ${compact ? 'max-w-[6.75rem] truncate text-[11px]' : 'text-xs'}`}>
                {accountLabel}
              </span>
              <span className="sr-only" data-testid="wallet-address-full">{currentAccount.address}</span>
            </button>

            {accountMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 w-64 glass-panel industrial-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                      <CircleUserRound className="h-7 w-7" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono-data text-sm font-bold text-foreground">{accountLabel}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground break-all">{currentAccount.address}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAccountMenuOpen(false)}
                    className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Close account menu"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyAddress()}
                    className="inline-flex items-center justify-center gap-2 border border-primary/20 bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                  >
                    <Copy className="h-4 w-4" />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAccountMenuOpen(false)
                      disconnect()
                    }}
                    className="inline-flex items-center justify-center gap-2 border border-primary/20 bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                  >
                    <LogOut className="h-4 w-4" />
                    Disconnect
                  </button>
                </div>
              </div>
            )}

            {wrongNetwork && (
              <button
                onClick={() => {
                  if (openChainModal) {
                    openChainModal()
                  } else {
                    void switchNetwork()
                  }
                }}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-none bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary text-sm font-semibold transition-colors"
              >
                <AlertTriangle className="w-4 h-4" />
                Switch
              </button>
            )}
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
