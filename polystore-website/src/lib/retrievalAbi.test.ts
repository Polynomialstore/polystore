import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { encodeFunctionData, type Abi } from 'viem'
import { encodeRetrievalV2Data, type RetrievalSessionV2Input, type SponsoredRetrievalSessionInput } from './polystorePrecompile'

test('secured browser encoders match the actual chain v2 overloads including frozen payee', async () => {
  const source = await readFile(new URL('../../../polystorechain/precompiles/polystore/polystore.go', import.meta.url), 'utf8')
  const start = source.indexOf('const polystoreABIJSON = `') + 'const polystoreABIJSON = `'.length
  const abi = JSON.parse(source.slice(start, source.indexOf('`', start))) as Abi
  const session: RetrievalSessionV2Input & SponsoredRetrievalSessionInput = {
    dealId: 9007199254740993n, provider: 'nil-assigned', authorizedProofProvider: 'nil-deputy',
    startMduIndex: 65536n, startBlobIndex: 8, blobCount: 2n, expiresAt: 9007199254740993n, nonce: 9007199254740995n,
    manifestRoot: `0x${'ab'.repeat(32)}`, maxTotalFee: 123n, authType: 0, allowlistMerklePath: [], allowlistLeafIndex: 0,
    voucherRedeemer: '', voucherProvider: '', voucherExpiresAt: 0n, voucherNonce: 0n, voucherSignature: '0x',
  }
  for (const method of ['computeRetrievalSessionIds', 'openRetrievalSessions', 'openRetrievalSessionsSponsored'] as const) {
    const selected = abi.filter((entry) => entry.type === 'function' && entry.name === method && 'components' in entry.inputs[0] && entry.inputs[0].components.some((c) => c.name === 'authorizedProofProvider'))
    assert.equal(selected.length, 1)
    assert.equal(encodeRetrievalV2Data(method, [session]), encodeFunctionData({ abi: selected, functionName: method, args: [[session]] }))
  }
})
