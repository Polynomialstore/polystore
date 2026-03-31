import { Coins, RefreshCw } from 'lucide-react'

import { ConnectWallet } from './ConnectWallet'
import { useSessionStatus } from '../hooks/useSessionStatus'
import { cn } from '../lib/utils'

const SESSION_BADGE_STYLES: Record<string, string> = {
  disconnected: 'border-border/30 bg-background/70 text-muted-foreground',
  'needs-reconnect': 'border-primary/30 bg-primary/10 text-primary',
  'wrong-network': 'border-destructive/30 bg-destructive/10 text-destructive',
  'needs-funds': 'border-primary/30 bg-primary/10 text-primary',
  'ready-browser': 'border-success/30 bg-success/10 text-success',
  'ready-gateway': 'border-success/30 bg-success/10 text-success',
}

const SESSION_BADGE_LABELS: Record<string, string> = {
  disconnected: 'Connect Wallet',
  'needs-reconnect': 'Reconnect',
  'wrong-network': 'Wrong Network',
  'needs-funds': 'Needs Funds',
  'ready-browser': 'Ready',
  'ready-gateway': 'Gateway Ready',
}

export function NavSessionStatus({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const session = useSessionStatus()
  const stakeBalanceLabel = session.lcdStakeBalance ? `${session.lcdStakeBalance} stake` : '—'

  const shouldShowFaucet = session.faucetEnabled && session.isConnected

  return (
    <div className={cn('flex items-center gap-2', compact && 'gap-1.5', className)}>
      <ConnectWallet compact={compact} />
      {session.isConnected ? (
        <div className="sr-only" aria-hidden="true">
          <span data-testid="cosmos-identity">{session.nilAddress}</span>
          <span data-testid="cosmos-stake-balance">{stakeBalanceLabel}</span>
        </div>
      ) : null}

      {session.isConnected &&
      session.primarySessionState !== 'ready-browser' &&
      session.primarySessionState !== 'ready-gateway' ? (
        <>
          <span
            className={cn(
              'hidden 2xl:inline-flex items-center border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data',
              SESSION_BADGE_STYLES[session.primarySessionState],
            )}
          >
            {SESSION_BADGE_LABELS[session.primarySessionState]}
          </span>
        </>
      ) : null}

      {shouldShowFaucet ? (
        <button
          type="button"
          onClick={() => void session.requestFunds()}
          data-testid="faucet-request"
          disabled={!session.address || session.faucetBusy}
          className={cn(
            'inline-flex items-center gap-2 border font-bold uppercase tracking-[0.2em] font-mono-data transition-colors disabled:opacity-60',
            compact ? 'px-2.5 py-2 text-[9px]' : 'px-3 py-2 text-[10px]',
            session.faucetTxStatus === 'confirmed'
              ? 'border-success/30 bg-success/10 text-success'
              : session.faucetTxStatus === 'failed'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15',
          )}
        >
          {session.faucetBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Coins className="h-3.5 w-3.5" />}
          {session.faucetBusy
            ? 'Pending'
            : session.faucetTxStatus === 'confirmed'
              ? 'Funded'
            : session.faucetTxStatus === 'failed'
                ? compact
                  ? 'Retry'
                  : 'Retry Faucet'
                : session.primarySessionState === 'needs-funds'
                  ? 'Get NIL'
                  : compact
                    ? 'Top Up'
                    : 'Top Up NIL'}
        </button>
      ) : null}
    </div>
  )
}
