type ErrorLike = {
  message?: unknown
  shortMessage?: unknown
  details?: unknown
  cause?: unknown
}

export interface PolyfsCommitErrorInfo {
  message: string
  staleBase: boolean
}

function asObject(value: unknown): ErrorLike | null {
  if (!value || typeof value !== 'object') return null
  return value as ErrorLike
}

function collectErrorStrings(error: unknown): string[] {
  const out = new Set<string>()
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || seen.has(next)) continue
    seen.add(next)
    if (typeof next === 'string') {
      const trimmed = next.trim()
      if (trimmed) out.add(trimmed)
      continue
    }
    const obj = asObject(next)
    if (!obj) continue
    for (const field of [obj.message, obj.shortMessage, obj.details]) {
      if (typeof field === 'string') {
        const trimmed = field.trim()
        if (trimmed) out.add(trimmed)
      }
    }
    if (obj.cause) queue.push(obj.cause)
  }
  return Array.from(out)
}

export function classifyPolyfsCommitError(error: unknown, fallback = 'Commit failed'): PolyfsCommitErrorInfo {
  const messages = collectErrorStrings(error)
  const bestMessage = messages.find(Boolean) || fallback
  const joined = messages.join(' | ').toLowerCase()
  const staleBase =
    joined.includes('stale previous_manifest_root') ||
    joined.includes('stale manifest_root') ||
    joined.includes('stale base manifest root')

  if (staleBase) {
    return {
      staleBase: true,
      message:
        'Your local PolyFS base is stale. Refresh the deal state and retry so the browser can rebase on the current committed manifest root.',
    }
  }

  return {
    staleBase: false,
    message: bestMessage,
  }
}
