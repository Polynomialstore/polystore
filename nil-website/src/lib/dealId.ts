export function normalizeDealId(dealId: string): string {
  const trimmed = String(dealId ?? '').trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    throw new Error('dealId must be a non-negative integer')
  }
  return trimmed
}