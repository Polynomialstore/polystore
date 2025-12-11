import { useEffect, useState } from 'react'
import { createPublicClient, http } from 'viem'
import { appConfig } from '../config'
import { nilChain } from '../context/Web3Provider'
import { nilBridgeAbi } from '../abi/nilBridge'

export function BridgeStatus() {
  const bridgeAddress = appConfig.bridgeAddress
  const [blockHeight, setBlockHeight] = useState<bigint | null>(null)
  const [stateRoot, setStateRoot] = useState<`0x${string}` | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridgeAddress || bridgeAddress === '0x0000000000000000000000000000000000000000') {
      return
    }

    const client = createPublicClient({
      chain: nilChain,
      transport: http(appConfig.evmRpc),
    })

    let cancelled = false

    const fetchBridgeState = async () => {
      setLoading(true)
      try {
        const [height, root] = await Promise.all([
          client.readContract({
            address: bridgeAddress as `0x${string}`,
            abi: nilBridgeAbi,
            functionName: 'latestBlockHeight',
          }) as Promise<bigint>,
          client.readContract({
            address: bridgeAddress as `0x${string}`,
            abi: nilBridgeAbi,
            functionName: 'latestStateRoot',
          }) as Promise<`0x${string}`>,
        ])
        if (!cancelled) {
          setBlockHeight(height)
          setStateRoot(root)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError('Bridge RPC read failed')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchBridgeState()
    const id = setInterval(fetchBridgeState, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [bridgeAddress])

  if (!bridgeAddress || bridgeAddress === '0x0000000000000000000000000000000000000000') {
    return null
  }

  const shortAddress =
    bridgeAddress.length > 10
      ? `${bridgeAddress.slice(0, 8)}...${bridgeAddress.slice(-4)}`
      : bridgeAddress

  const shortRoot =
    stateRoot && stateRoot.length > 12
      ? `${stateRoot.slice(0, 10)}...`
      : stateRoot

  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4 flex items-center justify-between shadow-sm">
      <div className="space-y-1 text-xs">
        <div className="uppercase tracking-wide text-[10px] text-muted-foreground font-semibold">
          EVM Bridge
        </div>
        <div className="font-mono text-[11px] text-primary" title={bridgeAddress}>
          {shortAddress}
        </div>
        <div className="text-[11px] text-muted-foreground">
          Latest L1 block:{' '}
          {blockHeight !== null ? Number(blockHeight).toString() : loading ? 'Loading…' : '—'}
        </div>
      </div>
      <div className="text-right text-[11px] text-muted-foreground">
        <div className="uppercase tracking-wide text-[10px] mb-1">State Root</div>
        <div className="font-mono text-[11px] text-primary" title={stateRoot || undefined}>
          {stateRoot ? shortRoot : loading ? 'Loading…' : '—'}
        </div>
        {error && (
          <div className="mt-1 text-[10px] text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
