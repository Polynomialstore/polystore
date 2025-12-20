import { createLibp2p } from 'libp2p'
import type { Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr } from '@multiformats/multiaddr'
import { Uint8ArrayList } from 'uint8arraylist'

const P2P_PROTOCOL = '/nilstore/fetch/1.0.0'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export interface Libp2pFetchRequest {
  manifestRoot: string
  dealId: string
  owner: string
  filePath: string
  rangeStart: number
  rangeLen: number
  sessionId?: string
  downloadSession?: string
}

export interface Libp2pFetchResult {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  error?: string
}

let nodePromise: Promise<Libp2p> | null = null

async function getLibp2pNode(): Promise<Libp2p> {
  if (!nodePromise) {
    nodePromise = createLibp2p({
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
    })
  }
  return nodePromise
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function readAll(source: AsyncIterable<Uint8Array | Uint8ArrayList>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    const view = chunk instanceof Uint8Array ? chunk : chunk.subarray()
    total += view.length
    if (total > maxBytes) {
      throw new Error(`libp2p response too large (${total} bytes)`)
    }
    chunks.push(view)
  }
  return concatChunks(chunks, total)
}

function parseResponse(bytes: Uint8Array): Libp2pFetchResult {
  if (bytes.length < 4) {
    throw new Error('libp2p response too short')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLen = view.getUint32(0, false)
  if (headerLen === 0 || headerLen > bytes.length - 4) {
    throw new Error(`invalid libp2p header length: ${headerLen}`)
  }
  const headerStart = 4
  const headerEnd = headerStart + headerLen
  const headerText = new TextDecoder().decode(bytes.subarray(headerStart, headerEnd))
  const header = JSON.parse(headerText) as {
    status: number
    error?: string
    headers?: Record<string, string>
    body_len?: number
  }
  const bodyLen = Number(header.body_len ?? 0)
  const bodyStart = headerEnd
  const bodyEnd = bodyStart + bodyLen
  if (bodyEnd > bytes.length) {
    throw new Error(`libp2p response body truncated (${bodyLen} bytes)`)
  }
  return {
    status: header.status,
    error: header.error,
    headers: header.headers ?? {},
    body: bytes.subarray(bodyStart, bodyEnd),
  }
}

function abortable<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    const err = typeof DOMException === 'undefined'
      ? Object.assign(new Error('Aborted'), { name: 'AbortError' })
      : new DOMException('Aborted', 'AbortError')
    return Promise.reject(err)
  }
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const err = typeof DOMException === 'undefined'
        ? Object.assign(new Error('Aborted'), { name: 'AbortError' })
        : new DOMException('Aborted', 'AbortError')
      signal.addEventListener('abort', () => reject(err), { once: true })
    }),
  ])
}

export async function libp2pFetchRange(
  addr: string,
  req: Libp2pFetchRequest,
  signal?: AbortSignal,
): Promise<Libp2pFetchResult> {
  const node = await getLibp2pNode()
  const stream = await abortable(signal, node.dialProtocol(multiaddr(addr), P2P_PROTOCOL))

  const payload = {
    manifest_root: req.manifestRoot,
    deal_id: Number(req.dealId),
    owner: req.owner,
    file_path: req.filePath,
    range_start: req.rangeStart,
    range_len: req.rangeLen,
    onchain_session: req.sessionId,
    download_session: req.downloadSession,
  }
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  stream.send(encoded)
  await abortable(signal, stream.close())

  const bytes = await abortable(signal, readAll(stream, MAX_RESPONSE_BYTES))
  const parsed = parseResponse(bytes)
  return parsed
}
