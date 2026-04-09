export function decodeBase64ToBytes(input: string): Uint8Array {
  const trimmed = input.trim()
  if (!trimmed) return new Uint8Array()

  if (typeof atob === 'function') {
    const binary = atob(trimmed)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer
  if (buf?.from) {
    return Uint8Array.from(buf.from(trimmed, 'base64'))
  }

  throw new Error('No base64 decoder available')
}

