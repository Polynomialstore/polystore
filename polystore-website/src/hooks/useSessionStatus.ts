import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits } from 'viem'

import { ethToPolystoreAddress } from '../lib/address'
import { appConfig } from '../config'
import { useFaucet } from './useFaucet'
import { useLocalGateway } from './useLocalGateway'
import { useWalletNetworkGuard } from './useWalletNetworkGuard'

export type PrimarySessionState =
  | 'disconnected'
  | 'needs-reconnect'
  | 'wrong-network'
  | 'needs-funds'
  | 'ready-browser'
  | 'ready-gateway'

export type SessionGatewayMode = 'browser' | 'gateway'

export type UseSessionStatusOptions = {
  walletGuardPollMs?: number
  localGatewayPollMs?: number
  lcdBalancePollMs?: number
  includeGateway?: boolean
}

export type SessionStatus = {
  isConnected: boolean
  address: string | undefined
  polystoreAddress: string
  walletAddressShort: string
  balance: ReturnType<typeof useBalance>['data']
  balanceLabel: string
  lcdStakeBalance: string | null
  hasFunds: boolean
  isWrongNetwork: boolean
  walletChainId: number | null
  genesisMismatch: boolean
  accountPermissionMismatch: boolean
  needsReconnect: boolean
  refreshWalletNetwork: () => Promise<void>
  faucetEnabled: boolean
  faucetBusy: boolean
  faucetLoading: boolean
  faucetTx: string | null
  faucetTxStatus: 'idle' | 'pending' | 'confirmed' | 'failed'
  requestFunds: () => Promise<unknown>
  requestFundsFor: (targetAddress?: string) => Promise<unknown>
  gatewayMode: SessionGatewayMode
  gatewayConnected: boolean
  gatewayStatus: ReturnType<typeof useLocalGateway>['status']
  localGateway: ReturnType<typeof useLocalGateway>
  primarySessionState: PrimarySessionState
}

const SessionStatusContext = createContext<SessionStatus | null>(null)

function useSessionStatusValue(options?: UseSessionStatusOptions): SessionStatus {
  const { address, isConnected } = useAccount()
  const {
    walletChainId,
    isWrongNetwork,
    genesisMismatch,
    accountPermissionMismatch,
    refresh: refreshWalletNetwork,
  } = useWalletNetworkGuard({
    enabled: isConnected,
    pollMs: options?.walletGuardPollMs ?? 15_000,
  })
  const {
    requestFunds: requestFundsInternal,
    loading: faucetLoading,
    lastTx: faucetTx,
    txStatus: faucetTxStatus,
  } = useFaucet()
  const localGateway = useLocalGateway(options?.localGatewayPollMs ?? 60_000)
  const balanceQuery = useBalance({
    address,
    chainId: appConfig.chainId,
    query: { enabled: Boolean(address) },
  })
  const balance = balanceQuery.data

  const polystoreAddress = useMemo(() => {
    if (!address) return ''
    return address.startsWith('0x') ? ethToPolystoreAddress(address) : address
  }, [address])
  const [lcdStakeBalance, setLcdStakeBalance] = useState<string | null>(null)
  const [lcdBalanceLoaded, setLcdBalanceLoaded] = useState(false)

  const walletAddressShort = useMemo(() => {
    if (!address) return 'Not connected'
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }, [address])

  const evmHasFunds = useMemo(() => {
    try {
      return Boolean(balance?.value && BigInt(balance.value) > 0n)
    } catch {
      return Boolean(balance?.value)
    }
  }, [balance?.value])

  useEffect(() => {
    if (!polystoreAddress) {
      setLcdStakeBalance(null)
      setLcdBalanceLoaded(false)
      return
    }

    let cancelled = false
    let timer: number | null = null

    const load = async () => {
      try {
        const res = await fetch(`${appConfig.lcdBase}/cosmos/bank/v1beta1/balances/${polystoreAddress}`)
        const json = await res.json()
        const balances = Array.isArray(json?.balances) ? json.balances : []
        const match = balances.find(
          (entry: { denom?: string; amount?: string }) => entry?.denom === 'stake' || entry?.denom === 'aatom',
        )
        if (cancelled) return
        setLcdStakeBalance(match?.amount ? String(match.amount) : null)
        setLcdBalanceLoaded(true)
      } catch {
        if (cancelled) return
        setLcdStakeBalance(null)
        setLcdBalanceLoaded(true)
      }
    }

    const schedule = () => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runLoop()
      }, options?.lcdBalancePollMs ?? 30_000)
    }

    const runLoop = async () => {
      await load()
      schedule()
    }

    void runLoop()

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [polystoreAddress, faucetTxStatus, options?.lcdBalancePollMs])

  const hasFunds = useMemo(() => {
    if (!lcdBalanceLoaded) return evmHasFunds
    if (!lcdStakeBalance) return false
    try {
      return BigInt(lcdStakeBalance) > 0n
    } catch {
      return Boolean(lcdStakeBalance)
    }
  }, [evmHasFunds, lcdBalanceLoaded, lcdStakeBalance])

  const balanceLabel = useMemo(() => {
    if (lcdStakeBalance) return `${lcdStakeBalance} NIL`
    if (!balance) return '—'
    const formatted = formatUnits(balance.value, balance.decimals)
    const [whole, frac] = formatted.split('.')
    const trimmed = frac ? `${whole}.${frac.slice(0, 4)}` : whole
    return `${trimmed} ${balance.symbol || 'NIL'}`
  }, [balance, lcdStakeBalance])

  const gatewayConnected =
    !appConfig.gatewayDisabled &&
    (options?.includeGateway ?? true) &&
    localGateway.status === 'connected'

  const gatewayMode: SessionGatewayMode = gatewayConnected ? 'gateway' : 'browser'
  const needsReconnect = accountPermissionMismatch
  const faucetEnabled = appConfig.faucetEnabled
  const faucetBusy = faucetLoading || faucetTxStatus === 'pending'

  const primarySessionState: PrimarySessionState = !isConnected || !address
    ? 'disconnected'
    : needsReconnect
      ? 'needs-reconnect'
      : isWrongNetwork
        ? 'wrong-network'
        : !hasFunds
          ? 'needs-funds'
          : gatewayConnected
            ? 'ready-gateway'
            : 'ready-browser'

  const requestFunds = useCallback(() => requestFundsInternal(address), [address, requestFundsInternal])
  const requestFundsFor = useCallback(
    (targetAddress?: string) => requestFundsInternal(targetAddress ?? address),
    [address, requestFundsInternal],
  )

  return {
    isConnected,
    address,
    polystoreAddress,
    walletAddressShort,
    balance,
    balanceLabel,
    lcdStakeBalance,
    hasFunds,
    isWrongNetwork,
    walletChainId,
    genesisMismatch,
    accountPermissionMismatch,
    needsReconnect,
    refreshWalletNetwork,
    faucetEnabled,
    faucetBusy,
    faucetLoading,
    faucetTx,
    faucetTxStatus,
    requestFunds,
    requestFundsFor,
    gatewayMode,
    gatewayConnected,
    gatewayStatus: localGateway.status,
    localGateway,
    primarySessionState,
  }
}

export function SessionStatusProvider({
  children,
  options,
}: {
  children: ReactNode
  options?: UseSessionStatusOptions
}) {
  const value = useSessionStatusValue(options)
  return createElement(SessionStatusContext.Provider, { value }, children)
}

export function useSessionStatus(): SessionStatus {
  const context = useContext(SessionStatusContext)
  if (!context) {
    throw new Error('useSessionStatus must be used within a SessionStatusProvider')
  }
  return context
}
