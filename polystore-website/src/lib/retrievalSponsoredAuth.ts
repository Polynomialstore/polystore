import type { Hex } from 'viem'

export interface VoucherAuthInput {
  provider?: string
  expiresAt?: number
  nonce: number
  redeemer?: string
  signature: Hex
}

export type SponsoredRetrievalAuth =
  | { type: 'none'; maxTotalFee?: bigint }
  | { type: 'allowlist'; leafIndex: number; merklePath: Hex[]; maxTotalFee?: bigint }
  | { type: 'voucher'; voucher: VoucherAuthInput; maxTotalFee?: bigint }

export function sponsoredRetrievalFeeCap(value: string): bigint | undefined {
  const text = value.trim()
  if (!text) return undefined
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error('maximum retrieval fee must be a positive integer in stake base units')
  const fee = BigInt(text)
  if (fee >= 1n << 256n) throw new Error('maximum retrieval fee exceeds uint256')
  return fee
}

export function withSponsoredRetrievalFeeCap(auth: SponsoredRetrievalAuth, value: string): SponsoredRetrievalAuth {
  return { ...auth, maxTotalFee: sponsoredRetrievalFeeCap(value) }
}

export function restoreSponsoredRetrievalAuth(raw: string): { auth: SponsoredRetrievalAuth; feeCap: string } {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (!parsed || !['none', 'allowlist', 'voucher'].includes(String(parsed.type))) throw new Error('invalid retrieval authorization')
  if (parsed.maxTotalFee !== undefined && typeof parsed.maxTotalFee !== 'string') throw new Error('invalid maximum retrieval fee')
  const feeCap = parsed.maxTotalFee ?? ''
  const maxTotalFee = sponsoredRetrievalFeeCap(feeCap)
  if (parsed.type === 'allowlist' && (!Number.isSafeInteger(parsed.leafIndex) || !Array.isArray(parsed.merklePath))) throw new Error('invalid allowlist retrieval authorization')
  if (parsed.type === 'voucher' && (!parsed.voucher || typeof parsed.voucher !== 'object')) throw new Error('invalid voucher retrieval authorization')
  return { auth: { ...parsed, maxTotalFee } as SponsoredRetrievalAuth, feeCap }
}
