import { evaluateCacheFreshness, normalizeManifestRoot } from '../cacheFreshness'

export interface ResolvedAppendBase {
  baseMdu0Bytes: Uint8Array | null
  existingUserMdus: Array<{ index: number; data: Uint8Array }>
  existingUserCount: number
  existingMaxEnd: number
  appendStartOffset: number
  source: 'empty' | 'local' | 'bootstrap'
}

export interface ExistingLocalAppendBase {
  baseMdu0Bytes: Uint8Array
  existingUserMdus: Array<{ index: number; data: Uint8Array }>
  existingUserCount: number
  existingMaxEnd: number
  appendStartOffset: number
}

export interface ResolveAppendBaseInput {
  localManifestRoot: string | null | undefined
  chainManifestRoot: string | null | undefined
  loadLocal: () => Promise<ExistingLocalAppendBase | null>
  clearLocal: () => Promise<void>
  bootstrapFromNetwork: () => Promise<ExistingLocalAppendBase | null>
  addLog?: (message: string) => void
  formatBytes?: (bytes: number) => string
}

function emptyAppendBase(): ResolvedAppendBase {
  return {
    baseMdu0Bytes: null,
    existingUserMdus: [],
    existingUserCount: 0,
    existingMaxEnd: 0,
    appendStartOffset: 0,
    source: 'empty',
  }
}

export async function resolveMode2AppendBase(input: ResolveAppendBaseInput): Promise<ResolvedAppendBase> {
  const log = (message: string) => input.addLog?.(message)
  const formatBytes = input.formatBytes ?? ((bytes) => `${bytes} B`)
  const chainManifestRoot = normalizeManifestRoot(input.chainManifestRoot)
  const localManifestRoot = normalizeManifestRoot(input.localManifestRoot)
  const freshness = evaluateCacheFreshness(localManifestRoot, chainManifestRoot)

  if (freshness.status === 'stale') {
    log(
      `> Mode 2 append: local slab manifest ${freshness.localManifestRoot} is stale; bootstrapping from current committed root ${freshness.chainManifestRoot}.`,
    )
    await input.clearLocal()
  }

  try {
    const local = await input.loadLocal()
    if (local && local.existingUserCount > 0) {
      log(`> Mode 2 append: found ${local.existingUserCount} existing user MDUs; starting new file at ${formatBytes(local.appendStartOffset)}.`)
      return { ...local, source: 'local' }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`> Mode 2 append: failed to load existing slab (${msg}).`)
  }

  if (!chainManifestRoot) {
    return emptyAppendBase()
  }

  const bootstrapped = await input.bootstrapFromNetwork()
  if (!bootstrapped) {
    throw new Error('remote bootstrap did not produce an append base')
  }
  log(`> Mode 2 append: bootstrapped ${bootstrapped.existingUserCount} committed user MDUs from provider retrieval.`)
  return { ...bootstrapped, source: 'bootstrap' }
}
