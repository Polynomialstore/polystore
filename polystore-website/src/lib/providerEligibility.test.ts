import assert from 'node:assert/strict'
import test from 'node:test'
import { formatProviderEligibilityError, summarizeProviderEligibility } from './providerEligibility'

test('provider eligibility excludes delinquent and draining providers', () => {
  const providers = [
    { address: 'nil1active', capabilities: 'General', status: 'Active' },
    { address: 'nil1delinquent', capabilities: 'General', status: 'Active' },
    { address: 'nil1draining', capabilities: 'General', status: 'Active', draining: true },
  ]
  const health = [
    {
      provider: 'nil1delinquent',
      lifecycle_status: 'PROVIDER_LIFECYCLE_STATUS_DELINQUENT',
      reason: 'quota_miss_repair_started',
    },
  ]
  const summary = summarizeProviderEligibility(providers, health, [], { loaded: true })

  assert.equal(summary.providerCount, 3)
  assert.equal(summary.eligibleCount, 1)
  assert.match(summary.blockerSummary, /DELINQUENT/)
  assert.match(summary.blockerSummary, /provider is draining/)
})

test('formatProviderEligibilityError explains zero eligible SPs', () => {
  const summary = summarizeProviderEligibility(
    [
      { address: 'nil1a', capabilities: 'General', status: 'Active' },
      { address: 'nil1b', capabilities: 'General', status: 'Active' },
      { address: 'nil1c', capabilities: 'General', status: 'Active' },
    ],
    [],
    [
      { provider: 'nil1a', ineligibility_reason: 'provider health lifecycle is DELINQUENT' },
      { provider: 'nil1b', ineligibility_reason: 'provider health lifecycle is DELINQUENT' },
      { provider: 'nil1c', ineligibility_reason: 'provider health lifecycle is DRAINING' },
    ],
    { loaded: true },
  )

  assert.equal(summary.eligibleCount, 0)
  assert.match(
    formatProviderEligibilityError(summary, 3, 'Default Mode 2 2+1') || '',
    /No eligible storage providers.*Mode 2 needs 3 eligible SPs/,
  )
})

test('provider eligibility blocks collateral-ineligible providers even without a reason string', () => {
  const summary = summarizeProviderEligibility(
    [{ address: 'nil1underbonded', capabilities: 'General', status: 'Active' }],
    [],
    [{ provider: 'nil1underbonded', eligible_for_new_assignment: false }],
    { loaded: true },
  )

  assert.equal(summary.eligibleCount, 0)
  assert.match(summary.blockerSummary, /collateral is not eligible/)
})

test('formatProviderEligibilityError waits for health surfaces when provider count is sufficient', () => {
  const summary = summarizeProviderEligibility(
    [
      { address: 'nil1a', capabilities: 'General', status: 'Active' },
      { address: 'nil1b', capabilities: 'General', status: 'Active' },
      { address: 'nil1c', capabilities: 'General', status: 'Active' },
    ],
    [],
    [],
    { loaded: false },
  )

  assert.equal(formatProviderEligibilityError(summary, 3, 'Default Mode 2 2+1'), null)
})
