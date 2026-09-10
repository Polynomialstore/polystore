function abortReason(signal: AbortSignal): unknown {
  return signal.aborted ? signal.reason : new DOMException('Download was replaced', 'AbortError')
}

export async function handoffOwnedDownload<T>(
  signal: AbortSignal,
  ownsDownload: () => boolean,
  url: string,
  handoff: () => Promise<(() => Promise<void>) | undefined>,
  publish: (cleanup: (() => Promise<void>) | undefined) => T,
  revoke = URL.revokeObjectURL,
): Promise<T> {
  let cleanup: (() => Promise<void>) | undefined
  try {
    if (signal.aborted || !ownsDownload()) throw abortReason(signal)
    cleanup = await handoff()
    if (signal.aborted || !ownsDownload()) throw abortReason(signal)
    return publish(cleanup)
  } catch (error) {
    revoke(url)
    await cleanup?.().catch(() => {})
    throw error
  }
}
