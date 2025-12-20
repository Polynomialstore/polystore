import { useState } from 'react'
import { useAccount } from 'wagmi'
import { decodeEventLog, encodeFunctionData, numberToHex, type Hex } from 'viem'

import { appConfig } from '../config'
import { normalizeDealId } from '../lib/dealId'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { planNilfsFileRangeChunks } from '../lib/rangeChunker'
import { resolveProviderEndpoint, resolveProviderEndpointByAddress } from '../lib/providerDiscovery'
import { fetchGatewayP2pAddrs } from '../lib/gatewayStatus'
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
        serviceOverride && serviceOverride !== appConfig.gatewayBase ? 'prefer_direct_sp' : undefined
      const directEndpoint = await resolveProviderEndpoint(appConfig.lcdBase, dealId).catch(() => null)
      const directBase = serviceOverride || directEndpoint?.baseUrl || appConfig.spBase
      let gatewayP2p: string | undefined
      if (appConfig.p2pEnabled && !appConfig.gatewayDisabled && !directEndpoint?.p2pAddr) {
        const addrs = await fetchGatewayP2pAddrs(appConfig.gatewayBase)
        gatewayP2p = addrs[0]
      }
      const directP2p = directEndpoint?.p2pAddr || gatewayP2p
      const planResult = await transport.plan({
        manifestRoot,
        owner,
        dealId,
        filePath,
        rangeStart: wantRangeStart,
        rangeLen: effectiveRangeLen,
        directBase,
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

      setProgress((p) => ({ ...p, phase: 'opening_session_tx', receiptsSubmitted: 0, receiptsTotal: 2 }))

      const openNonce = BigInt(Date.now())
      const openExpiresAt = 0n
      const openTxData = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'openRetrievalSession',
        args: [BigInt(dealId), provider, manifestRoot, startMduIndex, startBlobIndex, blobCount, openNonce, openExpiresAt],
      })
      const openTxHash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: appConfig.nilstorePrecompile, data: openTxData, gas: numberToHex(5_000_000) }],
      })) as Hex

      const openReceipt = await waitForTransactionReceipt(openTxHash)
      let sessionId: Hex | null = null
      for (const log of openReceipt.logs || []) {
        if (String(log.address || '').toLowerCase() !== appConfig.nilstorePrecompile.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: NILSTORE_PRECOMPILE_ABI,
            eventName: 'RetrievalSessionOpened',
            topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            data: log.data,
          })
          const sid = (decoded.args as { sessionId: Hex }).sessionId
          if (sid) {
            sessionId = sid
            break
          }
        } catch {
          continue
        }
      }
      if (!sessionId) throw new Error('openRetrievalSession tx confirmed but RetrievalSessionOpened event not found')

      setProgress((p) => ({
        ...p,
        phase: 'fetching',
        filePath,
        chunkCount: chunks.length,
        bytesTotal: effectiveRangeLen,
        receiptsTotal: 2,
      }))

      const providerEndpoint = provider
        ? await resolveProviderEndpointByAddress(appConfig.lcdBase, provider).catch(() => null)
        : null
      const fetchDirectBase =
        providerEndpoint?.baseUrl ||
        (serviceOverride && serviceOverride !== appConfig.gatewayBase ? serviceOverride : undefined) ||
        (planResult.backend === 'direct_sp' ? planResult.trace.chosen?.endpoint : undefined) ||
        (directBase && directBase !== appConfig.gatewayBase ? directBase : undefined)
      const fetchDirectP2p = providerEndpoint?.p2pAddr || directP2p

      const parts: Uint8Array[] = []
      let bytesFetched = 0
      let observedProvider: string | null = null

      for (let idx = 0; idx < chunks.length; idx++) {
        const c = chunks[idx]

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
          directP2p: fetchDirectP2p,
          preference: preferenceOverride,
        })

        const hProvider = rangeResult.data.provider
        if (!observedProvider) observedProvider = hProvider
        if (observedProvider !== hProvider) {
          throw new Error(`provider mismatch during download: ${observedProvider} vs ${hProvider}`)
        }

        const buf = rangeResult.data.bytes
        parts.push(buf)
        bytesFetched += buf.byteLength

        setProgress((p) => ({
          ...p,
          phase: 'fetching',
          chunksFetched: Math.min(p.chunkCount || chunks.length, idx + 1),
          bytesFetched: Math.min(p.bytesTotal || bytesFetched, bytesFetched),
        }))
      }

      const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      setDownloadUrl(url)

      try {
        setProgress((p) => ({ ...p, phase: 'confirming_session_tx', receiptsSubmitted: 1, receiptsTotal: 2 }))

        const confirmTxData = encodeFunctionData({
          abi: NILSTORE_PRECOMPILE_ABI,
          functionName: 'confirmRetrievalSession',
          args: [sessionId],
        })
        const confirmTxHash = (await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from: address, to: appConfig.nilstorePrecompile, data: confirmTxData, gas: numberToHex(2_000_000) }],
        })) as Hex
        await waitForTransactionReceipt(confirmTxHash)

        setProgress((p) => ({ ...p, phase: 'submitting_proof_request', receiptsSubmitted: 1, receiptsTotal: 2 }))
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

        setReceiptStatus('submitted')
        setProgress((p) => ({ ...p, phase: 'done', receiptsSubmitted: 2, receiptsTotal: 2 }))
      } catch (e) {
        console.error(e)
        setProgress((p) => ({ ...p, phase: 'error', message: (e as Error).message }))
        setReceiptStatus('failed')
        setReceiptError((e as Error).message)
      }

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
