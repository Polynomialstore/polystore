import { ZstdCodec } from 'zstd-codec'

export type PolyceEncoding = 'none' | 'zstd'

const POLYCE_MAGIC = [0x50, 0x4f, 0x4c, 0x43]
const POLYCE_VERSION = 1
const POLYCE_HEADER_SIZE = 16
const DEFAULT_MIN_SAVINGS_BPS = 500
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024
export const POLYCE_FLAG_COMPRESSION_ZSTD = 0x02

type ZstdSimple = {
  compress: (input: Uint8Array) => Uint8Array
  decompress: (input: Uint8Array) => Uint8Array
}

let zstdPromise: Promise<ZstdSimple> | null = null

async function getZstdSimple(): Promise<ZstdSimple> {
  if (!zstdPromise) {
    zstdPromise = new Promise((resolve, reject) => {
      try {
        ZstdCodec.run((zstd) => {
          resolve(new zstd.Simple())
        })
      } catch (err) {
        reject(err)
      }
    })
  }
  return zstdPromise
}

function writePolyceHeader(encoding: PolyceEncoding, uncompressedLen: number): Uint8Array {
  const header = new Uint8Array(POLYCE_HEADER_SIZE)
  header.set(POLYCE_MAGIC, 0)
  header[4] = POLYCE_VERSION
  header[5] = encoding === 'zstd' ? 1 : 0
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint16(6, 0, true)
  view.setBigUint64(8, BigInt(uncompressedLen), true)
  return header
}

function parsePolyceHeader(bytes: Uint8Array): {
  ok: boolean
  encoding?: PolyceEncoding
  uncompressedLen?: number
  error?: Error
} {
  if (bytes.length < POLYCE_HEADER_SIZE) return { ok: false }
  if (!POLYCE_MAGIC.every((b, i) => bytes[i] === b)) return { ok: false }
  if (bytes[4] !== POLYCE_VERSION) return { ok: true, error: new Error('Unsupported PolyCE version') }
  const enc = bytes[5]
  if (enc !== 0 && enc !== 1) return { ok: true, error: new Error('Unsupported PolyCE encoding') }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const uncompressedLen = Number(view.getBigUint64(8, true))
  return { ok: true, encoding: enc === 1 ? 'zstd' : 'none', uncompressedLen }
}

export function peekPolyceHeader(input: Uint8Array): {
  ok: boolean
  encoding?: PolyceEncoding
  uncompressedLen?: number
  error?: Error
} {
  const header = input.length >= POLYCE_HEADER_SIZE ? input.subarray(0, POLYCE_HEADER_SIZE) : input
  const parsed = parsePolyceHeader(header)
  if (!parsed.ok) return { ok: false }
  if (parsed.error) return { ok: true, error: parsed.error }
  return {
    ok: true,
    encoding: parsed.encoding ?? 'none',
    uncompressedLen: parsed.uncompressedLen ?? 0,
  }
}

export async function maybeWrapPolyceZstd(
  input: Uint8Array,
  opts?: { minSavingsBps?: number },
): Promise<{ bytes: Uint8Array; encoding: PolyceEncoding; uncompressedLen: number; compressedLen: number; wrapped: boolean }> {
  const uncompressedLen = input.byteLength
  if (uncompressedLen === 0) {
    return { bytes: input, encoding: 'none', uncompressedLen, compressedLen: 0, wrapped: false }
  }
  const minSavingsBps = opts?.minSavingsBps ?? DEFAULT_MIN_SAVINGS_BPS
  const zstd = await getZstdSimple()
  const compressed = zstd.compress(input)
  const encodedLen = compressed.byteLength + POLYCE_HEADER_SIZE
  if (encodedLen >= uncompressedLen) {
    return { bytes: input, encoding: 'none', uncompressedLen, compressedLen: compressed.byteLength, wrapped: false }
  }
  const savingsBps = Math.floor(((uncompressedLen - encodedLen) * 10_000) / uncompressedLen)
  if (savingsBps < minSavingsBps) {
    return { bytes: input, encoding: 'none', uncompressedLen, compressedLen: compressed.byteLength, wrapped: false }
  }

  const header = writePolyceHeader('zstd', uncompressedLen)
  const out = new Uint8Array(header.byteLength + compressed.byteLength)
  out.set(header, 0)
  out.set(compressed, header.byteLength)
  return {
    bytes: out,
    encoding: 'zstd',
    uncompressedLen,
    compressedLen: compressed.byteLength,
    wrapped: true,
  }
}

export async function decodePolyceV1(
  input: Uint8Array,
  opts?: { maxOutputBytes?: number },
): Promise<{ payload: Uint8Array; encoding: PolyceEncoding; uncompressedLen: number; wrapped: boolean }> {
  const parsed = parsePolyceHeader(input)
  if (!parsed.ok) {
    return { payload: input, encoding: 'none', uncompressedLen: input.byteLength, wrapped: false }
  }
  if (parsed.error) throw parsed.error
  const encoding = parsed.encoding ?? 'none'
  const payload = input.slice(POLYCE_HEADER_SIZE)
  if (encoding === 'none') {
    return { payload, encoding, uncompressedLen: parsed.uncompressedLen ?? payload.byteLength, wrapped: true }
  }
  const maxOutput = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const expectedLen = parsed.uncompressedLen ?? 0
  if (expectedLen > maxOutput) {
    throw new Error('PolyCE payload exceeds max output size')
  }
  const zstd = await getZstdSimple()
  const decompressed = zstd.decompress(payload)
  if (expectedLen && decompressed.byteLength !== expectedLen) {
    throw new Error('PolyCE decoded length mismatch')
  }
  return { payload: decompressed, encoding, uncompressedLen: expectedLen || decompressed.byteLength, wrapped: true }
}
