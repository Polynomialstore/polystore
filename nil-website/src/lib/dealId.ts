export function normalizeDealId(dealId: string): string {
  const trimmed = String(dealId ?? '').trim()
  if (!trimmed || trimmed === '0' || !/^\d+$/.test(trimmed)) {
    throw new Error('dealId must be a positive integer')
  }
  return trimmed
}

