import { hashTypedData, recoverAddress } from 'viem'

const domain = {
  name: 'NilStore',
  version: '1',
  chainId: 31337,
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

const message = {
  creator: '0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2',
  size_tier: 1,
  duration: 100n,
  service_hint: 'General:replicas=1',
  initial_escrow: 1000000n,
  max_monthly_spend: 5000000n,
  nonce: 13n,
}

const digest = hashTypedData({ domain, types, primaryType: 'CreateDeal', message })
console.log('Digest:', digest)

const sigBase = '0xc5a8542e7c01311fab8e7802487cb88674658c142cc97ea75f14aa3d17dd6f067a4928fa2f0cfad72e604ae0f2314a92987456e89e3051645ac84f621889aa58'
const expected = '0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2'.toLowerCase()

async function check() {
    const endings = ['1b', '1c', '00', '01'] // 27, 28, 0, 1
    for (const end of endings) {
        const sig = sigBase + end
        const rec = await recoverAddress({ hash: digest, signature: sig })
        console.log(`End ${end}: ${rec}`)
        if (rec.toLowerCase() === expected) console.log('MATCH!')
    }
}
check()
