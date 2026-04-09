export function multiaddrToHttpUrl(ep: string): string | null {
  const s = String(ep || '').trim()
  if (!s.startsWith('/')) return null

  const parts = s.split('/').filter(Boolean)
  const idxTcp = parts.findIndex((p) => p === 'tcp')
  if (idxTcp < 2 || idxTcp + 1 >= parts.length) return null

  const hostProto = parts[idxTcp - 2]
  const host = parts[idxTcp - 1]
  const port = parts[idxTcp + 1]
  if (!/^\d+$/.test(port)) return null

  const isHttp = parts.includes('http')
  const isHttps = parts.includes('https')
  if (!isHttp && !isHttps) return null

  if (!hostProto || !host) return null
  return `${isHttps ? 'https' : 'http'}://${host}:${port}`
}

export interface P2pTarget {
  multiaddr: string
  peerId: string
}

export function multiaddrToP2pTarget(ep: string): P2pTarget | null {
  const s = String(ep || '').trim()
  if (!s.startsWith('/')) return null

  const parts = s.split('/').filter(Boolean)
  const p2pIdx = parts.lastIndexOf('p2p')
  const ipfsIdx = parts.lastIndexOf('ipfs')
  const idx = p2pIdx >= 0 ? p2pIdx : ipfsIdx
  if (idx < 0 || idx + 1 >= parts.length) return null

  const peerId = parts[idx + 1]
  if (!peerId) return null

  const hasWs = parts.includes('ws') || parts.includes('wss')
  if (!hasWs) return null

  return { multiaddr: s, peerId }
}

export function multiaddrToP2pWsAddr(ep: string): string | null {
  const target = multiaddrToP2pTarget(ep)
  return target ? target.multiaddr : null
}
