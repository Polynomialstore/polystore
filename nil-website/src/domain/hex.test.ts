import test from 'node:test'
import assert from 'node:assert/strict'

import { toHexFromBase64OrHex } from './hex'

test('toHexFromBase64OrHex passes through hex', () => {
  assert.equal(toHexFromBase64OrHex('0x1234'), '0x1234')
})

test('toHexFromBase64OrHex decodes base64 to hex with expected length', () => {
  const bytes = new Uint8Array(48)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i
  const base64 = Buffer.from(bytes).toString('base64')
  const got = toHexFromBase64OrHex(base64, { expectedBytes: [48] })
  assert.equal(got, `0x${Buffer.from(bytes).toString('hex')}`)
})

test('toHexFromBase64OrHex rejects base64 with wrong byte length', () => {
  const bytes = new Uint8Array(32)
  bytes.fill(0xaa)
  const base64 = Buffer.from(bytes).toString('base64')
  const got = toHexFromBase64OrHex(base64, { expectedBytes: [48] })
  assert.equal(got, '')
})

