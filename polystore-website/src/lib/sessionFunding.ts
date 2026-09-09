export type FundingStatus = 'checking' | 'funded' | 'unfunded' | 'unavailable'

function positive(value: bigint | string | number | null | undefined): boolean {
  if (value == null || value === '') return false
  try {
    return BigInt(value) > 0n
  } catch {
    return false
  }
}

export function resolveFundingStatus(input: {
  lcdLoaded: boolean
  lcdAmount: string | null
  lcdUnavailable: boolean
  evmAmount?: bigint | null
}): FundingStatus {
  if (input.lcdLoaded && positive(input.lcdAmount)) return 'funded'
  if (positive(input.evmAmount)) return 'funded'
  if (input.lcdUnavailable) return 'unavailable'
  if (input.lcdLoaded) return 'unfunded'
  return 'checking'
}

export function parseStakeBalancePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('invalid balance response')
  const balances = (payload as { balances?: unknown }).balances
  if (!Array.isArray(balances)) throw new Error('invalid balance response')
  const match = balances.find((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const denom = (entry as { denom?: unknown }).denom
    return denom === 'stake' || denom === 'aatom'
  }) as { amount?: unknown } | undefined
  if (!match) return '0'
  if (typeof match.amount !== 'string' || !/^\d+$/.test(match.amount)) throw new Error('invalid balance amount')
  return match.amount
}
