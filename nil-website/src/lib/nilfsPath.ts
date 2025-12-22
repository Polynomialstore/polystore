export const NILFS_RECORD_PATH_MAX_BYTES = 40

export function sanitizeNilfsRecordPath(input: string): string {
  let value = String(input ?? '').trim()
  if (!value) return 'file'

  // Treat common OS path separators as delimiters; NilFS V1 currently stores basename only.
  value = value.replaceAll('\\', '/')
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

  // Match current on-chain/NilFS V1 limitation (40-byte fixed field). We assume ASCII filenames
  // in the UI; for non-ASCII, truncate by UTF-16 code units (best-effort).
  if (value.length > NILFS_RECORD_PATH_MAX_BYTES) {
    value = value.slice(0, NILFS_RECORD_PATH_MAX_BYTES)
  }

  return value
}
