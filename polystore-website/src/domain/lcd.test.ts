import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeLcdDealsResponse } from './lcd'

test('normalizeLcdDealsResponse maps manifest_root bytes to Deal.cid hex', () => {
  const bytes = new Uint8Array(48)
  bytes.fill(0x11)
  const base64 = Buffer.from(bytes).toString('base64')

  const payload = {
    deals: [
      {
        id: 7,
        owner: 'nil1owner',
        manifest_root: base64,
        size: '123',
        escrow_balance: '9',
        end_block: '100',
        redundancy_mode: 2,
        mode2_profile: { k: 8, m: 4 },
        providers: ['nil1p1', 'nil1p2'],
      },
    ],
  }

  const deals = normalizeLcdDealsResponse(payload)
  assert.equal(deals.length, 1)
  assert.equal(deals[0].id, '7')
  assert.equal(deals[0].owner, 'nil1owner')
  assert.equal(deals[0].cid, `0x${Buffer.from(bytes).toString('hex')}`)
  assert.equal(deals[0].size, '123')
  assert.equal(deals[0].escrow, '9')
  assert.equal(deals[0].end_block, '100')
  assert.deepEqual(deals[0].providers, ['nil1p1', 'nil1p2'])
  assert.equal(deals[0].redundancy_mode, 2)
  assert.deepEqual(deals[0].mode2_profile, { k: 8, m: 4 })
})

test('normalizeLcdDealsResponse does not coerce malformed Mode 2 geometry', () => {
  const [deal] = normalizeLcdDealsResponse({ deals: [{
    id: '9', redundancy_mode: '2', mode2_profile: { k: '8', m: null },
  }] })
  assert.equal(deal.redundancy_mode, undefined)
  assert.equal(deal.mode2_profile, undefined)
})

test('normalizeLcdDealsResponse accepts PolyFS 32-byte manifest_root bytes', () => {
  const bytes = new Uint8Array(32)
  bytes.fill(0x22)
  const base64 = Buffer.from(bytes).toString('base64')

  const deals = normalizeLcdDealsResponse({
    deals: [
      {
        id: 8,
        owner: 'nil1owner',
        manifest_root: base64,
      },
    ],
  })

  assert.equal(deals.length, 1)
  assert.equal(deals[0].cid, `0x${Buffer.from(bytes).toString('hex')}`)
})
