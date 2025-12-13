import { blake2s } from '@noble/hashes/blake2.js'

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = strip0x(hex).toLowerCase()
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex length: ${hex}`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = clean.slice(i * 2, i * 2 + 2)
    out[i] = Number.parseInt(byte, 16)
  }
  return out
}

/**
 * Builds a Blake2s Merkle tree over 32-byte leaf values.
 *
 * This is a debug/educational view used by the website. It is NOT the Deal's
 * manifest commitment (which is KZG over the ordered MDU roots).
 *
 * - Leaves are taken as-is (decoded from hex).
 * - Parents are `blake2s(left || right)`; odd nodes duplicate the last.
 */
export function buildBlake2sMerkleLayers(leafHex: string[]): string[][] {
  if (leafHex.length === 0) return []

  let layer = leafHex.map(h => bytesToHex(hexToBytes(h)))
  const layers: string[][] = [layer]

  while (layer.length > 1) {
    const next: string[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = hexToBytes(layer[i])
      const right = hexToBytes(layer[i + 1] ?? layer[i])

      const combined = new Uint8Array(left.length + right.length)
      combined.set(left, 0)
      combined.set(right, left.length)

      next.push(bytesToHex(blake2s(combined)))
    }
    layer = next
    layers.push(layer)
  }

  return layers
}
