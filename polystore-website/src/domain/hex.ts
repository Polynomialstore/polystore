import { decodeBase64ToBytes } from './base64'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return `0x${out}`
}

export function toHexFromBase64OrHex(
  value: unknown,
  opts?: { expectedBytes?: number[] },
): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === '0x') return ''
  if (trimmed.startsWith('0x')) return trimmed

  try {
    const bytes = decodeBase64ToBytes(trimmed)
    if (opts?.expectedBytes?.length && !opts.expectedBytes.includes(bytes.length)) {
      return ''
    }
    if (bytes.length === 0) return ''
    return bytesToHex(bytes)
  } catch {
    return ''
  }
}

