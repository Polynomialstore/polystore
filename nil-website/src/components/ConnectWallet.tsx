import { ConnectButton } from '@rainbow-me/rainbowkit'
import { AlertTriangle, Wallet } from 'lucide-react'
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
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary/50 hover:bg-secondary border border-transparent hover:border-border text-foreground text-sm font-semibold transition-colors ${className}`}
            >
              <Wallet className="w-4 h-4" />
              Connect Wallet
            </button>
          )
        }

        const currentAccount = account!

        return (
          <div className={`flex items-center gap-2 ${className}`}>
            <button
              onClick={openAccountModal}
              className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-secondary/40 border border-border/40"
              title={currentAccount.address}
            >
              <span className="font-mono text-xs text-foreground">{currentAccount.displayName}</span>
              <span className="text-xs text-muted-foreground">{currentAccount.displayBalance ?? '—'}</span>
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
                className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20 text-yellow-700 dark:text-yellow-200 text-sm font-semibold transition-colors"
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
