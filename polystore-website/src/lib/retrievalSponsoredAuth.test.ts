import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreSponsoredRetrievalAuth, sponsoredRetrievalFeeCap, withSponsoredRetrievalFeeCap } from './retrievalSponsoredAuth'

test('sponsored retrieval fee cap is explicit, positive and restored exactly', () => {
  assert.equal(sponsoredRetrievalFeeCap(' 123 '), 123n)
  assert.equal(sponsoredRetrievalFeeCap(''), undefined)
  for (const value of ['0', '-1', '1.5', '1e3']) assert.throws(() => sponsoredRetrievalFeeCap(value), /positive integer/)
  assert.throws(() => sponsoredRetrievalFeeCap((1n << 256n).toString()), /uint256/)

  assert.deepEqual(withSponsoredRetrievalFeeCap({ type: 'none' }, '42'), { type: 'none', maxTotalFee: 42n })
  assert.deepEqual(restoreSponsoredRetrievalAuth(JSON.stringify({ type: 'none', maxTotalFee: '42' })), {
    auth: { type: 'none', maxTotalFee: 42n }, feeCap: '42',
  })
  assert.equal(restoreSponsoredRetrievalAuth(JSON.stringify({ type: 'allowlist', leafIndex: 0, merklePath: [], maxTotalFee: '9' })).auth.maxTotalFee, 9n)
  assert.equal(restoreSponsoredRetrievalAuth(JSON.stringify({ type: 'voucher', voucher: { nonce: 1, signature: '0x01' }, maxTotalFee: '8' })).auth.maxTotalFee, 8n)
  assert.throws(() => restoreSponsoredRetrievalAuth(JSON.stringify({ type: 'none', maxTotalFee: 7 })), /maximum retrieval fee/)
})
