import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters, concat, recoverAddress } from 'viem'

function hexToBytes(hex) {
    return toBytes(hex)
}

// VALUES FROM NONCE 15 FAILURE
const message = {
  creator: '0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2',
  size_tier: 1n,
  duration: 100n,
  service_hint: 'General:replicas=1:debug_digest=0x8ec1fcdfca9757aca8dd033ffa8a90a6a349fb0cc576d7075acc14849b622dd6',
  initial_escrow: 1000000n,
  max_monthly_spend: 5000000n,
  nonce: 15n,
}

const chainId = 31337n
const name = 'NilStore'
const version = '1'
const verifyingContract = '0x0000000000000000000000000000000000000000'

const signature = '0x9f3d0f0f65660fb6c38eba8aaacae1a7b573c444fd7a58c4e41c7e6a464f4c7161e6f06d25644631687c2fed6d556b95a236bfede4ef5d8e031e65b8e456f1131c'
const expected = message.creator.toLowerCase()

// 1. UNSORTED (Current Backend)
const domainTypeStrUnsorted = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
const domainTypeHashUnsorted = keccak256(toBytes(domainTypeStrUnsorted))
const domainSepUnsorted = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [domainTypeHashUnsorted, keccak256(toBytes(name)), keccak256(toBytes(version)), chainId, verifyingContract]
))

const createDealTypeStrUnsorted = "CreateDeal(address creator,uint32 size_tier,uint64 duration,string service_hint,uint256 initial_escrow,uint256 max_monthly_spend,uint64 nonce)"
const createDealTypeHashUnsorted = keccak256(toBytes(createDealTypeStrUnsorted))
const structHashUnsorted = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, address, uint256, uint64, bytes32, uint256, uint256, uint64'),
    [createDealTypeHashUnsorted, message.creator, message.size_tier, message.duration, keccak256(toBytes(message.service_hint)), message.initial_escrow, message.max_monthly_spend, message.nonce]
))

const digestUnsorted = keccak256(concat([toBytes('0x1901'), hexToBytes(domainSepUnsorted), hexToBytes(structHashUnsorted)]))
console.log('Digest Unsorted:', digestUnsorted) // Should match bf1203...

// 2. SORTED
const domainTypeStrSorted = "EIP712Domain(uint256 chainId,string name,address verifyingContract,string version)"
const domainTypeHashSorted = keccak256(toBytes(domainTypeStrSorted))
const domainSepSorted = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint256, bytes32, address, bytes32'),
    [domainTypeHashSorted, chainId, keccak256(toBytes(name)), verifyingContract, keccak256(toBytes(version))]
))

const createDealTypeStrSorted = "CreateDeal(address creator,uint64 duration,uint256 initial_escrow,uint256 max_monthly_spend,uint64 nonce,string service_hint,uint32 size_tier)"
const createDealTypeHashSorted = keccak256(toBytes(createDealTypeStrSorted))
const structHashSorted = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, address, uint64, uint256, uint256, uint64, bytes32, uint256'),
    [createDealTypeHashSorted, message.creator, message.duration, message.initial_escrow, message.max_monthly_spend, message.nonce, keccak256(toBytes(message.service_hint)), message.size_tier]
))

const digestSorted = keccak256(concat([toBytes('0x1901'), hexToBytes(domainSepSorted), hexToBytes(structHashSorted)]))
console.log('Digest Sorted:  ', digestSorted)

async function verify() {
    const recUnsorted = await recoverAddress({ hash: digestUnsorted, signature })
    console.log('Recovered (Unsorted):', recUnsorted)
    
    const recSorted = await recoverAddress({ hash: digestSorted, signature })
    console.log('Recovered (Sorted):  ', recSorted)
    
    if (recSorted.toLowerCase() === expected) console.log("CONCLUSION: MetaMask IS sorting!")
    else if (recUnsorted.toLowerCase() === expected) console.log("CONCLUSION: MetaMask is NOT sorting (Match found unsorted)")
    else console.log("CONCLUSION: Neither matched. Check ChainID or something else.")
}

verify()
