import test from 'node:test'
import assert from 'node:assert/strict'

import { blake2s } from '@noble/hashes/blake2.js'

import { buildBlake2sMerkleLayers, bytesToHex, hexToBytes } from './merkle'

test('buildBlake2sMerkleLayers returns empty for no leaves', () => {
  assert.deepEqual(buildBlake2sMerkleLayers([]), [])
})

test('buildBlake2sMerkleLayers builds expected layers (duplicate-last)', () => {
  const leaves = [
    '0x' + '11'.repeat(32),
    '0x' + '22'.repeat(32),
    '0x' + '33'.repeat(32),
  ]

  const layers = buildBlake2sMerkleLayers(leaves)
  assert.equal(layers.length, 3)
  assert.equal(layers[0].length, 3)
  assert.equal(layers[1].length, 2)
  assert.equal(layers[2].length, 1)

  const h01 = bytesToHex(blake2s(new Uint8Array([...hexToBytes(leaves[0]), ...hexToBytes(leaves[1])])))
  const h22 = bytesToHex(blake2s(new Uint8Array([...hexToBytes(leaves[2]), ...hexToBytes(leaves[2])])))
  const root = bytesToHex(blake2s(new Uint8Array([...hexToBytes(h01), ...hexToBytes(h22)])))

  assert.equal(layers[2][0], root)
})
