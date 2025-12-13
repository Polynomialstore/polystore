import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters, concat, recoverAddress } from 'viem'

function hexToBytes(hex) {
    return toBytes(hex)
}

// VALUES
const chainId = 31337
const verifyingContract = '0x0000000000000000000000000000000000000000'
const name = 'NilStore'
const version = '1'

const message = {
  creator: '0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2',
  duration: 100n,
  service_hint: 'General:replicas=1',
  initial_escrow: '1000000',
  max_monthly_spend: '5000000',
  nonce: 13n,
}

const signature = '0xc5a8542e7c01311fab8e7802487cb88674658c142cc97ea75f14aa3d17dd6f067a4928fa2f0cfad72e604ae0f2314a92987456e89e3051645ac84f621889aa581c'
const expected = message.creator.toLowerCase()

// DOMAIN OPTIONS
const domainTypes = {
    sorted: "EIP712Domain(uint256 chainId,string name,address verifyingContract,string version)",
    unsorted: "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
}

function getDomainSep(typeStr) {
    const typeHash = keccak256(toBytes(typeStr))
    // We must encode values in the SAME ORDER as the type string
    // This is tricky. I need to map typeStr to value order.
    // Sorted: chainId, name, verifyingContract, version
    // Unsorted: name, version, chainId, verifyingContract
    
    let values
    if (typeStr === domainTypes.sorted) {
        values = [BigInt(chainId), keccak256(toBytes(name)), verifyingContract, keccak256(toBytes(version))]
        return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256, bytes32, address, bytes32'), [typeHash, ...values]))
    } else {
        values = [keccak256(toBytes(name)), keccak256(toBytes(version)), BigInt(chainId), verifyingContract]
        return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [typeHash, ...values]))
    }
}

// STRUCT OPTIONS
const structTypes = {
    sorted: "CreateDeal(address creator,uint64 duration,string initial_escrow,string max_monthly_spend,uint64 nonce,string service_hint)",
    unsorted: "CreateDeal(address creator,uint64 duration,string service_hint,string initial_escrow,string max_monthly_spend,uint64 nonce)"
}

function getStructHash(typeStr) {
    const typeHash = keccak256(toBytes(typeStr))
    
    let values
    let schema
    if (typeStr === structTypes.sorted) {
        // creator, duration, initial_escrow, max_monthly_spend, nonce, service_hint
        values = [message.creator, message.duration, keccak256(toBytes(message.initial_escrow)), keccak256(toBytes(message.max_monthly_spend)), message.nonce, keccak256(toBytes(message.service_hint))]
        schema = 'bytes32, address, uint64, bytes32, bytes32, uint64, bytes32'
    } else {
        // creator, duration, service_hint, initial_escrow, max_monthly_spend, nonce
        values = [message.creator, message.duration, keccak256(toBytes(message.service_hint)), keccak256(toBytes(message.initial_escrow)), keccak256(toBytes(message.max_monthly_spend)), message.nonce]
        schema = 'bytes32, address, uint64, bytes32, bytes32, bytes32, uint64'
    }
    
    return keccak256(encodeAbiParameters(parseAbiParameters(schema), [typeHash, ...values]))
}

async function run() {
    console.log('Starting Brute Force...')
    
    for (const dKey in domainTypes) {
        for (const sKey in structTypes) {
            const dSep = getDomainSep(domainTypes[dKey])
            const sHash = getStructHash(structTypes[sKey])
            const digest = keccak256(concat([toBytes('0x1901'), hexToBytes(dSep), hexToBytes(sHash)]))
            
            const rec = await recoverAddress({ hash: digest, signature })
            console.log(`[Domain:${dKey} Struct:${sKey}] Recovered: ${rec}`)
            if (rec.toLowerCase() === expected) {
                console.log(`MATCH FOUND! Domain:${dKey} Struct:${sKey}`)
                return
            }
        }
    }
}

run()
