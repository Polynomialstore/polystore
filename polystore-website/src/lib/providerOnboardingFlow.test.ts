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
    providerRegistered: true,
    publicHealthReady: true,
  }
}

test('provider onboarding flow exposes the revised 5-step model with console handoff', () => {
  assert.deepEqual(
    PROVIDER_ONBOARDING_STEPS.map((step) => step.id),
    ['wallet', 'host', 'pairing', 'publish', 'console'],
  )
})

test('provider onboarding flow moves healthy providers to the console handoff step', () => {
  const flow = buildProviderOnboardingFlow(baseInput())

  assert.equal(flow.currentStepId, 'console')
  assert.equal(flow.commandReady, true)
  assert.match(flow.nextActionMessage, /Open Provider Console/i)
  assert.deepEqual(
    flow.steps.map((step) => ({ id: step.id, ready: step.ready, state: step.state })),
    [
      { id: 'wallet', ready: true, state: 'ready' },
      { id: 'host', ready: true, state: 'ready' },
      { id: 'pairing', ready: true, state: 'ready' },
      { id: 'publish', ready: true, state: 'ready' },
      { id: 'console', ready: false, state: 'action' },
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
    providerRegistered: false,
    publicHealthReady: false,
  })

  assert.equal(flow.currentStepId, 'host')
  assert.equal(flow.steps[1]?.state, 'action')
  assert.equal(flow.steps[2]?.state, 'pending')
  assert.match(flow.nextActionMessage, /Clone polystore on the provider host/i)
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

test('provider onboarding flow gates publish step on endpoint readiness', () => {
  const missingEndpoint = buildProviderOnboardingFlow({
    ...baseInput(),
    endpointReady: false,
  })

  assert.equal(missingEndpoint.currentStepId, 'publish')
  assert.match(missingEndpoint.nextActionMessage, /public endpoint/i)
})

test('provider onboarding flow only marks publish step ready after registration and health converge', () => {
  const readyToRun = buildProviderOnboardingFlow({
    ...baseInput(),
    providerRegistered: false,
    publicHealthReady: false,
  })

  assert.equal(readyToRun.currentStepId, 'publish')
  assert.equal(readyToRun.commandReady, true)
  assert.match(readyToRun.nextActionMessage, /Run the provider host bootstrap command/i)

  const waitingForRegistration = buildProviderOnboardingFlow({
    ...baseInput(),
    providerRegistered: false,
  })

  assert.equal(waitingForRegistration.currentStepId, 'publish')
  assert.match(waitingForRegistration.nextActionMessage, /register or update the provider endpoints/i)

  const waitingForHealth = buildProviderOnboardingFlow({
    ...baseInput(),
    publicHealthReady: false,
  })

  assert.equal(waitingForHealth.currentStepId, 'publish')
  assert.match(waitingForHealth.nextActionMessage, /Wait for provider health to converge/i)
})

test('provider onboarding flow reaches console handoff only after publish checks are healthy', () => {
  const flow = buildProviderOnboardingFlow(baseInput())

  assert.equal(flow.stepReadyById.publish, true)
  assert.equal(flow.currentStepId, 'console')
  assert.equal(flow.steps[4]?.statusLabel, 'Do now')
})

test('provider onboarding flow keeps bootstrap command unavailable until pairing and endpoint setup are complete', () => {
  const flow = buildProviderOnboardingFlow({
    ...baseInput(),
    pairingConfirmed: false,
    endpointReady: false,
  })

  assert.equal(flow.commandReady, false)
  assert.equal(flow.currentStepId, 'pairing')
})
