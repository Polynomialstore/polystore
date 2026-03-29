const MISSING_APPEND_STATE_PATTERN = /mode2 append failed/i
const MISSING_APPEND_DETAIL_PATTERN =
  /failed to resolve existing slab dir|failed to read existing MDU #0|failed to copy existing shard|failed to decode witness mdu|existing Mode 2 slab has no user MDUs/i

export interface GatewayAppendRecoveryInput {
  rehydrateFromBrowser: () => Promise<boolean>
  bootstrapFromNetwork: () => Promise<boolean>
}

export interface GatewayAppendRecoveryResult {
  ok: boolean
  source: 'browser' | 'network' | 'none'
}

export function isMissingGatewayAppendStateError(message: string): boolean {
  const text = String(message || '')
  return MISSING_APPEND_STATE_PATTERN.test(text) && MISSING_APPEND_DETAIL_PATTERN.test(text)
}

export async function recoverGatewayAppendState(
  input: GatewayAppendRecoveryInput,
): Promise<GatewayAppendRecoveryResult> {
  const hydratedFromBrowser = await input.rehydrateFromBrowser()
  if (hydratedFromBrowser) {
    return { ok: true, source: 'browser' }
  }

  const bootstrapped = await input.bootstrapFromNetwork()
  if (!bootstrapped) {
    return { ok: false, source: 'none' }
  }

  const hydratedAfterBootstrap = await input.rehydrateFromBrowser()
  if (hydratedAfterBootstrap) {
    return { ok: true, source: 'network' }
  }

  return { ok: false, source: 'none' }
}
