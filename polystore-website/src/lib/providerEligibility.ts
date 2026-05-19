export interface ProviderEligibilityProvider {
  address: string
  capabilities?: string
  status?: string
  draining?: boolean
}

export interface ProviderEligibilityHealth {
  provider: string
  lifecycle_status?: string
  reason?: string
}

export interface ProviderEligibilityCollateral {
  provider: string
  eligible_for_new_assignment?: boolean
  ineligibility_reason?: string
}

export interface ProviderEligibilitySummary {
  loaded: boolean
  providerCount: number
  eligibleCount: number
  blockedCount: number
  blockerSummary: string
}

const BLOCKING_LIFECYCLE_TOKENS = ['DELINQUENT', 'DRAINING', 'JAILED', 'EXITED']

function normalized(value: unknown): string {
  return String(value || '').trim()
}

function providerMatchesServiceHintBase(provider: ProviderEligibilityProvider, serviceHintBase: string): boolean {
  const base = normalized(serviceHintBase).toLowerCase()
  const capabilities = normalized(provider.capabilities).toLowerCase()
  switch (base) {
    case 'hot':
      return capabilities === 'general' || capabilities === 'edge'
    case 'cold':
      return capabilities === 'archive' || capabilities === 'general'
    default:
      return true
  }
}

function lifecycleBlockReason(lifecycleStatus: string): string {
  const status = normalized(lifecycleStatus).toUpperCase()
  if (!status) return ''
  for (const token of BLOCKING_LIFECYCLE_TOKENS) {
    if (status.includes(token)) return `provider health lifecycle is ${token}`
  }
  return ''
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1)
}

function formatBlockerSummary(blockers: Map<string, number>): string {
  return Array.from(blockers.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ')
}

export function summarizeProviderEligibility(
  providers: ProviderEligibilityProvider[],
  health: ProviderEligibilityHealth[],
  collateral: ProviderEligibilityCollateral[],
  options: { serviceHintBase?: string; loaded?: boolean } = {},
): ProviderEligibilitySummary {
  const healthByProvider = new Map<string, ProviderEligibilityHealth>()
  for (const item of health) {
    const provider = normalized(item.provider)
    if (provider) healthByProvider.set(provider, item)
  }

  const collateralByProvider = new Map<string, ProviderEligibilityCollateral>()
  for (const item of collateral) {
    const provider = normalized(item.provider)
    if (provider) collateralByProvider.set(provider, item)
  }

  const blockers = new Map<string, number>()
  let eligibleCount = 0
  const serviceHintBase = normalized(options.serviceHintBase) || 'General'

  for (const provider of providers) {
    const address = normalized(provider.address)
    if (!address) continue

    let blockReason = ''
    const status = normalized(provider.status)
    if (status && status.toLowerCase() !== 'active') {
      blockReason = `provider registration status is ${status}`
    } else if (provider.draining) {
      blockReason = 'provider is draining'
    } else if (!providerMatchesServiceHintBase(provider, serviceHintBase)) {
      blockReason = 'provider does not match service hint'
    }

    const collateralRecord = collateralByProvider.get(address)
    const collateralReason = normalized(collateralRecord?.ineligibility_reason)
    if (!blockReason && collateralReason) {
      blockReason = collateralReason
    } else if (!blockReason && collateralRecord?.eligible_for_new_assignment === false) {
      blockReason = 'provider collateral is not eligible for new assignment'
    }

    const healthReason = lifecycleBlockReason(healthByProvider.get(address)?.lifecycle_status || '')
    if (!blockReason && healthReason) {
      blockReason = healthReason
    }

    if (blockReason) {
      increment(blockers, blockReason)
    } else {
      eligibleCount++
    }
  }

  return {
    loaded: options.loaded ?? (health.length > 0 || collateral.length > 0),
    providerCount: providers.length,
    eligibleCount,
    blockedCount: Math.max(0, providers.length - eligibleCount),
    blockerSummary: formatBlockerSummary(blockers),
  }
}

export function formatProviderEligibilityError(
  summary: ProviderEligibilitySummary,
  requiredSlots: number,
  profileLabel: string,
): string | null {
  if (requiredSlots <= 0) return null
  if (summary.providerCount <= 0) {
    return 'Provider list not loaded yet. Retry in a few seconds.'
  }

  if (!summary.loaded) {
    if (requiredSlots > summary.providerCount) {
      return `${profileLabel} requires ${requiredSlots} registered providers (K+M), but only ${summary.providerCount} are visible.`
    }
    return null
  }

  if (requiredSlots <= summary.eligibleCount) return null

  const prefix =
    summary.eligibleCount === 0
      ? `No eligible storage providers are currently available for ${profileLabel}.`
      : `Insufficient eligible storage providers for ${profileLabel}.`
  const blockers = summary.blockerSummary ? ` Blocked SPs: ${summary.blockerSummary}.` : ''
  return `${prefix} Mode 2 needs ${requiredSlots} eligible SPs, but only ${summary.eligibleCount} of ${summary.providerCount} registered SPs can accept new slots. Providers marked draining, delinquent, jailed, exited, or underbonded cannot receive new deals.${blockers}`
}
