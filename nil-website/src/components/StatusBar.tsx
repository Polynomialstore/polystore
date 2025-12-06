import { useEffect, useState } from 'react'
import { fetchStatus, ServiceStatus } from '../lib/status'
import { appConfig } from '../config'
import { useAccount, useChainId } from 'wagmi'

function Badge({ label, status }: { label: string; status: ServiceStatus }) {
  const colors =
    status === 'ok'
      ? 'bg-green-500/10 text-green-300 border-green-500/30'
      : status === 'warn'
      ? 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30'
      : 'bg-red-500/10 text-red-300 border-red-500/30'
  return (
    <span className={`px-2 py-1 text-xs rounded border ${colors} font-medium`}>
      {label}
    </span>
  )
}

export function StatusBar() {
  const chainId = useChainId()
  const { isConnected } = useAccount()
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

  return (
    <div className="flex flex-wrap gap-2 items-center bg-slate-900/50 border border-slate-800 rounded-lg px-4 py-2 text-xs text-slate-200">
      <Badge label={`LCD`} status={summary.lcd} />
      <Badge label={`EVM`} status={summary.evm} />
      <Badge label={`Faucet`} status={summary.faucet} />
      <Badge label={`Chain ID`} status={summary.chainIdMatch} />
      {walletBadge}
      {height && <span className="text-slate-400">Height: {height}</span>}
      {chainName && <span className="text-slate-500">LCD Chain: {chainName}</span>}
      {evmChainId !== undefined && (
        <span className="text-slate-500">EVM Chain: {evmChainId}</span>
      )}
    </div>
  )
}
