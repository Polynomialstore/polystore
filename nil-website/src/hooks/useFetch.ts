import { useState } from 'react'
import { useAccount } from 'wagmi'
import { decodeEventLog, encodeFunctionData, numberToHex, type Hex } from 'viem'

import { appConfig } from '../config'
import { normalizeDealId } from '../lib/dealId'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { planNilfsFileRangeChunks } from '../lib/rangeChunker'
import {
  resolveProviderEndpoint,
  resolveProviderEndpointByAddress,
  resolveProviderP2pEndpoint,
  resolveProviderP2pEndpointByAddress,
} from '../lib/providerDiscovery'
import { fetchGatewayP2pAddrs } from '../lib/gatewayStatus'
import { multiaddrToP2pTarget, type P2pTarget } from '../lib/multiaddr'
import { useTransportRouter } from './useTransportRouter'
import type { RoutePreference } from '../lib/transport/types'

export interface FetchInput {
  dealId: string
  manifestRoot: string
  owner: string
  filePath: string
  /**
   * Base URL for the service hosting `/gateway/*` retrieval endpoints.
   * Defaults to `appConfig.gatewayBase`.
   *
   * In thick-client flows, this often needs to point at the Storage Provider (`appConfig.spBase`)
   * because the local gateway may not have the slab on disk.
   */
  serviceBase?: string
  rangeStart?: number
  rangeLen?: number
  fileStartOffset?: number
  fileSizeBytes?: number
  mduSizeBytes?: number
  blobSizeBytes?: number
}

export type FetchPhase =
  | 'idle'
  | 'opening_session_tx'
  | 'fetching'
  | 'confirming_session_tx'
  | 'submitting_proof_request'
  | 'done'
  | 'error'

export interface FetchProgress {
  phase: FetchPhase
  filePath: string
  chunksFetched: number
  chunkCount: number
  bytesFetched: number
  bytesTotal: number
  receiptsSubmitted: number
  receiptsTotal: number
  message?: string
}

export interface FetchResult {
  url: string
  blob: Blob
}

function decodeHttpError(bodyText: string): string {
  const trimmed = bodyText?.trim?.() ? bodyText.trim() : String(bodyText ?? '')
  if (!trimmed) return 'request failed'
  try {
    const json = JSON.parse(trimmed)
    if (json && typeof json === 'object') {
      if (typeof json.error === 'string' && json.error.trim()) {
        const hint = typeof json.hint === 'string' && json.hint.trim() ? ` (${json.hint.trim()})` : ''
        return `${json.error.trim()}${hint}`
      }
      if (typeof json.message === 'string' && json.message.trim()) {
        return json.message.trim()
      }
    }
  } catch (e) {
    void e
  }
  return trimmed
}

