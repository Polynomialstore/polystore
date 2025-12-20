import { appConfig } from '../config'
import type { P2pTarget } from './multiaddr'
import { fromString as uint8FromString, toString as uint8ToString } from 'uint8arrays'

interface P2pWireRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body_base64?: string
}

interface P2pWireResponse {
  status: number
  headers?: Record<string, string>
  body_base64?: string
}

export interface P2pRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: Uint8Array | string
}

export interface P2pResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

let clientPromise: Promise<import('libp2p').Libp2p> | null = null

async function createClient(): Promise<import('libp2p').Libp2p> {
  if (!appConfig.p2pEnabled) {
    throw new Error('libp2p transport is disabled')
  }

  const [{ createLibp2p }, { webSockets }, { noise }, { mplex }, { createEd25519PeerId }] = await Promise.all([
    import('libp2p'),
    import('@libp2p/websockets'),
    import('@chainsafe/libp2p-noise'),
    import('@libp2p/mplex'),
    import('@libp2p/peer-id-factory'),
  ])

  const peerId = await createEd25519PeerId()
  const bootstrapList = appConfig.p2pBootstrap
  const peerDiscovery = [] as unknown[]

  if (bootstrapList.length > 0) {
    const { bootstrap } = await import('@libp2p/bootstrap')
    peerDiscovery.push(bootstrap({ list: bootstrapList }))
  }

  const node = await createLibp2p({
    peerId,
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [mplex()],
    peerDiscovery,
    connectionManager: {
      autoDial: false,
    },
  })

  await node.start()
  return node
}

async function getClient(): Promise<import('libp2p').Libp2p> {
  if (!clientPromise) {
    clientPromise = createClient()
  }
  return clientPromise
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = String(value)
  }
  return out
}

function encodeBody(body?: Uint8Array | string): string | undefined {
  if (!body) return undefined
  const bytes = typeof body === 'string' ? uint8FromString(body) : body
  return uint8ToString(bytes, 'base64')
}

function decodeBody(bodyBase64?: string): Uint8Array {
  if (!bodyBase64) return new Uint8Array()
  return uint8FromString(bodyBase64, 'base64')
}

async function readSingleMessage(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  for await (const msg of source) {
    return msg
  }
  return new Uint8Array()
}

export async function p2pRequest(target: P2pTarget, req: P2pRequest, signal?: AbortSignal): Promise<P2pResponse> {
  if (!appConfig.p2pEnabled) {
    throw new Error('libp2p transport is disabled')
  }
  if (signal?.aborted) {
    throw new Error('Request aborted')
  }

  const client = await getClient()
  const { multiaddr } = await import('@multiformats/multiaddr')
  const { pipe } = await import('it-pipe')
  const lp = await import('it-length-prefixed')

  const request: P2pWireRequest = {
    method: req.method,
    path: req.path,
    headers: normalizeHeaders(req.headers),
    body_base64: encodeBody(req.body),
  }

  const payload = uint8FromString(JSON.stringify(request))

  const operation = async (): Promise<P2pResponse> => {
    const stream = await client.dialProtocol(multiaddr(target.multiaddr), appConfig.p2pProtocol)

    await pipe([payload], lp.encode(), stream.sink)

    const responseBytes = await pipe(stream.source, lp.decode(), readSingleMessage)
    const responseJson = JSON.parse(uint8ToString(responseBytes)) as P2pWireResponse
    if (!responseJson || typeof responseJson.status !== 'number') {
      throw new Error('Invalid libp2p response')
    }
    return {
      status: responseJson.status,
      headers: normalizeHeaders(responseJson.headers),
      body: decodeBody(responseJson.body_base64),
    }
  }

  if (!signal) {
    return operation()
  }

  return new Promise<P2pResponse>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Error('Request aborted'))
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort)
    operation()
      .then((res) => {
        cleanup()
        resolve(res)
      })
      .catch((err) => {
        cleanup()
        reject(err)
      })
  })
}

export async function p2pRequestJson<T>(
  target: P2pTarget,
  req: P2pRequest,
  signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; json: T | null; text: string }> {
  const response = await p2pRequest(target, req, signal)
  const text = uint8ToString(response.body)
  let json: T | null = null
  if (text.trim()) {
    try {
      json = JSON.parse(text) as T
    } catch (err) {
      void err
    }
  }
  return { status: response.status, headers: response.headers, json, text }
}
