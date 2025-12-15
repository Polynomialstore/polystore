import { useState } from 'react'
import { useAccount } from 'wagmi'
import { keccak256 } from 'viem'
import { appConfig } from '../config'
import {
  buildDownloadSessionReceiptTypedData,
  buildRetrievalReceiptTypedData,
  buildRetrievalRequestTypedData,
  DownloadSessionReceiptIntent,
  RetrievalReceiptIntent,
  RetrievalRequestIntent,
} from '../lib/eip712'
import { normalizeDealId } from '../lib/dealId'
import { bytesToHex, hexToBytes } from '../lib/merkle'
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

export function useFetch() {
  const { address } = useAccount()
  const [loading, setLoading] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [receiptStatus, setReceiptStatus] = useState<'idle' | 'submitted' | 'failed'>('idle')
  const [receiptError, setReceiptError] = useState<string | null>(null)

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
    } catch {}
    return trimmed
  }

  async function fetchFile(input: FetchInput) {
    setLoading(true)
    setDownloadUrl(null)
    setReceiptStatus('idle')
    setReceiptError(null)
    try {
      const dealId = normalizeDealId(input.dealId)
      const owner = String(input.owner ?? '').trim()
      if (!owner) {
        throw new Error('owner is required')
      }

      if (!address) {
        throw new Error('Connect a wallet to sign retrieval requests and receipts')
      }
      const ethereum = (window as any).ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const blobSizeBytes = Number(input.blobSizeBytes || 128 * 1024)
      const wantRangeStart = Number(input.rangeStart ?? 0)
      const wantRangeLen = Number(input.rangeLen ?? 0)
      const wantFileSize = typeof input.fileSizeBytes === 'number' ? Number(input.fileSizeBytes) : 0

      // For now, treat rangeLen=0 as "download to EOF", but still chunk and sign bounded receipts.
      // This requires knowing the file length.
      let effectiveRangeLen = wantRangeLen
      if (effectiveRangeLen === 0) {
        if (!wantFileSize) {
          throw new Error('fileSizeBytes is required for full downloads (rangeLen=0)')
        }
        if (wantRangeStart >= wantFileSize) {
          throw new Error('rangeStart beyond EOF')
        }
        effectiveRangeLen = wantFileSize - wantRangeStart
      }

      // Always derive receipt nonce from chain state to avoid local drift.
      let lastReceiptNonce = 0
      try {
        const nonceRes = await fetch(
          `${appConfig.lcdBase}/nilchain/nilchain/v1/deals/${encodeURIComponent(dealId)}/receipt-nonce?file_path=${encodeURIComponent(input.filePath)}`,
        )
        if (nonceRes.ok) {
          const json = await nonceRes.json()
          lastReceiptNonce = Number(json.last_nonce || 0) || 0
        }
      } catch (e) {
        console.warn('Failed to fetch receipt nonce, falling back to 0', e)
      }
      let nextReceiptNonce = lastReceiptNonce + 1

      const fetchParams = new URLSearchParams({
        deal_id: dealId,
        owner,
        file_path: input.filePath,
      })
      const fetchUrl = `${appConfig.gatewayBase}/gateway/fetch/${input.manifestRoot}?${fetchParams.toString()}`

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

      async function fetchOneRange(rangeStart: number, rangeLen: number): Promise<Uint8Array<ArrayBuffer>> {
        // 0) Sign Retrieval Request (authorizes the fetch; does NOT count as receipt)
        const expiresAt = Math.floor(Date.now() / 1000) + 120
        let reqNonce = 0
        try {
          const n = new Uint32Array(1)
          window.crypto.getRandomValues(n)
          reqNonce = Number(n[0] || 0)
        } catch {
          reqNonce = Math.floor(Math.random() * 0xffffffff)
        }
        if (!reqNonce) reqNonce = 1

        const reqIntent: RetrievalRequestIntent = {
          deal_id: Number(dealId),
          file_path: input.filePath,
          range_start: Number(rangeStart),
          range_len: Number(rangeLen),
          nonce: reqNonce,
          expires_at: expiresAt,
        }
        const reqTypedData = buildRetrievalRequestTypedData(reqIntent, appConfig.chainId)
        const reqSignature: string = await ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(reqTypedData)],
        })
        if (typeof reqSignature !== 'string' || !reqSignature.startsWith('0x') || reqSignature.length < 10) {
          throw new Error('wallet returned invalid request signature')
        }

        const reqHeaders: Record<string, string> = {
          'X-Nil-Req-Sig': reqSignature,
          'X-Nil-Req-Nonce': String(reqNonce),
          'X-Nil-Req-Expires-At': String(expiresAt),
          'X-Nil-Req-Range-Start': String(reqIntent.range_start),
          'X-Nil-Req-Range-Len': String(reqIntent.range_len),
        }
        if (reqIntent.range_len > 0) {
          reqHeaders['Range'] = `bytes=${reqIntent.range_start}-${reqIntent.range_start + reqIntent.range_len - 1}`
        }

        const response = await fetch(fetchUrl, { headers: reqHeaders })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(decodeHttpError(text) || `fetch failed (${response.status})`)
        }

        const hDealId = response.headers.get('X-Nil-Deal-ID')
        const hEpoch = response.headers.get('X-Nil-Epoch')
        const hProvider = response.headers.get('X-Nil-Provider')
        const hFilePath = response.headers.get('X-Nil-File-Path')
        const hRangeStart = response.headers.get('X-Nil-Range-Start')
        const hRangeLen = response.headers.get('X-Nil-Range-Len')
        const hBytes = response.headers.get('X-Nil-Bytes-Served')
        const hProofJson = response.headers.get('X-Nil-Proof-JSON')
        const hProofHash = response.headers.get('X-Nil-Proof-Hash')
        const hFetchSession = response.headers.get('X-Nil-Fetch-Session')

        const buf = new Uint8Array(await response.arrayBuffer())

        if (
          !hDealId ||
          !hEpoch ||
          !hProvider ||
          !hFilePath ||
          !hRangeStart ||
          !hRangeLen ||
          !hBytes ||
          !hProofHash ||
          !hFetchSession
        ) {
          setReceiptStatus('failed')
          setReceiptError('Gateway did not provide receipt headers; cannot submit retrieval receipt.')
          return buf
        }

        let proofDetails: any = null
        if (hProofJson) {
          try {
            const jsonStr = atob(hProofJson)
            const json = JSON.parse(jsonStr)
            if (json.proof_details) {
              proofDetails = json.proof_details
            }
          } catch (e) {
            console.warn('Failed to parse proof details', e)
          }
        }
        if (!proofDetails) {
          setReceiptStatus('failed')
          setReceiptError('Gateway did not provide proof_details; refusing to submit unsigned/unenforced receipt.')
          return buf
        }

        const bytesServed = Number(hBytes)
        const rStart = Number(hRangeStart)
        const rLen = Number(hRangeLen)
        const intent: RetrievalReceiptIntent = {
          deal_id: Number(hDealId),
          epoch_id: Number(hEpoch),
          provider: hProvider,
          file_path: hFilePath,
          range_start: rStart,
          range_len: rLen,
          bytes_served: bytesServed,
          nonce: nextReceiptNonce,
          expires_at: 0,
          proof_hash: hProofHash as `0x${string}`,
        }
        nextReceiptNonce += 1

        const typedData = buildRetrievalReceiptTypedData(intent, appConfig.chainId)
        const signature: string = await ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(typedData)],
        })
        if (typeof signature !== 'string' || !signature.startsWith('0x') || signature.length < 10) {
          throw new Error('wallet returned invalid signature')
        }
        const sigBytes = hexToBytes(signature)
        if (sigBytes.length !== 65) {
          throw new Error(`wallet returned invalid signature length: ${sigBytes.length}`)
        }
        const sigBase64 = bytesToBase64(sigBytes)

        const receiptPayload = {
          fetch_session: hFetchSession,
          receipt: {
            deal_id: intent.deal_id,
            epoch_id: intent.epoch_id,
            provider: intent.provider,
            file_path: intent.file_path,
            range_start: intent.range_start,
            range_len: intent.range_len,
            bytes_served: intent.bytes_served,
            nonce: intent.nonce,
            user_signature: sigBase64,
            proof_details: proofDetails,
            expires_at: 0,
          },
        }

        const submitRes = await fetch(`${appConfig.gatewayBase}/gateway/receipt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(receiptPayload),
        })
        if (!submitRes.ok) {
          const text = await submitRes.text()
          setReceiptStatus('failed')
          setReceiptError(text || `receipt submission failed (${submitRes.status})`)
        } else {
          setReceiptStatus('submitted')
          setReceiptError(null)
        }

        return buf
      }

      if (chunks.length <= 1) {
        const blobBytes = await fetchOneRange(chunks[0].rangeStart, chunks[0].rangeLen)
        const blob = new Blob([blobBytes], { type: 'application/octet-stream' })
        const url = window.URL.createObjectURL(blob)
        setDownloadUrl(url)
        return url
      }

      // Bundled receipt flow: sign once, fetch many chunks, then sign one DownloadSessionReceipt.
      const sessionExpiresAt = Math.floor(Date.now() / 1000) + 120
      const sessionReqNonce = randUint32()
      const sessionReqIntent: RetrievalRequestIntent = {
        deal_id: Number(dealId),
        file_path: input.filePath,
        range_start: wantRangeStart,
        range_len: effectiveRangeLen,
        nonce: sessionReqNonce,
        expires_at: sessionExpiresAt,
      }
      const sessionReqTyped = buildRetrievalRequestTypedData(sessionReqIntent, appConfig.chainId)
      const sessionReqSig: string = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(sessionReqTyped)],
      })
      if (typeof sessionReqSig !== 'string' || !sessionReqSig.startsWith('0x') || sessionReqSig.length < 10) {
        throw new Error('wallet returned invalid request signature')
      }

      const openParams = new URLSearchParams({
        deal_id: dealId,
        owner,
        file_path: input.filePath,
      })
      const openUrl = `${appConfig.gatewayBase}/gateway/open-session/${input.manifestRoot}?${openParams.toString()}`
      const openRes = await fetch(openUrl, {
        method: 'POST',
        headers: {
          'X-Nil-Req-Sig': sessionReqSig,
          'X-Nil-Req-Nonce': String(sessionReqNonce),
          'X-Nil-Req-Expires-At': String(sessionExpiresAt),
          'X-Nil-Req-Range-Start': String(sessionReqIntent.range_start),
          'X-Nil-Req-Range-Len': String(sessionReqIntent.range_len),
        },
      })
      if (!openRes.ok) {
        const text = await openRes.text().catch(() => '')
        throw new Error(decodeHttpError(text) || `failed to open download session (${openRes.status})`)
      }
      const openJson = await openRes.json()
      const downloadSession = String(openJson.download_session || '')
      const epochId = Number(openJson.epoch_id || 0)
      const provider = String(openJson.provider || '')
      if (!downloadSession) throw new Error('gateway did not return download_session')
      if (!epochId) throw new Error('gateway did not return epoch_id')
      if (!provider) throw new Error('gateway did not return provider')

      const parts: Uint8Array<ArrayBuffer>[] = []
      const leaves: Uint8Array[] = []
      let totalBytes = 0

      for (const c of chunks) {
        const end = c.rangeStart + c.rangeLen - 1
        const res = await fetch(fetchUrl, {
          headers: {
            Range: `bytes=${c.rangeStart}-${end}`,
            'X-Nil-Download-Session': downloadSession,
          },
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(decodeHttpError(text) || `fetch failed (${res.status})`)
        }

        const hProofHash = res.headers.get('X-Nil-Proof-Hash')
        const hChunkStart = Number(res.headers.get('X-Nil-Range-Start') || c.rangeStart)
        const hChunkLen = Number(res.headers.get('X-Nil-Range-Len') || 0)
        const hProvider = res.headers.get('X-Nil-Provider') || provider
        if (hProvider !== provider) {
          throw new Error(`provider mismatch during session: expected ${provider} got ${hProvider}`)
        }
        if (!hProofHash) {
          throw new Error('missing proof hash for session chunk')
        }

        const buf = new Uint8Array(await res.arrayBuffer())
        parts.push(buf)

        const servedLen = hChunkLen || buf.byteLength
        if (hChunkLen && hChunkLen !== buf.byteLength) {
          throw new Error(`chunk length mismatch: header=${hChunkLen} body=${buf.byteLength}`)
        }
        totalBytes += servedLen
        leaves.push(hashSessionLeafBytes(hChunkStart, servedLen, hProofHash))
      }

      const rootBytes = keccakMerkleRootBytes(leaves)
      const rootHex = bytesToHex(rootBytes)

      const sessionReceiptIntent: DownloadSessionReceiptIntent = {
        deal_id: Number(dealId),
        epoch_id: epochId,
        provider,
        file_path: input.filePath,
        total_bytes: totalBytes,
        chunk_count: leaves.length,
        chunk_leaf_root: rootHex as `0x${string}`,
        nonce: nextReceiptNonce,
        expires_at: 0,
      }
      const sessionTyped = buildDownloadSessionReceiptTypedData(sessionReceiptIntent, appConfig.chainId)
      const sessionSig: string = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(sessionTyped)],
      })
      if (typeof sessionSig !== 'string' || !sessionSig.startsWith('0x') || sessionSig.length < 10) {
        throw new Error('wallet returned invalid session signature')
      }

      const submitPayload = {
        download_session: downloadSession,
        receipt: {
          deal_id: sessionReceiptIntent.deal_id,
          epoch_id: sessionReceiptIntent.epoch_id,
          provider: sessionReceiptIntent.provider,
          file_path: sessionReceiptIntent.file_path,
          total_bytes: sessionReceiptIntent.total_bytes,
          chunk_count: sessionReceiptIntent.chunk_count,
          chunk_leaf_root: bytesToBase64(rootBytes),
          user_signature: bytesToBase64(hexToBytes(sessionSig)),
          nonce: sessionReceiptIntent.nonce,
          expires_at: 0,
        },
      }

      const submitRes = await fetch(`${appConfig.gatewayBase}/gateway/session-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitPayload),
      })
      if (!submitRes.ok) {
        const text = await submitRes.text().catch(() => '')
        setReceiptStatus('failed')
        setReceiptError(decodeHttpError(text) || `session receipt submission failed (${submitRes.status})`)
      } else {
        setReceiptStatus('submitted')
        setReceiptError(null)
      }

      const full = new Blob(parts, { type: 'application/octet-stream' })
      const url = window.URL.createObjectURL(full)
      setDownloadUrl(url)
      return url
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setReceiptStatus('failed')
      setReceiptError(msg)
      return null
    } finally {
      setLoading(false)
    }
  }

  return { fetchFile, loading, downloadUrl, receiptStatus, receiptError }
}

