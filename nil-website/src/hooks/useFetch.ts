import { useState } from 'react'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { type Hex } from 'viem'

import { appConfig } from '../config'
import { ethToNil } from '../lib/address'
import { normalizeDealId } from '../lib/dealId'
import { buildRetrievalRequestTypedData } from '../lib/eip712'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import {
  decodeComputeRetrievalSessionIdsResult,
  encodeComputeRetrievalSessionIdsData,
  encodeConfirmRetrievalSessionsData,
  encodeOpenRetrievalSessionsData,
  encodeOpenRetrievalSessionsSponsoredData,
} from '../lib/nilstorePrecompile'
import { planNilfsFileRangeChunks } from '../lib/rangeChunker'
import { decodeNilceV1 } from '../lib/nilce'
import { classifyWalletError } from '../lib/walletErrors'
import {
  resolveProviderEndpoint,
  resolveProviderEndpointByAddress,
  resolveProviderEndpoints,
  resolveProviderP2pEndpoint,
  resolveProviderP2pEndpointByAddress,
} from '../lib/providerDiscovery'
import { fetchGatewayP2pAddrs } from '../lib/gatewayStatus'
import { multiaddrToP2pTarget, type P2pTarget } from '../lib/multiaddr'
import { useTransportRouter } from './useTransportRouter'
import type { RoutePreference } from '../lib/transport/types'
import { classifyError, isRetryable } from '../lib/transport/errors'

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
  sponsoredAuth?: SponsoredRetrievalAuth
  routePreference?: RoutePreference
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

export interface VoucherAuthInput {
  provider?: string
  expiresAt?: number
  nonce: number
  redeemer?: string
  signature: Hex
}

export type SponsoredRetrievalAuth =
  | { type: 'none' }
  | { type: 'allowlist'; leafIndex: number; merklePath: Hex[] }
  | { type: 'voucher'; voucher: VoucherAuthInput }

const LOCAL_GATEWAY_CONNECTED_KEY = 'nil_local_gateway_connected'

function readLocalGatewayConnectedHint(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LOCAL_GATEWAY_CONNECTED_KEY) === '1'
  } catch {
    return false
  }
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  const total = chunks.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of chunks) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
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

function shouldRetryWithAlternateProvider(err: unknown): boolean {
  const { errorClass } = classifyError(err)
  return isRetryable(errorClass) || errorClass === 'provider_mismatch' || errorClass === 'http_4xx'
}

