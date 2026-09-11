import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits } from 'viem'

import { ethToPolystoreAddress } from '../lib/address'
import { appConfig } from '../config'
import { parseStakeBalancePayload, resolveFundingStatus, type FundingStatus } from '../lib/sessionFunding'
import { useFaucet } from './useFaucet'
import { useLocalGateway } from './useLocalGateway'
import { useWalletNetworkGuard } from './useWalletNetworkGuard'

export type PrimarySessionState =
  | 'disconnected'
  | 'needs-reconnect'
  | 'wrong-network'
  | 'checking-balance'
  | 'balance-unavailable'
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
  fundingStatus: FundingStatus
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
  const [lcdBalanceState, setLcdBalanceState] = useState<{
    owner: string
    amount: string | null
    loaded: boolean
    unavailable: boolean
  }>({ owner: '', amount: null, loaded: false, unavailable: false })
  const currentLcdBalance = lcdBalanceState.owner === polystoreAddress
    ? lcdBalanceState
    : { owner: polystoreAddress, amount: null, loaded: false, unavailable: false }
  const lcdStakeBalance = currentLcdBalance.amount

  const walletAddressShort = useMemo(() => {
    if (!address) return 'Not connected'
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }, [address])

  useEffect(() => {
    if (!polystoreAddress) {
      setLcdBalanceState({ owner: '', amount: null, loaded: false, unavailable: false })
      return
    }

    let cancelled = false
    let timer: number | null = null

    const load = async () => {
      try {
        const res = await fetch(`${appConfig.lcdBase}/cosmos/bank/v1beta1/balances/${polystoreAddress}`, {
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`balance lookup failed (HTTP ${res.status})`)
        const amount = parseStakeBalancePayload(await res.json())
        if (cancelled) return
        setLcdBalanceState({
          owner: polystoreAddress,
          amount,
          loaded: true,
          unavailable: false,
        })
      } catch {
        if (cancelled) return
        setLcdBalanceState((previous) => previous.owner === polystoreAddress
          ? { ...previous, unavailable: true }
          : { owner: polystoreAddress, amount: null, loaded: false, unavailable: true })
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

  const fundingStatus = useMemo(() => resolveFundingStatus({
    lcdLoaded: currentLcdBalance.loaded,
    lcdAmount: currentLcdBalance.amount,
    lcdUnavailable: currentLcdBalance.unavailable,
    evmAmount: balance?.value,
  }), [balance?.value, currentLcdBalance.amount, currentLcdBalance.loaded, currentLcdBalance.unavailable])
  const hasFunds = fundingStatus === 'funded'

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
        : fundingStatus === 'checking'
          ? 'checking-balance'
          : fundingStatus === 'unavailable'
            ? 'balance-unavailable'
            : fundingStatus === 'unfunded'
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
    fundingStatus,
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
