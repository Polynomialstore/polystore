import { appConfig } from '../config'

interface GatewayStatusPayload {
  p2p_addrs?: unknown
}

let cachedP2PAddrs: { expiresAt: number; addrs: string[] } | null = null

function normalizeBase(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/$/, '')
}

function readP2pAddrs(payload: GatewayStatusPayload | null): string[] {
  const raw = payload?.p2p_addrs
  if (!Array.isArray(raw)) return []
  return raw.map((v) => String(v || '').trim()).filter((v) => v.length > 0)
}

export async function fetchGatewayP2pAddrs(baseUrl: string): Promise<string[]> {
  if (!appConfig.p2pEnabled) return []
  const base = normalizeBase(baseUrl)
  if (!base) return []
  if (cachedP2PAddrs && Date.now() < cachedP2PAddrs.expiresAt) {
    return cachedP2PAddrs.addrs
  }

  try {
    const res = await fetch(`${base}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return []
    const payload = (await res.json().catch(() => null)) as GatewayStatusPayload | null
    const addrs = readP2pAddrs(payload)
    cachedP2PAddrs = { expiresAt: Date.now() + 15_000, addrs }
    return addrs
  } catch (e) {
    return []
  }
}
