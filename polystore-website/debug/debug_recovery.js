import { recoverAddress } from 'viem'

const digest = '0xc91bd174df7825a8d1b431f040e22f119fd5ead03963a4d406ff24b1a1674242'
const signature = '0xc5a8542e7c01311fab8e7802487cb88674658c142cc97ea75f14aa3d17dd6f067a4928fa2f0cfad72e604ae0f2314a92987456e89e3051645ac84f621889aa581c'

async function check() {
    const recovered = await recoverAddress({ hash: digest, signature })
    console.log('Recovered Address:', recovered)
    console.log('Expected Address: 0xf7931ff7FC55d19EF4A8139fa7E4b3F06e03F2e2')
}

check()
