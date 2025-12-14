// Shared EIP-712 intent definitions for NilStore.
// This file is the single source of truth for typed-data shapes used by
// MetaMask signing, gateway payloads, and parity tests.

export const EIP712_DOMAIN_NAME = 'NilStore' as const
export const EIP712_DOMAIN_VERSION = '1' as const
export const EIP712_VERIFYING_CONTRACT =
  '0x0000000000000000000000000000000000000000' as const

export const EIP712DomainTypes = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

export const CreateDealTypes = {
  EIP712Domain: EIP712DomainTypes,
  CreateDeal: [
    { name: 'creator', type: 'address' },
    { name: 'duration', type: 'uint64' },
    { name: 'service_hint', type: 'string' },
    // Amount fields are signed as strings for chain compatibility.
    { name: 'initial_escrow', type: 'string' },
    { name: 'max_monthly_spend', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const

export const UpdateContentTypes = {
  EIP712Domain: EIP712DomainTypes,
  UpdateContent: [
    { name: 'creator', type: 'address' },
    { name: 'deal_id', type: 'uint64' },
    { name: 'cid', type: 'string' },
    { name: 'size', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const

export interface CreateDealIntent {
  creator_evm: string
  duration_blocks: number
  service_hint: string
  initial_escrow: string
  max_monthly_spend: string
  nonce: number
}

export interface UpdateContentIntent {
  creator_evm: string
  deal_id: number
  cid: string
  size_bytes: number
  nonce: number
}

export function buildCreateDealTypedData(intent: CreateDealIntent, chainId: number) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: EIP712_VERIFYING_CONTRACT,
    },
    types: CreateDealTypes,
    primaryType: 'CreateDeal' as const,
    message: {
      creator: intent.creator_evm,
      duration: Number(intent.duration_blocks),
      service_hint: intent.service_hint,
      initial_escrow: intent.initial_escrow,
      max_monthly_spend: intent.max_monthly_spend,
      nonce: Number(intent.nonce),
    },
  }
}

export function buildUpdateContentTypedData(intent: UpdateContentIntent, chainId: number) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: EIP712_VERIFYING_CONTRACT,
    },
    types: UpdateContentTypes,
    primaryType: 'UpdateContent' as const,
    message: {
      creator: intent.creator_evm,
      deal_id: Number(intent.deal_id),
      cid: intent.cid,
      size: Number(intent.size_bytes),
      nonce: Number(intent.nonce),
    },
  }
}

export const RetrievalReceiptTypes = {
  EIP712Domain: EIP712DomainTypes,
  RetrievalReceipt: [
    { name: 'deal_id', type: 'uint64' },
    { name: 'epoch_id', type: 'uint64' },
    { name: 'provider', type: 'string' },
    { name: 'bytes_served', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expires_at', type: 'uint64' },
    { name: 'proof_hash', type: 'bytes32' },
  ],
} as const

export const RetrievalRequestTypes = {
  EIP712Domain: EIP712DomainTypes,
  RetrievalRequest: [
    { name: 'deal_id', type: 'uint64' },
    { name: 'file_path', type: 'string' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expires_at', type: 'uint64' },
  ],
} as const

export interface RetrievalReceiptIntent {
  deal_id: number
  epoch_id: number
  provider: string
  bytes_served: number
  nonce: number
  expires_at: number
  proof_hash: `0x${string}`
}

export interface RetrievalRequestIntent {
  deal_id: number
  file_path: string
  nonce: number
  expires_at: number
}

export function buildRetrievalRequestTypedData(intent: RetrievalRequestIntent, chainId: number) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: EIP712_VERIFYING_CONTRACT,
    },
    types: RetrievalRequestTypes,
    primaryType: 'RetrievalRequest' as const,
    message: {
      deal_id: Number(intent.deal_id),
      file_path: intent.file_path,
      nonce: Number(intent.nonce),
      expires_at: Number(intent.expires_at),
    },
  }
}

export function buildRetrievalReceiptTypedData(intent: RetrievalReceiptIntent, chainId: number) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: EIP712_VERIFYING_CONTRACT,
    },
    types: RetrievalReceiptTypes,
    primaryType: 'RetrievalReceipt' as const,
    message: {
      deal_id: Number(intent.deal_id),
      epoch_id: Number(intent.epoch_id),
      provider: intent.provider,
      bytes_served: Number(intent.bytes_served),
      nonce: Number(intent.nonce),
      expires_at: Number(intent.expires_at),
      proof_hash: intent.proof_hash,
    },
  }
}