function randUint32(): number {
  try {
    const n = new Uint32Array(1)
    window.crypto.getRandomValues(n)
    return Number(n[0] || 0) || 1
  } catch {
    return Math.floor(Math.random() * 0xffffffff) || 1
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return window.btoa(binary)
}

function u64beBytes(n: number): Uint8Array {
  if (!Number.isFinite(n) || n < 0) throw new Error('uint64 must be >= 0')
  const x = BigInt(Math.floor(n))
  const out = new Uint8Array(8)
  let v = x
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function hashSessionLeafBytes(rangeStart: number, rangeLen: number, proofHashHex: string): Uint8Array {
  const proofHashBytes = hexToBytes(proofHashHex)
  if (proofHashBytes.length !== 32) {
    throw new Error(`invalid proof_hash length: ${proofHashBytes.length}`)
  }
  const buf = new Uint8Array(8 + 8 + 32)
  buf.set(u64beBytes(rangeStart), 0)
  buf.set(u64beBytes(rangeLen), 8)
  buf.set(proofHashBytes, 16)
  return hexToBytes(keccak256(buf))
}

function keccakMerkleRootBytes(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error('empty leaf set')
  if (leaves.length === 1) {
    return hexToBytes(keccak256(concatBytes(leaves[0], leaves[0])))
  }

  let level = leaves.slice()
  while (level.length > 1) {
    if (level.length % 2 === 1) {
      level = [...level, level[level.length - 1]]
    }

    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(hexToBytes(keccak256(concatBytes(level[i], level[i + 1]))))
    }
    level = next
  }

  return level[0]
}
