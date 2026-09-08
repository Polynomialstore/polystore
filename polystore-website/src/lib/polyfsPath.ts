export const POLYFS_RECORD_PATH_MAX_BYTES = 232

// Match the native/Rust path policy without changing a stored filename.
export function validatePolyfsRecordPath(value: string): string {
  if (typeof value !== 'string' || !value || /^\p{White_Space}|\p{White_Space}$/u.test(value)) {
    throw new Error('PolyFS path is empty or has outer whitespace')
  }
  const encoded = new TextEncoder().encode(value)
  if (encoded.length > POLYFS_RECORD_PATH_MAX_BYTES || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoded) !== value) {
    throw new Error('PolyFS path must be valid UTF-8 of at most 232 bytes')
  }
  // eslint-disable-next-line no-control-regex -- The wire path policy explicitly rejects ASCII control bytes.
  if (value.startsWith('/') || /[\\\x00-\x1f\x7f]/u.test(value) || value.split('/').includes('..')) {
    throw new Error('invalid PolyFS path')
  }
  return value
}

// Retained API name; filenames must no longer be silently renamed or truncated.
export const sanitizePolyfsRecordPath = validatePolyfsRecordPath
