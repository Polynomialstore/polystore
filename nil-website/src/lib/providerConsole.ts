import type { LcdProvider, LcdProviderPairing } from '../domain/lcd'
import { extractProviderHttpBases } from './spDashboard'

export interface OperatorProviderRecord {
  provider: string
  operator: string
  pairedHeight: number
  pairedHeightRaw: string
  endpoints: string[]
  httpBases: string[]
  primaryBase: string | null
  registryStatus: string
  registered: boolean
}

function parseHeight(input: string): number {
  const value = Number(input)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

export function buildOperatorProviderRecords(
  pairings: LcdProviderPairing[],
  providers: LcdProvider[],
): OperatorProviderRecord[] {
  const providersByAddress = new Map(providers.map((provider) => [provider.address, provider]))

  return [...pairings]
    .map((pairing) => {
      const provider = providersByAddress.get(pairing.provider)
      const endpoints = Array.isArray(provider?.endpoints) ? provider!.endpoints! : []
      const httpBases = extractProviderHttpBases(endpoints)

      return {
        provider: pairing.provider,
        operator: pairing.operator,
        pairedHeight: parseHeight(pairing.paired_height),
        pairedHeightRaw: pairing.paired_height,
        endpoints,
        httpBases,
        primaryBase: httpBases[0] || null,
        registryStatus: String(provider?.status || '').trim(),
        registered: Boolean(provider),
      }
    })
    .sort((a, b) => {
      if (b.pairedHeight !== a.pairedHeight) return b.pairedHeight - a.pairedHeight
      return a.provider.localeCompare(b.provider)
    })
}

export function findOperatorProviderRecord(
  records: OperatorProviderRecord[],
  providerAddress: string,
): OperatorProviderRecord | null {
  const normalized = String(providerAddress || '').trim()
  if (!normalized) return null
  return records.find((record) => record.provider === normalized) ?? null
}

export function buildProviderRegisterCommand(input: {
  providerKey?: string
  providerEndpoint?: string | null
}): string {
  const providerKey = String(input.providerKey || '').trim() || 'provider1'
  const providerEndpoint = String(input.providerEndpoint || '').trim() || '<new-provider-endpoint>'

  return [
    `PROVIDER_KEY='${providerKey.replace(/'/g, `'\\''`)}' \\`,
    `PROVIDER_ENDPOINT='${providerEndpoint.replace(/'/g, `'\\''`)}' \\`,
    './scripts/run_devnet_provider.sh register',
  ].join('\n')
}