export function useFetch() {
  const { address } = useAccount()
  const transport = useTransportRouter()
  const [loading, setLoading] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [receiptStatus, setReceiptStatus] = useState<'idle' | 'submitted' | 'failed'>('idle')
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [progress, setProgress] = useState<FetchProgress>({
    phase: 'idle',
    filePath: '',
    chunksFetched: 0,
    chunkCount: 0,
    bytesFetched: 0,
    bytesTotal: 0,
    receiptsSubmitted: 0,
    receiptsTotal: 0,
  })

  async function fetchFile(input: FetchInput): Promise<FetchResult | null> {
    setLoading(true)
    setDownloadUrl(null)
    setReceiptStatus('idle')
    setReceiptError(null)
    setProgress({
      phase: 'idle',
      filePath: String(input.filePath || ''),
      chunksFetched: 0,
      chunkCount: 0,
      bytesFetched: 0,
      bytesTotal: 0,
      receiptsSubmitted: 0,
      receiptsTotal: 0,
    })

    try {
      if (!address) throw new Error('Connect a wallet to submit retrieval proofs')
      const ethereum = window.ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const dealId = normalizeDealId(input.dealId)
      const owner = String(input.owner ?? '').trim()
      if (!owner) throw new Error('owner is required')
      const filePath = String(input.filePath || '').trim()
      if (!filePath) throw new Error('filePath is required')

      const manifestRoot = String(input.manifestRoot || '').trim() as Hex
      if (!manifestRoot.startsWith('0x')) throw new Error('manifestRoot must be 0x-prefixed hex bytes')

      const blobSizeBytes = Number(input.blobSizeBytes || 128 * 1024)
      const mduSizeBytes = Number(input.mduSizeBytes || 8 * 1024 * 1024)
      const wantRangeStart = Math.max(0, Number(input.rangeStart ?? 0))
      const wantRangeLen = Math.max(0, Number(input.rangeLen ?? 0))
      const wantFileSize = typeof input.fileSizeBytes === 'number' ? Number(input.fileSizeBytes) : 0

      let effectiveRangeLen = wantRangeLen
      if (effectiveRangeLen === 0) {
        if (!wantFileSize) throw new Error('fileSizeBytes is required for full downloads (rangeLen=0)')
        if (wantRangeStart >= wantFileSize) throw new Error('rangeStart beyond EOF')
        effectiveRangeLen = wantFileSize - wantRangeStart
      }

      const hasMeta =
        typeof input.fileStartOffset === 'number' &&
        typeof input.fileSizeBytes === 'number' &&
        typeof input.mduSizeBytes === 'number' &&
        typeof input.blobSizeBytes === 'number'

      const chunks =
        hasMeta
          ? planNilfsFileRangeChunks({
              fileStartOffset: input.fileStartOffset!,
              fileSizeBytes: input.fileSizeBytes!,
              rangeStart: wantRangeStart,
              rangeLen: effectiveRangeLen,
              mduSizeBytes: input.mduSizeBytes!,
              blobSizeBytes: input.blobSizeBytes!,
            })
          : [{ rangeStart: wantRangeStart, rangeLen: effectiveRangeLen }]

      if (!hasMeta && effectiveRangeLen > blobSizeBytes) {
        throw new Error('range fetch > blob size requires fileStartOffset/fileSizeBytes/mduSizeBytes/blobSizeBytes')
      }

      const serviceOverride = String(input.serviceBase ?? '').trim().replace(/\/$/, '')
      const preferenceOverride: RoutePreference | undefined =
        serviceOverride && serviceOverride !== appConfig.gatewayBase && transport.preference !== 'prefer_p2p'
          ? 'prefer_direct_sp'
          : undefined
      const directEndpoint = await resolveProviderEndpoint(appConfig.lcdBase, dealId).catch(() => null)
      const p2pEndpoint = await resolveProviderP2pEndpoint(appConfig.lcdBase, dealId).catch(() => null)
      const directBase = serviceOverride || directEndpoint?.baseUrl || appConfig.spBase

      let gatewayP2pTarget: P2pTarget | undefined
      if (appConfig.p2pEnabled && !appConfig.gatewayDisabled && !p2pEndpoint?.target) {
        const addrs = await fetchGatewayP2pAddrs(appConfig.gatewayBase)
        for (const addr of addrs) {
          const target = multiaddrToP2pTarget(addr)
          if (target) {
            gatewayP2pTarget = target
            break
          }
        }
      }

      const planP2pTarget = p2pEndpoint?.target || gatewayP2pTarget || undefined
      const providerEndpointCache = new Map<string, Awaited<ReturnType<typeof resolveProviderEndpointByAddress>> | null>()
      const providerP2pCache = new Map<string, Awaited<ReturnType<typeof resolveProviderP2pEndpointByAddress>> | null>()

      const getProviderEndpoint = async (provider: string) => {
        if (providerEndpointCache.has(provider)) return providerEndpointCache.get(provider) ?? null
        const endpoint = await resolveProviderEndpointByAddress(appConfig.lcdBase, provider).catch(() => null)
        providerEndpointCache.set(provider, endpoint)
        return endpoint
      }
      const getProviderP2pEndpoint = async (provider: string) => {
        if (providerP2pCache.has(provider)) return providerP2pCache.get(provider) ?? null
        const endpoint = await resolveProviderP2pEndpointByAddress(appConfig.lcdBase, provider).catch(() => null)
        providerP2pCache.set(provider, endpoint)
        return endpoint
      }

      const parts: Uint8Array[] = []
      let bytesFetched = 0
      let receiptsSubmitted = 0
      let chunksFetched = 0

      type PlannedChunk = {
        rangeStart: number
        rangeLen: number
        provider: string
        startMduIndex: bigint
        startBlobIndex: number
        blobCount: bigint
        planBackend: string
        planEndpoint?: string
      }

      const plannedChunks: PlannedChunk[] = []
      for (const c of chunks) {
        const planResult = await transport.plan({
          manifestRoot,
          owner,
          dealId,
          filePath,
          rangeStart: c.rangeStart,
          rangeLen: c.rangeLen,
          directBase,
          p2pTarget: planP2pTarget,
          preference: preferenceOverride,
        })

        const planJson = planResult.data
        const provider = String(planJson.provider || '').trim()
        if (!provider) throw new Error('gateway plan did not return provider')
        const startMduIndex = BigInt(Number(planJson.start_mdu_index || 0))
        const startBlobIndex = Number(planJson.start_blob_index || 0)
        const blobCount = BigInt(Number(planJson.blob_count || 0))
        if (startMduIndex <= 0n) throw new Error('gateway plan did not return start_mdu_index')
        if (!Number.isFinite(startBlobIndex) || startBlobIndex < 0) throw new Error('gateway plan did not return start_blob_index')
        if (blobCount <= 0n) throw new Error('gateway plan did not return blob_count')

        plannedChunks.push({
          rangeStart: c.rangeStart,
          rangeLen: c.rangeLen,
          provider,
          startMduIndex,
          startBlobIndex,
          blobCount,
          planBackend: planResult.backend,
          planEndpoint: planResult.trace?.chosen?.endpoint,
        })
      }

      const leafCount = BigInt(Math.max(1, Math.floor(mduSizeBytes / blobSizeBytes)))
      const providerGroups = new Map<string, {
        provider: string
        chunks: PlannedChunk[]
        globalStart: bigint
        globalEnd: bigint
      }>()

      for (const chunk of plannedChunks) {
        const globalStart = chunk.startMduIndex * leafCount + BigInt(chunk.startBlobIndex)
        const globalEnd = globalStart + chunk.blobCount - 1n
        const existing = providerGroups.get(chunk.provider)
        if (existing) {
          existing.chunks.push(chunk)
          if (globalStart < existing.globalStart) existing.globalStart = globalStart
          if (globalEnd > existing.globalEnd) existing.globalEnd = globalEnd
        } else {
          providerGroups.set(chunk.provider, {
            provider: chunk.provider,
            chunks: [chunk],
            globalStart,
            globalEnd,
          })
        }
      }

      setProgress((p) => ({
        ...p,
        phase: 'opening_session_tx',
        filePath,
        chunkCount: chunks.length,
        bytesTotal: effectiveRangeLen,
        receiptsSubmitted: 0,
        receiptsTotal: providerGroups.size > 0 ? 2 : 0,
      }))

      const groups = Array.from(providerGroups.values())
      const openBaseNonce = BigInt(Date.now())
      const openRequests = groups.map((group, index) => {
        const groupStartMdu = group.globalStart / leafCount
        const groupStartBlob = Number(group.globalStart % leafCount)
        const groupBlobCount = group.globalEnd - group.globalStart + 1n
        return {
          dealId: BigInt(dealId),
          provider: group.provider,
          manifestRoot,
          startMduIndex: groupStartMdu,
          startBlobIndex: groupStartBlob,
          blobCount: groupBlobCount,
          nonce: openBaseNonce + BigInt(index),
          expiresAt: 0n,
        }
      })

      const openTxData = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'openRetrievalSessions',
        args: [openRequests],
      })
      const openTxHash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: appConfig.nilstorePrecompile, data: openTxData, gas: numberToHex(7_000_000) }],
      })) as Hex

      const openReceipt = await waitForTransactionReceipt(openTxHash)
      const sessionsByProvider = new Map<string, Hex>()
      for (const log of openReceipt.logs || []) {
        if (String(log.address || '').toLowerCase() !== appConfig.nilstorePrecompile.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: NILSTORE_PRECOMPILE_ABI,
            eventName: 'RetrievalSessionOpened',
            topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            data: log.data,
          })
          const args = decoded.args as { provider?: string; sessionId?: Hex }
          const provider = String(args.provider || '').trim()
          const sid = args.sessionId
          if (provider && sid) {
            sessionsByProvider.set(provider, sid)
          }
        } catch {
          continue
        }
      }

      for (const group of groups) {
        if (!sessionsByProvider.has(group.provider)) {
          throw new Error(`openRetrievalSessions tx confirmed but session for ${group.provider} not found`)
        }
      }

      receiptsSubmitted = 1
      setProgress((p) => ({
        ...p,
        phase: 'fetching',
        chunkCount: chunks.length,
        bytesTotal: effectiveRangeLen,
        receiptsSubmitted,
      }))

      for (const group of groups) {
        const provider = group.provider
        const sessionId = sessionsByProvider.get(provider)
        if (!sessionId) {
          throw new Error(`missing session for provider ${provider}`)
        }

        const providerEndpoint = await getProviderEndpoint(provider)
        const providerP2pEndpoint = await getProviderP2pEndpoint(provider)
        const fetchP2pTarget =
          providerP2pEndpoint?.target ||
          (p2pEndpoint && p2pEndpoint.provider === provider ? p2pEndpoint.target : undefined) ||
          gatewayP2pTarget

        let fetchDirectBase =
          providerEndpoint?.baseUrl ||
          group.chunks.find((c) => c.planBackend === 'direct_sp')?.planEndpoint ||
          (serviceOverride && serviceOverride !== appConfig.gatewayBase ? serviceOverride : undefined) ||
          (directBase && directBase !== appConfig.gatewayBase ? directBase : undefined)
        if (!providerEndpoint && group.chunks.every((c) => c.planBackend !== 'direct_sp')) {
          fetchDirectBase = undefined
        }

        for (const c of group.chunks) {
          const rangeResult = await transport.fetchRange({
            manifestRoot,
            owner,
            dealId,
            filePath,
            rangeStart: c.rangeStart,
            rangeLen: c.rangeLen,
            sessionId,
            expectedProvider: provider,
            directBase: fetchDirectBase,
            p2pTarget: fetchP2pTarget,
            preference: preferenceOverride,
          })

          const buf = rangeResult.data.bytes
          parts.push(buf)
          bytesFetched += buf.byteLength
          chunksFetched += 1

          setProgress((p) => ({
            ...p,
            phase: 'fetching',
            chunksFetched: Math.min(p.chunkCount || chunks.length, chunksFetched),
            bytesFetched: Math.min(p.bytesTotal || bytesFetched, bytesFetched),
          }))
        }
      }

      setProgress((p) => ({
        ...p,
        phase: 'confirming_session_tx',
        receiptsSubmitted,
      }))

      const sessionIds = groups.map((group) => sessionsByProvider.get(group.provider) as Hex)
      const confirmTxData = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'confirmRetrievalSessions',
        args: [sessionIds],
      })
      const confirmTxHash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: appConfig.nilstorePrecompile, data: confirmTxData, gas: numberToHex(3_000_000) }],
      })) as Hex
      await waitForTransactionReceipt(confirmTxHash)
      receiptsSubmitted = 2

      setProgress((p) => ({
        ...p,
        phase: 'submitting_proof_request',
        receiptsSubmitted,
      }))

      for (const group of groups) {
        const provider = group.provider
        const sessionId = sessionsByProvider.get(provider)
        if (!sessionId) {
          throw new Error(`missing session for provider ${provider}`)
        }
        // `session-proof` is an internal "user daemon -> provider" forward and requires gateway auth.
        // Even when `serviceBase` points at the provider (direct fetch flows), proof submission must go
        // through the local gateway.
        const proofBase = appConfig.gatewayBase
        const proofRes = await fetch(`${proofBase}/gateway/session-proof?deal_id=${encodeURIComponent(dealId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, provider }),
        })
        if (!proofRes.ok) {
          const text = await proofRes.text().catch(() => '')
          throw new Error(decodeHttpError(text) || `submit session proof failed (${proofRes.status})`)
        }
      }

      const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      setDownloadUrl(url)

      setReceiptStatus('submitted')
      setProgress((p) => ({
        ...p,
        phase: 'done',
        receiptsSubmitted: receiptsSubmitted,
      }))

      return { url, blob }
    } catch (e) {
      console.error(e)
      setProgress((p) => ({ ...p, phase: 'error', message: (e as Error).message }))
      setReceiptStatus('failed')
      setReceiptError((e as Error).message)
      return null
    } finally {
      setLoading(false)
    }
  }

  return { fetchFile, loading, downloadUrl, receiptStatus, receiptError, progress }
}
