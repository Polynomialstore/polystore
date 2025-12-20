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

export function multiaddrToP2pWsAddr(ep: string): string | null {
  const s = String(ep || '').trim()
  if (!s.startsWith('/')) return null
  if (!s.includes('/p2p/')) return null

  const parts = s.split('/').filter(Boolean)
  const hasWs = parts.includes('ws') || parts.includes('wss')
  if (!hasWs) return null

  return s
}