export function useFetch() {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient({ chainId: appConfig.chainId })
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
      if (!walletClient) throw new Error('Wallet not connected')
      if (!publicClient) throw new Error('EVM RPC client unavailable')
      const signerAddress = (walletClient.account?.address || address) as Hex

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
      const shouldDecodeNilce =
        wantRangeStart === 0 && wantFileSize > 0 && effectiveRangeLen === wantFileSize

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
      const preferenceOverride: RoutePreference | undefined = input.routePreference
      const directEndpoint = await resolveProviderEndpoint(appConfig.lcdBase, dealId).catch(() => null)
      const p2pEndpoint = await resolveProviderP2pEndpoint(appConfig.lcdBase, dealId).catch(() => null)
      const directBase = serviceOverride || directEndpoint?.baseUrl || appConfig.spBase
      const gatewayModeActive =
        !appConfig.gatewayDisabled &&
        (preferenceOverride === 'prefer_gateway' ||
          (preferenceOverride === undefined &&
            transport.preference !== 'prefer_direct_sp' &&
            transport.preference !== 'prefer_p2p' &&
            readLocalGatewayConnectedHint()))

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
      const providerFallbackOrder: string[] = []
      const seenFallbackProviders = new Set<string>()
      const rememberFallbackProvider = (provider: string) => {
        const normalized = String(provider || '').trim()
        if (!normalized || seenFallbackProviders.has(normalized)) return
        seenFallbackProviders.add(normalized)
        providerFallbackOrder.push(normalized)
      }

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

      const resolvedProviderEndpoints = await resolveProviderEndpoints(appConfig.lcdBase, dealId).catch(() => [])
      for (const endpoint of resolvedProviderEndpoints) {
        const provider = String(endpoint?.provider || '').trim()
        if (!provider) continue
        rememberFallbackProvider(provider)
        providerEndpointCache.set(provider, endpoint)
        if (endpoint.p2pTarget) {
          providerP2pCache.set(provider, { provider, target: endpoint.p2pTarget })
        }
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
        rememberFallbackProvider(provider)

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
      if (groups.length === 0) {
        throw new Error('retrieval planner returned no provider groups')
      }
      const globalRangeStart = groups.reduce(
        (min, group) => (group.globalStart < min ? group.globalStart : min),
        groups[0].globalStart,
      )
      const globalRangeEnd = groups.reduce(
        (max, group) => (group.globalEnd > max ? group.globalEnd : max),
        groups[0].globalEnd,
      )

      const openBaseNonce = BigInt(Date.now())
      let openNonceOffset = BigInt(groups.length)
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

      const computeData = encodeComputeRetrievalSessionIdsData(openRequests)
      const computeCall = await publicClient.call({
        account: signerAddress,
        to: appConfig.nilstorePrecompile as Hex,
        data: computeData,
      })
      const computeResult = computeCall.data as Hex
      if (!computeResult || computeResult === '0x') {
        throw new Error('computeRetrievalSessionIds call returned empty data')
      }
      const { providers: computedProviders, sessionIds: computedSessionIds } =
        decodeComputeRetrievalSessionIdsResult(computeResult)
      const sessionsByProvider = new Map<string, Hex>()
      for (let i = 0; i < computedProviders.length; i++) {
        const provider = String(computedProviders[i] || '').trim()
        const sessionId = computedSessionIds[i]
        if (!provider || !sessionId) continue
        sessionsByProvider.set(provider, sessionId)
      }
      for (const group of groups) {
        if (!sessionsByProvider.has(group.provider)) {
          throw new Error(`computeRetrievalSessionIds did not return session for ${group.provider}`)
        }
      }

      const callerNil = ethToNil(signerAddress)
      const isDealOwner = callerNil && callerNil === owner
      const sponsoredAuth = input.sponsoredAuth ?? { type: 'none' }
      const authType =
        sponsoredAuth.type === 'allowlist' ? 1 : sponsoredAuth.type === 'voucher' ? 2 : 0
      if (authType === 2 && openRequests.length > 1) {
        throw new Error('voucher auth requires a single provider range')
      }
      const allowlistLeafIndex = sponsoredAuth.type === 'allowlist' ? sponsoredAuth.leafIndex : 0
      const allowlistMerklePath = sponsoredAuth.type === 'allowlist' ? sponsoredAuth.merklePath : []
      const voucher = sponsoredAuth.type === 'voucher' ? sponsoredAuth.voucher : undefined
      const voucherNonce = voucher ? BigInt(voucher.nonce) : 0n
      const voucherExpiresAt = voucher?.expiresAt ? BigInt(voucher.expiresAt) : 0n
      const voucherRedeemer = voucher?.redeemer ?? ''
      const voucherProvider = voucher?.provider ?? ''
      const voucherSignature = voucher?.signature ?? ('0x' as Hex)
      const buildSponsoredOpenRequests = <T extends {
        dealId: bigint
        provider: string
        manifestRoot: Hex
        startMduIndex: bigint
        startBlobIndex: number
        blobCount: bigint
        nonce: bigint
        expiresAt: bigint
      }>(requests: T[]) =>
        requests.map((request) => ({
          ...request,
          maxTotalFee: 0n,
          authType,
          allowlistLeafIndex,
          allowlistMerklePath,
          voucherRedeemer,
          voucherProvider,
          voucherExpiresAt,
          voucherNonce,
          voucherSignature,
        }))

      const openSessionsOnChain = async <T extends {
        dealId: bigint
        provider: string
        manifestRoot: Hex
        startMduIndex: bigint
        startBlobIndex: number
        blobCount: bigint
        nonce: bigint
        expiresAt: bigint
      }>(requests: T[]) => {
        const openTxData = encodeOpenRetrievalSessionsData(requests)
        const sponsoredTxData = encodeOpenRetrievalSessionsSponsoredData(buildSponsoredOpenRequests(requests))
        const openTxHash = await walletClient.sendTransaction({
          account: signerAddress,
          to: appConfig.nilstorePrecompile as Hex,
          data: isDealOwner ? openTxData : sponsoredTxData,
          gas: 7_000_000n,
        })
        await waitForTransactionReceipt(openTxHash)
      }

      await openSessionsOnChain(openRequests)

      const ensureSessionForProvider = async (provider: string): Promise<Hex | null> => {
        const normalized = String(provider || '').trim()
        if (!normalized) return null
        const existing = sessionsByProvider.get(normalized)
        if (existing) return existing
        if (authType === 2) return null

        const request = {
          dealId: BigInt(dealId),
          provider: normalized,
          manifestRoot,
          startMduIndex: globalRangeStart / leafCount,
          startBlobIndex: Number(globalRangeStart % leafCount),
          blobCount: globalRangeEnd - globalRangeStart + 1n,
          nonce: openBaseNonce + openNonceOffset,
          expiresAt: 0n,
        }
        openNonceOffset += 1n

        const computeData = encodeComputeRetrievalSessionIdsData([request])
        const computeCall = await publicClient.call({
          account: signerAddress,
          to: appConfig.nilstorePrecompile as Hex,
          data: computeData,
        })
        const computeResult = computeCall.data as Hex
        if (!computeResult || computeResult === '0x') return null
        const computed = decodeComputeRetrievalSessionIdsResult(computeResult)
        let sessionId: Hex | null = null
        for (let i = 0; i < computed.providers.length; i++) {
          const computedProvider = String(computed.providers[i] || '').trim()
          if (computedProvider !== normalized) continue
          sessionId = computed.sessionIds[i] || null
          break
        }
        if (!sessionId) return null

        await openSessionsOnChain([request])
        sessionsByProvider.set(normalized, sessionId)
        return sessionId
      }

      receiptsSubmitted = 1
      setProgress((p) => ({
        ...p,
        phase: 'fetching',
        chunkCount: chunks.length,
        bytesTotal: effectiveRangeLen,
        receiptsSubmitted,
      }))

      let metaAuth:
        | {
            reqSig: string
            reqNonce: number
            reqExpiresAt: number
            signedRangeStart: number
            signedRangeLen: number
          }
        | undefined

      const shouldSignMetaAuth = (err: unknown): boolean => {
        if (!(err instanceof Error)) return false
        const msg = decodeHttpError(err.message)
        return /req_sig is required/i.test(msg) || /range must be signed/i.test(msg)
      }

      const signMetaAuth = async () => {
        const now = Math.floor(Date.now() / 1000)
        const reqNonce = Math.floor(Math.random() * 1_000_000_000) + Date.now()
        const reqExpiresAt = now + 9 * 60
        const typedData = buildRetrievalRequestTypedData(
          {
            deal_id: Number(dealId),
            file_path: filePath,
            range_start: wantRangeStart,
            range_len: effectiveRangeLen,
            nonce: reqNonce,
            expires_at: reqExpiresAt,
          },
          appConfig.chainId,
        )
        const typedDataForViem = typedData as {
          domain: {
            name: string
            version: string
            chainId: number
            verifyingContract: Hex
          }
          types: Record<string, readonly { name: string; type: string }[]>
          primaryType: 'RetrievalRequest'
          message: Record<string, unknown>
        }

        const reqSig = await walletClient.signTypedData({
          account: signerAddress,
          domain: {
            ...typedDataForViem.domain,
            chainId: BigInt(typedDataForViem.domain.chainId),
          },
          types: typedDataForViem.types,
          primaryType: typedDataForViem.primaryType,
          message: typedDataForViem.message,
        })

        metaAuth = {
          reqSig,
          reqNonce,
          reqExpiresAt,
          signedRangeStart: wantRangeStart,
          signedRangeLen: effectiveRangeLen,
        }
        return metaAuth
      }

      const usedSessionsByProvider = new Map<string, Hex>()
      for (const group of groups) {
        const provider = group.provider
        const primarySessionId = sessionsByProvider.get(provider)
        if (!primarySessionId) {
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
          const candidateProviders = gatewayModeActive
            ? [provider]
            : [provider, ...providerFallbackOrder.filter((candidate) => candidate !== provider)]
          let rangeResult: Awaited<ReturnType<typeof transport.fetchRange>> | null = null
          let selectedProvider = provider
          let selectedSessionId: Hex | null = primarySessionId
          let lastFetchError: unknown = null

          for (const candidateProvider of candidateProviders) {
            const candidateSessionId =
              candidateProvider === provider
                ? primarySessionId
                : await ensureSessionForProvider(candidateProvider)
            if (!candidateSessionId) continue

            const candidateEndpoint =
              candidateProvider === provider ? providerEndpoint : await getProviderEndpoint(candidateProvider)
            const candidateP2pEndpoint =
              candidateProvider === provider ? providerP2pEndpoint : await getProviderP2pEndpoint(candidateProvider)
            const candidateDirectBase =
              candidateEndpoint?.baseUrl ||
              (candidateProvider === provider
                ? fetchDirectBase
                : undefined)
            const candidateP2pTarget =
              candidateP2pEndpoint?.target ||
              (candidateProvider === provider
                ? fetchP2pTarget
                : undefined)

            if (candidateProvider !== provider && !candidateDirectBase && !candidateP2pTarget) {
              continue
            }

            const fetchReq = {
              manifestRoot,
              owner,
              dealId,
              filePath,
              rangeStart: c.rangeStart,
              rangeLen: c.rangeLen,
              sessionId: candidateSessionId,
              expectedProvider: candidateProvider,
              directBase: candidateDirectBase,
              p2pTarget: candidateP2pTarget,
              preference:
                candidateProvider === provider
                  ? preferenceOverride
                  : (gatewayModeActive ? 'prefer_gateway' : ('prefer_direct_sp' as RoutePreference)),
            }

            try {
              rangeResult = await transport.fetchRange({ ...fetchReq, auth: metaAuth })
            } catch (err) {
              if (!metaAuth && shouldSignMetaAuth(err)) {
                setProgress((p) => ({ ...p, message: 'Sign the download request to authorize retrieval' }))
                metaAuth = await signMetaAuth()
                try {
                  rangeResult = await transport.fetchRange({ ...fetchReq, auth: metaAuth })
                } catch (signedErr) {
                  lastFetchError = signedErr
                  if (candidateProvider !== provider || shouldRetryWithAlternateProvider(signedErr)) {
                    continue
                  }
                  throw signedErr
                }
              } else {
                lastFetchError = err
                if (candidateProvider !== provider || shouldRetryWithAlternateProvider(err)) {
                  continue
                }
                throw err
              }
            }

            if (rangeResult) {
              selectedProvider = candidateProvider
              selectedSessionId = candidateSessionId
              break
            }
          }

          if (!rangeResult) {
            throw (lastFetchError instanceof Error ? lastFetchError : new Error('failed to fetch chunk from any provider'))
          }
          if (!selectedSessionId) {
            throw new Error(`missing retrieval session for provider ${selectedProvider}`)
          }
          usedSessionsByProvider.set(selectedProvider, selectedSessionId)
          if (selectedProvider !== provider) {
            setProgress((p) => ({
              ...p,
              message: `Primary provider unavailable; failed over to ${selectedProvider.slice(0, 12)}…`,
            }))
          }

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

      const sessionIds = Array.from(usedSessionsByProvider.values())
      if (sessionIds.length === 0) {
        throw new Error('no retrieval sessions were used during fetch')
      }
      let confirmError: string | null = null
      try {
        const confirmTxData = encodeConfirmRetrievalSessionsData(sessionIds)
        const confirmTxHash = await walletClient.sendTransaction({
          account: signerAddress,
          to: appConfig.nilstorePrecompile as Hex,
          data: confirmTxData,
          gas: 3_000_000n,
        })
        await waitForTransactionReceipt(confirmTxHash)
        receiptsSubmitted = 2
      } catch (err) {
        confirmError = classifyWalletError(err, 'Confirm retrieval failed').message
      }

      setProgress((p) => ({
        ...p,
        phase: 'submitting_proof_request',
        receiptsSubmitted,
        message: confirmError ? `Receipt confirmation failed: ${confirmError}` : p.message,
      }))

      let proofSubmissionError: string | null = null
      if (!confirmError) {
        for (const [provider, sessionId] of usedSessionsByProvider.entries()) {
          // `session-proof` forwarding currently relies on the local Gateway app.
          // Keep file download successful even when the local gateway is not running.
          try {
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
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (!proofSubmissionError) proofSubmissionError = msg
            console.warn('session-proof forwarding failed; download still succeeds', { provider, error: msg })
          }
        }
      }

      let payload = concatUint8Arrays(parts)
      if (shouldDecodeNilce) {
        try {
          const decoded = await decodeNilceV1(payload)
          if (decoded.wrapped) {
            payload = decoded.payload
          }
        } catch (err) {
          console.warn('NilCE decode failed, returning raw bytes', err)
        }
      }
      const blob = new Blob([payload] as BlobPart[], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      setDownloadUrl(url)

      const receiptPipelineError = [confirmError, proofSubmissionError].filter(Boolean).join('; ')
      if (receiptPipelineError) {
        setReceiptStatus('failed')
        setReceiptError(`Receipt pipeline failed (download succeeded): ${receiptPipelineError}`)
      } else {
        setReceiptStatus('submitted')
      }
      setProgress((p) => ({
        ...p,
        phase: 'done',
        receiptsSubmitted: receiptsSubmitted,
        message: receiptPipelineError ? `Download complete; receipt pipeline failed: ${receiptPipelineError}` : p.message,
      }))

      return { url, blob }
    } catch (e) {
      console.error(e)
      const walletError = classifyWalletError(e, 'Fetch failed')
      const errorMessage = walletError.message
      setProgress((p) => ({ ...p, phase: 'error', message: errorMessage }))
      setReceiptStatus('failed')
      setReceiptError(errorMessage)
      return null
    } finally {
      setLoading(false)
    }
  }

  return { fetchFile, loading, downloadUrl, receiptStatus, receiptError, progress }
}
