import { bech32 } from 'bech32'

/**
 * Converts an Ethereum 0x address to the current PolyStore Chain bech32 address.
 * @param ethAddress The Ethereum address (e.g. 0x123...)
 * @param prefix The current Bech32 HRP (default: 'nil')
 * @returns The current PolyStore Chain address (for example `nil1...`)
 */
export function ethToPolystoreAddress(ethAddress: string, prefix: string = 'nil'): string {
  try {
    const clean = ethAddress.replace(/^0x/, '')
    const bytes = new Uint8Array(clean.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)))
    return bech32.encode(prefix, bech32.toWords(bytes))
  } catch (e) {
    console.error('Failed to convert address:', e)
    return ''
  }
}
