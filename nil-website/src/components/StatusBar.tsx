import { useEffect, useState } from 'react'
import { fetchStatus, ServiceStatus } from '../lib/status'
import { appConfig } from '../config'
import { useAccount, useChainId } from 'wagmi'
import { useTransportContext } from '../context/TransportContext'

function Badge({ label, status }: { label: string; status: ServiceStatus }) {
  const colors =
    status === 'ok'
      ? 'bg-green-500/10 text-green-600 dark:text-green-300 border-green-500/30'
      : status === 'warn'
      ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-300 border-yellow-500/30'
      : 'bg-destructive/10 text-destructive border-destructive/30'
  const text =
    status === 'ok'
      ? 'OK'
      : status === 'warn'
      ? 'WARN'
      : 'ERROR'
  return (
    <span className={`px-2 py-1 text-xs rounded border ${colors} font-medium`}>
      {label}: {text}
    </span>
  )
}

export function StatusBar() {
  const chainId = useChainId()
  const { isConnected } = useAccount()
  const { preference, setPreference, lastTrace } = useTransportContext()
  const [height, setHeight] = useState<number | undefined>(undefined)
  const [chainName, setChainName] = useState<string | undefined>(undefined)
  const [summary, setSummary] = useState({
    lcd: 'warn' as ServiceStatus,
    evm: 'warn' as ServiceStatus,
    faucet: 'warn' as ServiceStatus,
    chainIdMatch: 'warn' as ServiceStatus,
  })
  const [evmChainId, setEvmChainId] = useState<number | undefined>(undefined)

  useEffect(() => {
    fetchStatus(appConfig.chainId).then((res) => {
      setSummary({
        lcd: res.lcd,
        evm: res.evm,
        faucet: res.faucet,
        chainIdMatch: res.chainIdMatch,
      })
      setHeight(res.height)
      setChainName(res.networkName)
      setEvmChainId(res.evmChainId)
    })
  }, [])

  const walletBadge =
    isConnected && chainId
      ? chainId === appConfig.chainId
        ? <Badge label="Wallet: Connected (match)" status="ok" />
        : <Badge label={`Wallet chain ${chainId}`} status="error" />
      : <Badge label="Wallet: Not connected" status="warn" />

  const lastRoute = lastTrace?.chosen?.backend ? lastTrace.chosen.backend.replace('_', ' ') : '—'
  const lastFailure = lastTrace?.attempts.find((a) => !a.ok)
  const lastReason = lastFailure?.errorMessage ? ` (${lastFailure.errorMessage})` : ''

  return (
    <div className="flex flex-wrap gap-2 items-center bg-muted/50 border border-border rounded-lg px-4 py-2 text-xs text-muted-foreground shadow-sm">
      <Badge label={`LCD`} status={summary.lcd} />
      <Badge label={`EVM`} status={summary.evm} />
      <Badge label={`Faucet`} status={summary.faucet} />
      <Badge label={`Chain ID`} status={summary.chainIdMatch} />
      {walletBadge}
      {height && <span className="opacity-75">Height: {height}</span>}
      {chainName && <span className="opacity-75">LCD Chain: {chainName}</span>}
      {evmChainId !== undefined && (
        <span className="opacity-75">EVM Chain: {evmChainId}</span>
      )}
      <span className="opacity-75">Route: {lastRoute}{lastReason}</span>
      <label className="flex items-center gap-2">
        <span className="opacity-75">Preference</span>
        <select
          value={preference}
          onChange={(e) => setPreference(e.target.value as typeof preference)}
          className="bg-background border border-border rounded px-2 py-1 text-xs"
        >
          <option value="auto">Auto</option>
          <option value="prefer_gateway">Prefer gateway</option>
          <option value="prefer_direct_sp">Prefer direct SP</option>
        </select>
      </label>
    </div>
  )
}
