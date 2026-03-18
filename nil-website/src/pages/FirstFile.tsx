import { useEffect, useRef, useState } from 'react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { numberToHex } from 'viem'
import { AlertCircle, CheckCircle2, Coins, HardDrive, RefreshCw, Rocket } from 'lucide-react'

import { appConfig } from '../config'
import { DashboardCta } from '../components/DashboardCta'
import { FaucetAuthTokenInput } from '../components/FaucetAuthTokenInput'
import { lcdFetchDeals } from '../api/lcdClient'
import { useNetwork } from '../hooks/useNetwork'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { buildServiceHint } from '../lib/serviceHint'
import { classifyWalletError } from '../lib/walletErrors'
import { useSessionStatus } from '../hooks/useSessionStatus'

const DURATION_PRESETS = [
  { value: '1d', label: '1 day', seconds: 24 * 60 * 60 },
  { value: '1w', label: '1 week', seconds: 7 * 24 * 60 * 60 },
  { value: '1m', label: '1 month', seconds: 30 * 24 * 60 * 60 },
  { value: '3m', label: '3 months', seconds: 90 * 24 * 60 * 60 },
  { value: '6m', label: '6 months', seconds: 182 * 24 * 60 * 60 },
  { value: '1y', label: '1 year', seconds: 365 * 24 * 60 * 60 },
  { value: '2y', label: '2 years', seconds: 2 * 365 * 24 * 60 * 60 },
  { value: 'custom', label: 'Custom' },
] as const

const DURATION_PRESET_BY_SECONDS = Object.fromEntries(
  DURATION_PRESETS.filter((preset) => preset.value !== 'custom').map((preset) => [preset.value, preset.seconds]),
)

