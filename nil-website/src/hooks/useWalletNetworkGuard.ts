import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { appConfig } from '../config'

type EthereumRequestArgs = {
  method: string
  params?: unknown[] | Record<string, unknown>
}

type EthereumProvider = {
  request?: (args: EthereumRequestArgs) => Promise<unknown>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

type RpcBlock = {
  hash?: unknown
}

type RpcEnvelope = {
  result?: unknown
}

export type WalletNetworkGuardState = {
  walletChainId: number | null
  chainIdMismatch: boolean
  genesisMismatch: boolean
  isWrongNetwork: boolean
  accountPermissionMismatch: boolean
  expectedGenesisHash: string | null
  walletGenesisHash: string | null
  refresh: () => Promise<void>
}

function getEthereum(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eth = (window as any).ethereum as EthereumProvider | undefined
  return eth ?? null
}

function normalizeAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeHex(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('0x')) return ''
  return trimmed
}

function parseHexChainId(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  const parsed = parseInt(value, 16)
  return Number.isFinite(parsed) ? parsed : null
}

async function fetchExpectedGenesisHash(rpcUrl: string): Promise<string | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: ['0x0', false],
        id: 1,
      }),
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as RpcEnvelope | null
    const block = (json?.result ?? null) as RpcBlock | null
    const hash = normalizeHex(block?.hash)
    return hash || null
  } catch {
    return null
  }
}

async function fetchWalletGenesisHash(ethereum: EthereumProvider): Promise<string | null> {
  if (typeof ethereum.request !== 'function') return null
  try {
    const raw = await ethereum.request({
      method: 'eth_getBlockByNumber',
      params: ['0x0', false],
    })
    const block = (raw ?? null) as RpcBlock | null
    const hash = normalizeHex(block?.hash)
    return hash || null
  } catch {
    return null
  }
}

async function fetchWalletChainId(ethereum: EthereumProvider): Promise<number | null> {
  if (typeof ethereum.request !== 'function') return null
  try {
    const raw = await ethereum.request({ method: 'eth_chainId' })
    return parseHexChainId(raw)
  } catch {
    return null
  }
}

async function fetchWalletAccounts(ethereum: EthereumProvider): Promise<string[]> {
  if (typeof ethereum.request !== 'function') return []
  try {
    const raw = await ethereum.request({ method: 'eth_accounts' })
    if (!Array.isArray(raw)) return []
    return raw.map((item) => normalizeAddress(item)).filter(Boolean)
  } catch {
    return []
  }
}

export function useWalletNetworkGuard(options?: { enabled?: boolean; pollMs?: number }) {
  const { address, isConnected } = useAccount()
  const enabled = options?.enabled ?? true
  const pollMs = options?.pollMs ?? 20_000
  const hiddenPollMs = Math.max(pollMs * 3, 60_000)

  const [walletChainId, setWalletChainId] = useState<number | null>(null)
  const [expectedGenesisHash, setExpectedGenesisHash] = useState<string | null>(null)
  const [walletGenesisHash, setWalletGenesisHash] = useState<string | null>(null)
  const [accountPermissionMismatch, setAccountPermissionMismatch] = useState(false)

  const refresh = useCallback(async () => {
    if (!enabled) return
    const ethereum = getEthereum()
    if (!ethereum) {
      setWalletChainId(null)
      setWalletGenesisHash(null)
      setAccountPermissionMismatch(false)
      return
    }

    const [walletChain, expectedGenesis, walletAccounts] = await Promise.all([
      fetchWalletChainId(ethereum),
      fetchExpectedGenesisHash(appConfig.evmRpc),
      fetchWalletAccounts(ethereum),
    ])

    setWalletChainId(walletChain)
    setExpectedGenesisHash(expectedGenesis)

    const currentAddress = normalizeAddress(address)
    const permissionMismatch =
      Boolean(isConnected && currentAddress) &&
      (walletAccounts.length === 0 || !walletAccounts.includes(currentAddress))
    setAccountPermissionMismatch(permissionMismatch)

    if (!isConnected || walletChain === null || walletChain !== appConfig.chainId) {
      setWalletGenesisHash(null)
      return
    }

    const walletGenesis = await fetchWalletGenesisHash(ethereum)
    setWalletGenesisHash(walletGenesis)
  }, [address, enabled, isConnected])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: number | null = null
    const ethereum = getEthereum()

    const schedule = (delayMs: number) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runLoop()
      }, delayMs)
    }

    const runLoop = async () => {
      if (cancelled) return
      await refresh()
      if (cancelled) return
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      schedule(hidden ? hiddenPollMs : pollMs)
    }

    const handleRefreshEvent = () => {
      void refresh()
    }

    void runLoop()

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleRefreshEvent)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleRefreshEvent)
    }
    if (ethereum?.on) {
      ethereum.on('accountsChanged', handleRefreshEvent)
      ethereum.on('chainChanged', handleRefreshEvent)
      ethereum.on('connect', handleRefreshEvent)
      ethereum.on('disconnect', handleRefreshEvent)
    }

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleRefreshEvent)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleRefreshEvent)
      }
      if (ethereum?.removeListener) {
        ethereum.removeListener('accountsChanged', handleRefreshEvent)
        ethereum.removeListener('chainChanged', handleRefreshEvent)
        ethereum.removeListener('connect', handleRefreshEvent)
        ethereum.removeListener('disconnect', handleRefreshEvent)
      }
    }
  }, [enabled, hiddenPollMs, pollMs, refresh])

  const chainIdMismatch = useMemo(() => {
    if (!isConnected) return false
    if (walletChainId === null) return false
    return walletChainId !== appConfig.chainId
  }, [isConnected, walletChainId])

  const genesisMismatch = useMemo(() => {
    if (!isConnected) return false
    if (chainIdMismatch) return false
    if (!expectedGenesisHash || !walletGenesisHash) return false
    return expectedGenesisHash !== walletGenesisHash
  }, [chainIdMismatch, expectedGenesisHash, isConnected, walletGenesisHash])

  return {
    walletChainId,
    chainIdMismatch,
    genesisMismatch,
    isWrongNetwork: chainIdMismatch || genesisMismatch,
    accountPermissionMismatch,
    expectedGenesisHash,
    walletGenesisHash,
    refresh,
  } satisfies WalletNetworkGuardState
}

