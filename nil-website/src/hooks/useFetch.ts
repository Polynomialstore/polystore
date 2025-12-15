import { useState } from 'react'
import { useAccount } from 'wagmi'
import { encodeFunctionData, numberToHex, toHex, type Hex } from 'viem'

import { appConfig } from '../config'
import { normalizeDealId } from '../lib/dealId'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { planNilfsFileRangeChunks } from '../lib/rangeChunker'

export interface FetchInput {
  dealId: string
  manifestRoot: string
  owner: string
  filePath: string
  rangeStart?: number
  rangeLen?: number
  fileStartOffset?: number
  fileSizeBytes?: number
  mduSizeBytes?: number
  blobSizeBytes?: number
}

export type FetchPhase = 'idle' | 'fetching' | 'submitting_proof_tx' | 'done' | 'error'

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

type ProofDetailsJson = {
  mdu_index: number
  mdu_root_fr: string
  manifest_opening: string
  blob_commitment: string
  merkle_path: string[]
  blob_index: number
  z_value: string
  y_value: string
  kzg_opening_proof: string
}

type ProofChunk = {
  rangeStart: bigint
  rangeLen: bigint
  proof: {
    mduIndex: bigint
    mduRootFr: Hex
    manifestOpening: Hex
    blobCommitment: Hex
    merklePath: Hex[]
    blobIndex: number
    zValue: Hex
    yValue: Hex
    kzgOpeningProof: Hex
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(String(b64 || ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64ToHex(b64: string): Hex {
  return toHex(base64ToBytes(b64)) as Hex
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

  async function fetchFile(input: FetchInput): Promise<string | null> {
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

      setProgress((p) => ({
        ...p,
        phase: 'fetching',
        filePath,
        chunkCount: chunks.length,
        bytesTotal: effectiveRangeLen,
        receiptsTotal: 1,
      }))

      const fetchParams = new URLSearchParams({ deal_id: dealId, owner, file_path: filePath })
      const fetchUrl = `${appConfig.gatewayBase}/gateway/fetch/${input.manifestRoot}?${fetchParams.toString()}`

      const parts: Uint8Array[] = []
      const proofChunks: ProofChunk[] = []
      let bytesFetched = 0
      let provider: string | null = null

      for (let idx = 0; idx < chunks.length; idx++) {
        const c = chunks[idx]
        const end = c.rangeStart + c.rangeLen - 1

        const res = await fetch(fetchUrl, { headers: { Range: `bytes=${c.rangeStart}-${end}` } })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(decodeHttpError(text) || `fetch failed (${res.status})`)
        }

        const hProvider = String(res.headers.get('X-Nil-Provider') || '')
        const hProofJson = String(res.headers.get('X-Nil-Proof-JSON') || '')
        const hRangeStart = Number(res.headers.get('X-Nil-Range-Start') || c.rangeStart)
        const hRangeLen = Number(res.headers.get('X-Nil-Range-Len') || c.rangeLen)

        if (!hProvider) throw new Error('gateway did not provide X-Nil-Provider')
        if (!hProofJson) throw new Error('gateway did not provide X-Nil-Proof-JSON')
        if (!provider) provider = hProvider
        if (provider !== hProvider) throw new Error(`provider mismatch during download: ${provider} vs ${hProvider}`)

        const buf = new Uint8Array(await res.arrayBuffer())
        parts.push(buf)
        bytesFetched += buf.byteLength

        let proofDetails: ProofDetailsJson | null = null
        try {
          const jsonStr = atob(hProofJson)
          const wrapper = JSON.parse(jsonStr) as { proof_details?: ProofDetailsJson }
          proofDetails = wrapper.proof_details || null
        } catch (e) {
          void e
        }
        if (!proofDetails) throw new Error('failed to parse proof_details from X-Nil-Proof-JSON')

        proofChunks.push({
          rangeStart: BigInt(hRangeStart),
          rangeLen: BigInt(hRangeLen),
          proof: {
            mduIndex: BigInt(proofDetails.mdu_index),
            mduRootFr: base64ToHex(proofDetails.mdu_root_fr),
            manifestOpening: base64ToHex(proofDetails.manifest_opening),
            blobCommitment: base64ToHex(proofDetails.blob_commitment),
            merklePath: (proofDetails.merkle_path || []).map(base64ToHex),
            blobIndex: Number(proofDetails.blob_index || 0),
            zValue: base64ToHex(proofDetails.z_value),
            yValue: base64ToHex(proofDetails.y_value),
            kzgOpeningProof: base64ToHex(proofDetails.kzg_opening_proof),
          },
        })

        setProgress((p) => ({
          ...p,
          phase: 'fetching',
          chunksFetched: Math.min(p.chunkCount || chunks.length, idx + 1),
          bytesFetched: Math.min(p.bytesTotal || bytesFetched, bytesFetched),
        }))
      }

      const blob = new Blob(parts, { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      setDownloadUrl(url)

      if (!provider) throw new Error('provider missing after download')

      try {
        setProgress((p) => ({ ...p, phase: 'submitting_proof_tx', receiptsSubmitted: 0, receiptsTotal: 1 }))

        // Fetch next nonce from chain state.
        let lastReceiptNonce = 0
        try {
          const nonceRes = await fetch(
            `${appConfig.lcdBase}/nilchain/nilchain/v1/deals/${encodeURIComponent(dealId)}/receipt-nonce?file_path=${encodeURIComponent(
              filePath,
            )}`,
          )
          if (nonceRes.ok) {
            const json = await nonceRes.json()
            lastReceiptNonce = Number(json.last_nonce || 0) || 0
          }
        } catch (e) {
          void e
        }
        const nextNonce = lastReceiptNonce + 1

        const txData = encodeFunctionData({
          abi: NILSTORE_PRECOMPILE_ABI,
          functionName: 'proveRetrievalBatch',
          args: [BigInt(dealId), provider, filePath, BigInt(nextNonce), proofChunks],
        })

        const txHash = (await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from: address, to: appConfig.nilstorePrecompile, data: txData, gas: numberToHex(25_000_000) }],
        })) as Hex

        await waitForTransactionReceipt(txHash as Hex)

        setReceiptStatus('submitted')
        setProgress((p) => ({ ...p, phase: 'done', receiptsSubmitted: 1, receiptsTotal: 1 }))
      } catch (e) {
        console.error(e)
        setProgress((p) => ({ ...p, phase: 'error', message: (e as Error).message }))
        setReceiptStatus('failed')
        setReceiptError((e as Error).message)
      }

      return url
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
