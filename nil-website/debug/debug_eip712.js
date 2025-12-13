import { hashTypedData, keccak256, toBytes, encodeAbiParameters, parseAbiParameters, concat } from 'viem'

function hexToBytes(hex) {
    return toBytes(hex)
}

const domain = {
  name: 'NilStore',
  version: '1',
  chainId: 31337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
}

const types = {
  CreateDeal: [
    { name: 'creator', type: 'address' },
    { name: 'duration', type: 'uint64' },
    { name: 'service_hint', type: 'string' },
    { name: 'initial_escrow', type: 'string' },
    { name: 'max_monthly_spend', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
}

// VALUES FROM LOG
const message = {
  creator: '0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2',
  duration: 100n,
  service_hint: 'General:replicas=1',
  initial_escrow: '1000000',
  max_monthly_spend: '5000000',
  nonce: 13n, // Updated from log
}

const digestViem = hashTypedData({
  domain,
  types,
  primaryType: 'CreateDeal',
  message,
})
console.log('Viem Digest:   ', digestViem)

// 2. Manual Calculation
// Domain: Unsorted
const domainTypeStr = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
const domainTypeHash = keccak256(toBytes(domainTypeStr))

const domainSep = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [
        domainTypeHash,
        keccak256(toBytes(domain.name)),
        keccak256(toBytes(domain.version)),
        BigInt(domain.chainId),
        domain.verifyingContract
    ]
))
console.log('DomainSep:     ', domainSep)

// CreateDeal: Current
const createDealTypeStr = "CreateDeal(address creator,uint64 duration,string service_hint,string initial_escrow,string max_monthly_spend,uint64 nonce)"
const createDealTypeHash = keccak256(toBytes(createDealTypeStr))
console.log('TypeHash:      ', createDealTypeHash)

const structHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, address, uint64, bytes32, bytes32, bytes32, uint64'), 
    [
        createDealTypeHash,
        message.creator,
        message.duration,
        keccak256(toBytes(message.service_hint)),
        keccak256(toBytes(message.initial_escrow)),
        keccak256(toBytes(message.max_monthly_spend)),
        message.nonce
    ]
))
console.log('StructHash:    ', structHash)

const digestManual = keccak256(concat([
    toBytes('0x1901'),
    hexToBytes(domainSep),
    hexToBytes(structHash)
]))

console.log('Manual Digest: ', digestManual)
