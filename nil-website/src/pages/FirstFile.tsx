import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useBalance, useChainId } from 'wagmi'
import { formatUnits, numberToHex } from 'viem'
import { AlertCircle, CheckCircle2, Coins, HardDrive, Rocket } from 'lucide-react'

import { appConfig } from '../config'
import { ConnectWallet } from '../components/ConnectWallet'
import { DashboardCta } from '../components/DashboardCta'
import { FaucetAuthTokenInput } from '../components/FaucetAuthTokenInput'
import { lcdFetchDeals } from '../api/lcdClient'
import { useNetwork } from '../hooks/useNetwork'
import { useFaucet } from '../hooks/useFaucet'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { ethToNil } from '../lib/address'
import { buildServiceHint } from '../lib/serviceHint'
import { classifyWalletError } from '../lib/walletErrors'
import { useWalletNetworkGuard } from '../hooks/useWalletNetworkGuard'

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
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchNetwork } = useNetwork()
  const { requestFunds, loading: faucetLoading, lastTx: faucetTx, txStatus: faucetTxStatus } = useFaucet()
  const { submitDeal, loading: dealLoading } = useCreateDeal()
  const {
    walletChainId,
    isWrongNetwork: walletIsWrongNetwork,
    genesisMismatch,
    accountPermissionMismatch,
    refresh: refreshWalletNetwork,
  } = useWalletNetworkGuard({ enabled: isConnected, pollMs: 15_000 })

  const [duration, setDuration] = useState('31536000')
  const [durationPreset, setDurationPreset] = useState('1y')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')

  const [dealId, setDealId] = useState<string | null>(null)
  const [hasExistingDeal, setHasExistingDeal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const autoSwitchKeyRef = useRef<string | null>(null)

  const activeChainId = walletChainId ?? chainId
  const isWrongNetwork = isConnected && walletIsWrongNetwork
  const nilAddress = useMemo(() => {
    if (!address) return ''
    return address.startsWith('0x') ? ethToNil(address) : address
  }, [address])

  useEffect(() => {
    setDealId(null)
    setHasExistingDeal(false)
  }, [address])

  const { data: balance, refetch: refetchBalance } = useBalance({
    address,
    chainId: appConfig.chainId,
    query: { enabled: Boolean(address) },
  })

  const hasBalance = useMemo(() => {
    try {
      return Boolean(balance?.value && BigInt(balance.value) > 0n)
    } catch {
      return Boolean(balance?.value)
    }
  }, [balance?.value])

  const balanceLabel = useMemo(() => {
    if (!balance) return '—'
    const formatted = formatUnits(balance.value, balance.decimals)
    const [whole, frac] = formatted.split('.')
    const trimmed = frac ? `${whole}.${frac.slice(0, 4)}` : whole
    return `${trimmed} ${balance.symbol || 'NIL'}`
  }, [balance])

  useEffect(() => {
    // After faucet confirms, wagmi balance can lag; poll briefly so the UI unlocks without a refresh.
    if (hasBalance) return
    if (faucetTxStatus !== 'pending' && faucetTxStatus !== 'confirmed') return

    let canceled = false
    let ticks = 0
    const tick = async () => {
      if (canceled) return
      ticks += 1
      try {
        await refetchBalance()
      } catch {
        // best-effort
      }
      if (canceled) return
      if (ticks >= 12) return // ~18s
      setTimeout(() => void tick(), 1500)
    }
    void tick()

    return () => {
      canceled = true
    }
  }, [faucetTxStatus, hasBalance, refetchBalance])

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
  const funded = hasBalance || faucetTxStatus === 'confirmed'
  const step2Complete = funded
  const step3Ready = step2Ready && (funded || hasExistingDeal)
  const step3Complete = Boolean(dealId)
  const step4Ready = step3Ready && Boolean(dealId)

  const stepSectionClass = (active: boolean) =>
    [
      "glass-panel industrial-border border border-border p-6 space-y-4 transition-all duration-200",
      active ? "bg-card opacity-100" : "bg-card opacity-45 saturate-50 pointer-events-none select-none",
    ].join(" ")

  const stepBadgeClass = (active: boolean) =>
    [
      "w-10 h-10 rounded-none flex items-center justify-center font-bold transition-colors",
      active ? "bg-secondary/40 text-foreground" : "bg-muted/40 text-muted-foreground",
    ].join(" ")

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

  const handleRequestFunds = async () => {
    setError(null)
    setNotice(null)
    try {
      await requestFunds(address)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e) || 'Faucet request failed')
    }
  }

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
      <div className="glass-panel industrial-border border border-border p-6">
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
        <div className="rounded-none border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive flex items-start gap-3">
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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <ConnectWallet />
          {isWrongNetwork && (
            <button
              type="button"
              onClick={() => void switchNetwork({ forceAdd: genesisMismatch })}
              className="inline-flex items-center justify-center rounded-none bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-bold text-primary-foreground transition-colors"
            >
              {genesisMismatch ? 'Repair MetaMask network' : `Switch to ${numberToHex(appConfig.chainId)}`}
            </button>
          )}
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
          {hasBalance && <CheckCircle2 className="w-5 h-5 text-accent" />}
        </div>
        {!appConfig.faucetEnabled ? (
          <div className="text-sm text-muted-foreground">
            Faucet is disabled in this build. Fund your wallet externally, then continue.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <button
                type="button"
                onClick={() => void handleRequestFunds()}
                disabled={!isConnected || faucetLoading || step2Complete}
                className={
                  step2Complete
                    ? "inline-flex items-center gap-2 rounded-none border border-border bg-muted/60 px-4 py-2 text-sm font-semibold text-muted-foreground cursor-not-allowed"
                    : "inline-flex items-center gap-2 rounded-none bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-bold text-primary-foreground transition-colors disabled:opacity-60"
                }
              >
                <Coins className="w-4 h-4" />
                {faucetLoading ? 'Requesting…' : 'Request faucet funds'}
              </button>
              <div className="text-xs text-muted-foreground">
                {faucetTx ? (
                  <span className="font-mono">Faucet tx: {faucetTx.slice(0, 10)}… ({faucetTxStatus})</span>
                ) : (
                  <span>Balance: {balanceLabel}</span>
                )}
              </div>
            </div>
            <FaucetAuthTokenInput />
          </div>
        )}
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

        <DashboardCta className="inline-flex" label="Dashboard" to="/dashboard" />
      </section>
    </div>
  )
}
