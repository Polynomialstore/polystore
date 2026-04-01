import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProviderOnboardingFlow,
  PROVIDER_ONBOARDING_STEPS,
  type ProviderOnboardingFlowInput,
} from './providerOnboardingFlow'

function baseInput(): ProviderOnboardingFlowInput {
  return {
    walletReady: true,
    funded: true,
    hasOperatorAddress: true,
    providerRepoReady: true,
    providerKeyReady: true,
    pairingLinked: true,
    pairingConfirmed: true,
    endpointReady: true,
    hasAuthToken: true,
    providerRegistered: true,
    publicHealthReady: true,
  }
}

test('provider onboarding flow exposes the revised 5-step model', () => {
  assert.deepEqual(
    PROVIDER_ONBOARDING_STEPS.map((step) => step.id),
    ['wallet', 'host', 'pairing', 'public_access', 'bootstrap'],
  )
})

test('provider onboarding flow marks the happy path complete and command-ready', () => {
  const flow = buildProviderOnboardingFlow(baseInput())

  assert.equal(flow.currentStepId, 'bootstrap')
  assert.equal(flow.commandReady, true)
  assert.equal(flow.nextActionMessage, 'Bootstrap and verification are complete.')
  assert.deepEqual(
    flow.steps.map((step) => ({ id: step.id, ready: step.ready, state: step.state })),
    [
      { id: 'wallet', ready: true, state: 'ready' },
      { id: 'host', ready: true, state: 'ready' },
      { id: 'pairing', ready: true, state: 'ready' },
      { id: 'public_access', ready: true, state: 'ready' },
      { id: 'bootstrap', ready: true, state: 'ready' },
    ],
  )
})

test('provider onboarding flow keeps the wallet step active until the wallet is connected and funded', () => {
  const disconnected = buildProviderOnboardingFlow({
    ...baseInput(),
    walletReady: false,
    funded: false,
    hasOperatorAddress: false,
  })

  assert.equal(disconnected.currentStepId, 'wallet')
  assert.match(disconnected.nextActionMessage, /capture the Nil address used for provider approval/i)
  assert.equal(disconnected.steps[0]?.statusLabel, 'Do now')

  const unfunded = buildProviderOnboardingFlow({
    ...baseInput(),
    funded: false,
  })

  assert.equal(unfunded.currentStepId, 'wallet')
  assert.match(unfunded.nextActionMessage, /Fund the browser wallet/i)
})

test('provider onboarding flow advances to host setup when the wallet is ready but the repo is missing', () => {
  const flow = buildProviderOnboardingFlow({
    ...baseInput(),
    providerRepoReady: false,
    pairingLinked: false,
    pairingConfirmed: false,
    endpointReady: false,
    hasAuthToken: false,
    providerRegistered: false,
    publicHealthReady: false,
  })

  assert.equal(flow.currentStepId, 'host')
  assert.equal(flow.steps[1]?.state, 'action')
  assert.equal(flow.steps[2]?.state, 'pending')
  assert.match(flow.nextActionMessage, /Clone nil-store on the provider host/i)
})

test('provider onboarding flow blocks pairing on key setup and approval state in the right order', () => {
  const missingKeyName = buildProviderOnboardingFlow({
    ...baseInput(),
    providerKeyReady: false,
    pairingLinked: false,
    pairingConfirmed: false,
  })

  assert.equal(missingKeyName.currentStepId, 'pairing')
  assert.match(missingKeyName.nextActionMessage, /Set the provider key name/i)
  assert.equal(missingKeyName.commandReady, false)

  const needsInit = buildProviderOnboardingFlow({
    ...baseInput(),
    pairingLinked: false,
    pairingConfirmed: false,
  })

  assert.equal(needsInit.currentStepId, 'pairing')
  assert.match(needsInit.nextActionMessage, /Run the provider-host pair command/i)

  const needsLinkRequest = buildProviderOnboardingFlow({
    ...baseInput(),
    pairingLinked: false,
    pairingConfirmed: false,
  })

  assert.equal(needsLinkRequest.currentStepId, 'pairing')
  assert.match(needsLinkRequest.nextActionMessage, /Run the provider-host pair command/i)

  const needsBrowserApproval = buildProviderOnboardingFlow({
    ...baseInput(),
    pairingLinked: true,
    pairingConfirmed: false,
  })

  assert.equal(needsBrowserApproval.currentStepId, 'pairing')
  assert.match(needsBrowserApproval.nextActionMessage, /Approve the pending provider link/i)
})

test('provider onboarding flow gates public access on endpoint then shared auth', () => {
  const missingBoth = buildProviderOnboardingFlow({
    ...baseInput(),
    endpointReady: false,
    hasAuthToken: false,
  })

  assert.equal(missingBoth.currentStepId, 'public_access')
  assert.match(missingBoth.nextActionMessage, /Describe the public provider endpoint and paste the shared provider auth token/i)

  const missingEndpoint = buildProviderOnboardingFlow({
    ...baseInput(),
    endpointReady: false,
  })

  assert.equal(missingEndpoint.currentStepId, 'public_access')
  assert.match(missingEndpoint.nextActionMessage, /Describe the public endpoint/i)

  const missingAuth = buildProviderOnboardingFlow({
    ...baseInput(),
    hasAuthToken: false,
  })

  assert.equal(missingAuth.currentStepId, 'public_access')
  assert.match(missingAuth.nextActionMessage, /Paste the shared provider auth token/i)
})

test('provider onboarding flow only marks bootstrap step ready after registration and health converge', () => {
  const readyToRun = buildProviderOnboardingFlow({
    ...baseInput(),
    providerRegistered: false,
    publicHealthReady: false,
  })

  assert.equal(readyToRun.currentStepId, 'bootstrap')
  assert.equal(readyToRun.commandReady, true)
  assert.match(readyToRun.nextActionMessage, /Run the provider host bootstrap command/i)

  const waitingForRegistration = buildProviderOnboardingFlow({
    ...baseInput(),
    providerRegistered: false,
  })

  assert.equal(waitingForRegistration.currentStepId, 'bootstrap')
  assert.match(waitingForRegistration.nextActionMessage, /register or update the provider endpoints/i)

  const waitingForHealth = buildProviderOnboardingFlow({
    ...baseInput(),
    publicHealthReady: false,
  })

  assert.equal(waitingForHealth.currentStepId, 'bootstrap')
  assert.match(waitingForHealth.nextActionMessage, /Wait for provider health to converge/i)
})

test('provider onboarding flow keeps bootstrap command unavailable until pairing and public access are complete', () => {
  const flow = buildProviderOnboardingFlow({
    ...baseInput(),
    pairingConfirmed: false,
    endpointReady: false,
    hasAuthToken: false,
  })

  assert.equal(flow.commandReady, false)
  assert.equal(flow.currentStepId, 'pairing')
})
