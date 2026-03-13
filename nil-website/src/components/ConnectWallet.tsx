import { ConnectButton } from '@rainbow-me/rainbowkit'
import { AlertTriangle, CircleUserRound, Wallet } from 'lucide-react'
import { appConfig } from '../config'
import { useNetwork } from '../hooks/useNetwork'

export function ConnectWallet({ className = '' }: { className?: string }) {
  const { switchNetwork } = useNetwork()

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openAccountModal,
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
              className={`inline-flex items-center gap-2 px-4 py-2 bg-secondary/50 hover:bg-secondary border border-transparent hover:border-border text-foreground text-sm font-semibold transition-colors ${className}`}
            >
              <Wallet className="w-4 h-4" />
              Connect Wallet
            </button>
          )
        }

        const currentAccount = account!
        const rawLabel = currentAccount.address || currentAccount.displayName
        const accountLabel =
          rawLabel.length > 12 ? `${rawLabel.slice(0, 6)}...${rawLabel.slice(-4)}` : rawLabel

        return (
          <div className={`flex items-center gap-2 ${className}`}>
            <button
              onClick={openAccountModal}
              className="inline-flex items-center gap-2 border border-border/40 bg-background/80 px-3 py-2 text-foreground transition-colors hover:bg-secondary/40"
              title={currentAccount.address}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-accent/15 text-accent">
                <CircleUserRound className="h-3.5 w-3.5" />
              </span>
              <span className="font-mono-data text-xs font-bold text-foreground">{accountLabel}</span>
            </button>

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
