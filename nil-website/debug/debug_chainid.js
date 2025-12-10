import { hashTypedData, keccak256, toBytes, encodeAbiParameters, parseAbiParameters, concat } from 'viem'

function hexToBytes(hex) {
    return toBytes(hex)
}

const domain = {
  name: 'NilStore',
  version: '1',
  chainId: 1, // TRYING CHAIN ID 1
  verifyingContract: '0x0000000000000000000000000000000000000000',
}

const types = {
  CreateDeal: [
    { name: 'creator', type: 'address' },
    { name: 'size_tier', type: 'uint32' },
    { name: 'duration', type: 'uint64' },
    { name: 'service_hint', type: 'string' },
    { name: 'initial_escrow', type: 'uint256' },
    { name: 'max_monthly_spend', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
  ],
}

// VALUES FROM LOG
const message = {
  creator: '0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2',
  size_tier: 1,
  duration: 100n,
  service_hint: 'General:replicas=1',
  initial_escrow: 1000000n,
  max_monthly_spend: 5000000n,
  nonce: 13n,
}

const digestViem = hashTypedData({
  domain,
  types,
  primaryType: 'CreateDeal',
  message,
})
console.log('Viem Digest (ChainId 1):', digestViem)

// Verify against signature
import { recoverAddress } from 'viem'
const signature = '0xc5a8542e7c01311fab8e7802487cb88674658c142cc97ea75f14aa3d17dd6f067a4928fa2f0cfad72e604ae0f2314a92987456e89e3051645ac84f621889aa581c'

async function check() {
    const recovered = await recoverAddress({ hash: digestViem, signature })
    console.log('Recovered:', recovered)
    if (recovered.toLowerCase() === message.creator.toLowerCase()) {
        console.log('MATCH FOUND with ChainId 1!')
    } else {
        console.log('No match.')
    }
}
check()
