import type { FrozenSessionV3 } from './retrievalV3'
import type { RetrievalV3CheckpointState } from './retrievalV3Checkpoint'

// Shared by the browser hook and recovery tests. Completed sessions still need
// authenticated challenge material; settlement alone must not bypass readiness.
export async function waitForRetrievalV3Challenge(
  initial: FrozenSessionV3,
  observe: (session: FrozenSessionV3, signal?: AbortSignal) => Promise<FrozenSessionV3>,
  signal?: AbortSignal,
): Promise<FrozenSessionV3> {
  let session = initial
  while (!session.anchorSeed || session.height < session.firstResponse) {
    signal?.throwIfAborted()
    if (session.expired || session.height > session.deadline) return session
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, 750)
      function done() { signal?.removeEventListener('abort', aborted); resolve() }
      function aborted() { clearTimeout(timer); reject(signal?.reason) }
      signal?.addEventListener('abort', aborted, { once: true })
    })
    session = await observe(session, signal)
  }
  return session
}

export async function recoverRetrievalV3Checkpoint(
  saved: RetrievalV3CheckpointState,
  actions: {
    open: (saved: RetrievalV3CheckpointState) => Promise<FrozenSessionV3>
    observe: (session: FrozenSessionV3) => Promise<FrozenSessionV3>
    ready: (session: FrozenSessionV3) => Promise<FrozenSessionV3>
    refund: (session: FrozenSessionV3) => Promise<FrozenSessionV3>
    persist: (session: FrozenSessionV3, bind: boolean) => void
  },
): Promise<{ session: FrozenSessionV3; expired: boolean }> {
  const bind = saved.session === undefined
  let session = bind ? await actions.open(saved) : await actions.observe(saved.session!)
  actions.persist(session, bind)
  session = await actions.ready(session)
  actions.persist(session, false)
  const expired = session.expired || session.height > session.deadline
  if (expired && session.lockedFee !== 0n) {
    session = await actions.refund(session)
    actions.persist(session, false)
  }
  return { session, expired }
}
