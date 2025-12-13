export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchFn(input, init)
  }

  const controller = new AbortController()
  let timedOut = false
  let abortListener: (() => void) | undefined

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    if (init?.signal) {
      if (init.signal.aborted) {
        controller.abort()
      } else {
        abortListener = () => controller.abort()
        init.signal.addEventListener('abort', abortListener, { once: true })
      }
    }

    return await fetchFn(input, { ...init, signal: controller.signal })
  } catch (err) {
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
    if (abortListener && init?.signal) {
      init.signal.removeEventListener('abort', abortListener)
    }
  }
}
