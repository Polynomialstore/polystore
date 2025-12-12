import { useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  useBalance,
  useConnect,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { createPublicClient, formatUnits, http } from 'viem'
import { ArrowUpRight, Loader2, PlugZap } from 'lucide-react'
import { appConfig } from '../config'
import { injectedConnector, nilChain } from '../context/Web3Provider'
import { nilBridgeAbi } from '../abi/nilBridge'

function randomBytes32(): `0x${string}` {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return `0x${Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function normalizeBytes32(input: string): `0x${string}` {
  let hex = input.trim()
  if (!hex.startsWith('0x')) {
    hex = `0x${hex}`
  }
  const body = hex.slice(2)
  if (body.length > 64) {
    throw new Error('State root must be 32 bytes (64 hex chars)')
  }
  return `0x${body.padEnd(64, '0')}`
}

export function BridgeActions() {
  const bridgeAddress =
    appConfig.bridgeAddress && appConfig.bridgeAddress !== '0x0000000000000000000000000000000000000000'
      ? (appConfig.bridgeAddress as `0x${string}`)
      : null

  const { address, isConnected } = useAccount()
  const { connectAsync } = useConnect()
  const { data: balance } = useBalance({
    address,
    chainId: nilChain.id,
    query: { enabled: Boolean(address) },
  })

  const [nextHeight, setNextHeight] = useState<string>('')
  const [stateRoot, setStateRoot] = useState<`0x${string}`>(randomBytes32())
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const {
    writeContractAsync,
    data: txHash,
    isPending: txPending,
  } = useWriteContract()

  const { isLoading: waitingReceipt, isSuccess: txConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: nilChain.id,
  })

  // Prefill the next height from the on-chain bridge.
  useEffect(() => {
    if (!bridgeAddress) return
    let cancelled = false
    const client = createPublicClient({
      chain: nilChain,
      transport: http(appConfig.evmRpc),
    })
    client
      .readContract({
        address: bridgeAddress,
        abi: nilBridgeAbi,
        functionName: 'latestBlockHeight',
      })
      .then((h) => {
        if (!cancelled) {
          const next = (h as bigint) + 1n
          setNextHeight(next.toString())
        }
      })
      .catch(() => {
        if (!cancelled) setNextHeight('')
      })
    return () => {
      cancelled = true
    }
  }, [bridgeAddress])

  const evmBalance = useMemo(() => {
    if (!balance) return '—'
    const symbol = balance.symbol || 'NIL'
    const formatted = formatUnits(balance.value, balance.decimals)
    const [whole, frac] = formatted.split('.')
    const trimmed = frac ? `${whole}.${frac.slice(0, 4)}` : whole
    return `${trimmed} ${symbol}`
  }, [balance])

  if (!bridgeAddress) {
    return null
  }

  const shortBridge =
    bridgeAddress.length > 12 ? `${bridgeAddress.slice(0, 8)}...${bridgeAddress.slice(-4)}` : bridgeAddress

  const handleSendDemo = async () => {
    setError(null)
    setStatus(null)
    try {
      if (!isConnected) {
        await connectAsync({ connector: injectedConnector })
      }
      const height = nextHeight ? BigInt(nextHeight) : BigInt(Date.now())
      const root = normalizeBytes32(stateRoot)
      const tx = await writeContractAsync({
        address: bridgeAddress,
        abi: nilBridgeAbi,
        functionName: 'updateStateRoot',
        args: [height, root],
        chainId: nilChain.id,
      })
      setStatus(`Sent tx ${tx}`)
    } catch (e: any) {
      setError(e?.message || 'Bridge transaction failed')
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <PlugZap className="w-4 h-4 text-primary" />
          <div className="font-semibold text-foreground">NilBridge Demo</div>
          <span className="font-mono text-[11px] text-primary" title={bridgeAddress}>
            {shortBridge}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Balance:{' '}
          <span className="font-mono text-foreground">{isConnected ? evmBalance : 'Connect wallet'}</span>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-3 items-end">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Block Height
          <input
            className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
            type="number"
            value={nextHeight}
            onChange={(e) => setNextHeight(e.target.value)}
            placeholder="e.g. 123"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground md:col-span-2">
          State Root (bytes32)
          <input
            className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm font-mono"
            type="text"
            value={stateRoot}
            onChange={(e) => setStateRoot(e.target.value as `0x${string}`)}
            placeholder="0xabc..."
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSendDemo}
          disabled={txPending || waitingReceipt}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm rounded-md hover:bg-primary/90 disabled:opacity-60"
        >
          {txPending || waitingReceipt ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ArrowUpRight className="w-4 h-4" />
          )}
          {txConfirmed ? 'State Root Updated' : 'Send Demo Tx'}
        </button>
        {status && <span className="text-xs text-muted-foreground truncate">{status}</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  )
}
