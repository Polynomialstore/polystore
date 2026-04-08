export const NILFS_RECORD_PATH_MAX_BYTES = 232

export function sanitizeNilfsRecordPath(input: string): string {
  let value = String(input ?? '').trim()
  if (!value) return 'file'

  // Treat common OS path separators as delimiters; NilFS V1 currently stores basename only.
  value = value.replace(/\\/g, '/')
  if (value.includes('/')) {
    const parts = value.split('/').filter(Boolean)
    value = parts.length ? parts[parts.length - 1] : value
  }

  // Remove NUL/control characters.
  let filtered = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code === 127) continue
    filtered += ch
  }
  value = filtered
  value = value.trim()
  if (!value) return 'file'

  // Match current NilFS fixed 232-byte path field. Truncate by UTF-8 bytes, not JS code units,
  // so multibyte filenames from macOS/Chrome cannot slip through and trip the WASM builder.
  const encoder = new TextEncoder()
  if (encoder.encode(value).length > NILFS_RECORD_PATH_MAX_BYTES) {
    let truncated = ''
    for (const ch of value) {
      const next = truncated + ch
      if (encoder.encode(next).length > NILFS_RECORD_PATH_MAX_BYTES) break
      truncated = next
    }
    value = truncated.trim()
    if (!value) return 'file'
  }

  return value
}