export function FirstFile() {
  const { openConnectModal } = useConnectModal()
  const { switchNetwork } = useNetwork()
  const { submitDeal, loading: dealLoading } = useCreateDeal()
  const session = useSessionStatus()
  const {
    address,
    isConnected,
    nilAddress,
    hasFunds,
    balanceLabel,
    isWrongNetwork,
    walletChainId,
    genesisMismatch,
    accountPermissionMismatch,
    refreshWalletNetwork,
    faucetEnabled,
    faucetBusy,
    faucetTx,
    faucetTxStatus,
    requestFunds,
  } = session

  const [duration, setDuration] = useState('31536000')
  const [durationPreset, setDurationPreset] = useState('1y')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')

  const [dealId, setDealId] = useState<string | null>(null)
  const [hasExistingDeal, setHasExistingDeal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const autoSwitchKeyRef = useRef<string | null>(null)

  const activeChainId = walletChainId

  useEffect(() => {
    setDealId(null)
    setHasExistingDeal(false)
  }, [address])

  useEffect(() => {
    if (!nilAddress) return
    let canceled = false
    const owner = nilAddress

    void lcdFetchDeals(appConfig.lcdBase)
      .then((all) => {
        if (canceled) return
        const owned = all.filter((deal) => deal.owner === owner)
        const found = owned.length > 0
        setHasExistingDeal(found)
        if (!dealId && found) {
          const id = String(owned[0]?.id ?? '').trim()
          if (id) setDealId(id)
        }
      })
      .catch(() => {
        if (canceled) return
        setHasExistingDeal(false)
      })

    return () => {
      canceled = true
    }
  }, [dealId, nilAddress])

  const step2Ready = isConnected && !isWrongNetwork
  const funded = hasFunds || faucetTxStatus === 'confirmed'
  const step3Ready = step2Ready && (funded || hasExistingDeal)
  const step3Complete = Boolean(dealId)
  const step4Ready = step3Ready && Boolean(dealId)

  const stepSectionClass = (active: boolean) =>
    [
      "glass-panel industrial-border p-6 space-y-4 transition-all duration-200",
      active ? "bg-card opacity-100" : "bg-card opacity-45 saturate-50 pointer-events-none select-none",
    ].join(" ")

  const stepBadgeClass = (active: boolean) =>
    [
      "w-10 h-10 rounded-none flex items-center justify-center font-bold transition-colors",
      active ? "bg-secondary/40 text-foreground" : "bg-muted/40 text-muted-foreground",
    ].join(" ")

  const stepBodyClass = "p-5"

  useEffect(() => {
    if (!accountPermissionMismatch) return
    setError('MetaMask account changed. Reconnect wallet and approve access for the active account.')
  }, [accountPermissionMismatch])

  useEffect(() => {
    if (!isConnected || !isWrongNetwork) {
      autoSwitchKeyRef.current = null
      return
    }
    const mismatchKind = genesisMismatch ? 'genesis' : 'chain'
    const key = `${String(activeChainId ?? 'unknown')}:${mismatchKind}`
    if (autoSwitchKeyRef.current === key) return
    autoSwitchKeyRef.current = key
    void switchNetwork({ forceAdd: genesisMismatch })
      .then(() => refreshWalletNetwork())
      .catch(() => undefined)
  }, [
    activeChainId,
    genesisMismatch,
    isConnected,
    isWrongNetwork,
    refreshWalletNetwork,
    switchNetwork,
  ])

  const handleCreateDeal = async () => {
    setError(null)
    setNotice(null)
    if (!address) {
      setError('Connect wallet first')
      return
    }
    if (!address.startsWith('0x')) {
      setError('EVM 0x address required')
      return
    }
    if (accountPermissionMismatch) {
      setError('MetaMask account changed. Reconnect wallet before creating a deal.')
      return
    }
    if (isWrongNetwork) {
      setError(
        genesisMismatch
          ? `Wrong network identity for chainId ${activeChainId}. Repair MetaMask network settings and retry.`
          : `Wrong network (wallet chainId=${activeChainId}). Switch to ${appConfig.chainId}.`,
      )
      return
    }
    try {
      const res = await submitDeal({
        creator: address,
        durationSeconds: Number(duration),
        initialEscrow,
        maxMonthlySpend,
        serviceHint: buildServiceHint('General', {}),
      })
      setDealId(String(res.deal_id))
    } catch (e) {
      const walletError = classifyWalletError(e, 'Create deal failed')
      setError(walletError.message)
    }
  }

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-5xl space-y-6">
      <div className="glass-panel industrial-border p-6">
        <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold text-foreground flex items-center gap-3">
            <Rocket className="w-8 h-8 text-primary" />
            First File Wizard
          </h1>
          <p className="mt-3 text-muted-foreground">
            Guided flow to store and retrieve a file on the devnet. Keep the file ≤128&nbsp;KiB for a full download in this wizard.
          </p>
        </div>
        </div>
      </div>

      {error && (
        <div className="rounded-none border border-destructive/40 bg-card p-4 text-sm text-destructive flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold">Action required</div>
            <div className="mt-1 text-destructive/90 break-words">{error}</div>
          </div>
        </div>
      )}

      {notice && (
        <div className="rounded-none border border-primary/30 bg-primary/10 p-4 text-sm text-primary flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold">Note</div>
            <div className="mt-1 break-words">{notice}</div>
          </div>
        </div>
      )}

    <section className={stepSectionClass(true)}>
      <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={stepBadgeClass(true)}>
              1
            </div>
            <div>
              <div className="font-semibold text-foreground">Connect &amp; switch network</div>
              <div className="text-xs text-muted-foreground">Chain ID {appConfig.chainId}</div>
            </div>
          </div>
          {isConnected && !isWrongNetwork && <CheckCircle2 className="w-5 h-5 text-accent" />}
        </div>
        <div className={stepBodyClass}>
          <div className="nil-inset p-4 text-sm text-muted-foreground">
            {!isConnected ? (
              <button
                type="button"
                onClick={() => openConnectModal?.()}
                className="cta-shadow inline-flex items-center justify-center gap-3 border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
              >
                Connect Wallet
              </button>
            ) : isWrongNetwork ? (
              <span>
                Use the nav session controls to {genesisMismatch ? 'repair the NilStore network entry' : `switch to ${numberToHex(appConfig.chainId)}`}.
              </span>
            ) : (
              <span>Wallet is connected on NilStore Testnet. Continue once the nav shows the session as ready.</span>
            )}
          </div>
        </div>
      </section>

      <section className={stepSectionClass(step2Ready)}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={stepBadgeClass(step2Ready)}>
              2
            </div>
            <div>
              <div className="font-semibold text-foreground">Fund your wallet</div>
              <div className="text-xs text-muted-foreground">Gas is required for on-chain transactions.</div>
            </div>
          </div>
          {funded && <CheckCircle2 className="w-5 h-5 text-accent" />}
        </div>
        <div className={stepBodyClass}>
          {!faucetEnabled ? (
            <div className="text-sm text-muted-foreground">
              Faucet is disabled in this build. Fund your wallet externally, then continue.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="nil-inset p-4 text-sm text-muted-foreground">
                {funded ? (
                  <span>Wallet funded. Current balance: {balanceLabel}.</span>
                ) : !isConnected ? (
                  <span>Connect your wallet in the nav first, then use the nav faucet control to request funds.</span>
                ) : faucetTx ? (
                  <span className="font-mono">Faucet tx: {faucetTx.slice(0, 10)}… ({faucetTxStatus})</span>
                ) : (
                  <span>Request testnet NIL for this wallet, then continue once the balance updates.</span>
                )}
              </div>
              {!funded && isConnected ? (
                <button
                  type="button"
                  onClick={() => void requestFunds()}
                  disabled={!address || faucetBusy}
                  className="cta-shadow inline-flex items-center justify-center gap-3 border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {faucetBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Coins className="h-4 w-4" />}
                  {faucetBusy ? 'Funding' : 'Fund Wallet'}
                </button>
              ) : null}
              {!funded ? <FaucetAuthTokenInput /> : null}
            </div>
          )}
        </div>
      </section>

      <section className={stepSectionClass(step3Ready)}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={stepBadgeClass(step3Ready)}>
              3
            </div>
            <div>
              <div className="font-semibold text-foreground">Allocate a deal</div>
              <div className="text-xs text-muted-foreground">Creates a thin-provisioned container on-chain.</div>
            </div>
          </div>
          {dealId && <CheckCircle2 className="w-5 h-5 text-accent" />}
        </div>

        <div className={stepBodyClass}>
          <div className="hidden grid md:grid-cols-3 gap-3 text-sm">
            <label className="block">
              <div className="text-xs text-muted-foreground">Duration</div>
              <select
                value={durationPreset}
                onChange={(e) => {
                  const preset = e.target.value
                  setDurationPreset(preset)
                  const presetSeconds = DURATION_PRESET_BY_SECONDS[preset]
                  if (typeof presetSeconds === 'number') {
                    setDuration(String(presetSeconds))
                  }
                }}
                className="mt-1 w-full rounded-none border border-border bg-background px-3 py-2 text-sm"
              >
                {DURATION_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="text-xs text-muted-foreground">Duration (seconds)</div>
              <input
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                readOnly={durationPreset !== 'custom'}
                className="mt-1 w-full rounded-none border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <div className="text-xs text-muted-foreground">Initial escrow</div>
              <input
                value={initialEscrow}
                onChange={(e) => setInitialEscrow(e.target.value)}
                className="mt-1 w-full rounded-none border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <div className="text-xs text-muted-foreground">Max monthly spend</div>
              <input
                value={maxMonthlySpend}
                onChange={(e) => setMaxMonthlySpend(e.target.value)}
                className="mt-1 w-full rounded-none border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleCreateDeal()}
              disabled={!isConnected || isWrongNetwork || dealLoading || step3Complete}
              className={
                step3Complete
                  ? "inline-flex items-center gap-2 rounded-none border border-border bg-muted/60 px-4 py-2 text-sm font-semibold text-muted-foreground cursor-not-allowed"
                  : "inline-flex items-center gap-2 rounded-none bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-bold text-primary-foreground transition-colors disabled:opacity-60"
              }
            >
              <HardDrive className="w-4 h-4" />
              {dealLoading ? 'Creating…' : 'Create deal'}
            </button>
          </div>
        </div>
      </section>

      <section className={stepSectionClass(step4Ready)}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={stepBadgeClass(step4Ready)}>
              4
            </div>
            <div>
              <div className="font-semibold text-foreground">Upload a file in the dashboard</div>
              <div className="text-xs text-muted-foreground">Continue in the full dashboard upload surface.</div>
            </div>
          </div>
        </div>

        <div className={stepBodyClass}>
          <DashboardCta className="inline-flex" label="Dashboard" to="/dashboard" />
        </div>
      </section>
    </div>
  )
}
