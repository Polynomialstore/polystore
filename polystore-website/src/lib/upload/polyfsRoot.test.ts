import test from 'node:test'
import assert from 'node:assert/strict'

import { polyfsRootHexFromMdu0Root } from './polyfsRoot'

test('polyfs root: uses the 32-byte MDU0 root, not the 48-byte aggregate commitment', () => {
  const mdu0Root = new Uint8Array(32).fill(0x11)
  const aggregateCommitment = new Uint8Array(48).fill(0x22)

  const root = polyfsRootHexFromMdu0Root(mdu0Root)

  assert.equal(root, `0x${'11'.repeat(32)}`)
  assert.notEqual(root, `0x${'22'.repeat(48)}`)
  assert.equal(aggregateCommitment.byteLength, 48)
})

test('polyfs root: rejects non-PolyFS root lengths', () => {
  assert.throws(() => polyfsRootHexFromMdu0Root(new Uint8Array(48)), /32 bytes/)
})

