export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
};

export type CreateDealIntent = {
  creator: string;
  duration: bigint;
  service_hint: string;
  initial_escrow: string;
  max_monthly_spend: string;
  nonce: bigint;
};

export type UpdateContentIntent = {
  creator: string;
  deal_id: bigint;
  previous_manifest_root: string;
  cid: string;
  size: bigint;
  total_mdus: bigint;
  witness_mdus: bigint;
  nonce: bigint;
};

export type TypedDataPayload = {
  domain: Eip712Domain;
  primaryType: string;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, string>;
};

const DOMAIN_NAME = "PolyStore";
const DOMAIN_VERSION = "1";
const VERIFYING_CONTRACT =
  "0x0000000000000000000000000000000000000000";

const domainType = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const createDealType = [
  { name: "creator", type: "address" },
  { name: "duration", type: "uint64" },
  { name: "service_hint", type: "string" },
  { name: "initial_escrow", type: "string" },
  { name: "max_monthly_spend", type: "string" },
  { name: "nonce", type: "uint64" },
];

const updateContentType = [
  { name: "creator", type: "address" },
  { name: "deal_id", type: "uint64" },
  { name: "previous_manifest_root", type: "string" },
  { name: "cid", type: "string" },
  { name: "size", type: "uint64" },
  { name: "total_mdus", type: "uint64" },
  { name: "witness_mdus", type: "uint64" },
  { name: "nonce", type: "uint64" },
];

export function buildDomain(chainId: number): Eip712Domain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: VERIFYING_CONTRACT,
  };
}

export function normalizeEvmAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("0x")) {
    return trimmed;
  }
  return `0x${trimmed}`;
}

export function buildCreateDealTypedData(
  intent: CreateDealIntent,
  chainId: number,
): TypedDataPayload {
  return {
    domain: buildDomain(chainId),
    primaryType: "CreateDeal",
    types: {
      EIP712Domain: domainType,
      CreateDeal: createDealType,
    },
    message: {
      creator: normalizeEvmAddress(intent.creator),
      duration: intent.duration.toString(),
      service_hint: intent.service_hint,
      initial_escrow: intent.initial_escrow,
      max_monthly_spend: intent.max_monthly_spend,
      nonce: intent.nonce.toString(),
    },
  };
}

export function buildUpdateContentTypedData(
  intent: UpdateContentIntent,
  chainId: number,
): TypedDataPayload {
  return {
    domain: buildDomain(chainId),
    primaryType: "UpdateContent",
    types: {
      EIP712Domain: domainType,
      UpdateContent: updateContentType,
    },
    message: {
      creator: normalizeEvmAddress(intent.creator),
      deal_id: intent.deal_id.toString(),
      previous_manifest_root: intent.previous_manifest_root,
      cid: intent.cid,
      size: intent.size.toString(),
      total_mdus: intent.total_mdus.toString(),
      witness_mdus: intent.witness_mdus.toString(),
      nonce: intent.nonce.toString(),
    },
  };
}
