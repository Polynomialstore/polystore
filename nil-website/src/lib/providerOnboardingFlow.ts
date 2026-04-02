export type ProviderOnboardingStepId = 'wallet' | 'host' | 'pairing' | 'publish' | 'console'
export type ProviderOnboardingStepState = 'ready' | 'pending' | 'action' | 'idle'

export interface ProviderOnboardingFlowInput {
  walletReady: boolean
  funded: boolean
  hasOperatorAddress: boolean
  providerRepoReady: boolean
  providerKeyReady: boolean
  pairingLinked: boolean
  pairingConfirmed: boolean
  endpointReady: boolean
  providerRegistered: boolean
  publicHealthReady: boolean
}

export interface ProviderOnboardingStepDefinition {
  id: ProviderOnboardingStepId
  label: string
  anchor: string
  doneWhen: string
}

export interface ProviderOnboardingStepView extends ProviderOnboardingStepDefinition {
  index: number
  ready: boolean
  state: ProviderOnboardingStepState
  statusLabel: string
}

export interface ProviderOnboardingFlowState {
  steps: ProviderOnboardingStepView[]
  stepReadyById: Record<ProviderOnboardingStepId, boolean>
  currentStepId: ProviderOnboardingStepId
  currentStepIndex: number
  currentStep: ProviderOnboardingStepView
  nextActionMessage: string
  commandReady: boolean
}

export const PROVIDER_ONBOARDING_STEPS: ProviderOnboardingStepDefinition[] = [
  {
    id: 'wallet',
    label: 'Connect Operator Wallet',
    anchor: 'step-wallet',
    doneWhen: 'wallet is connected, on NilStore testnet, and funded for approval',
  },
  {
    id: 'host',
    label: 'Prepare Provider Host',
    anchor: 'step-host-setup',
    doneWhen: 'provider host has a local nil-store checkout ready for commands',
  },
  {
    id: 'pairing',
    label: 'Pair Provider Identity',
    anchor: 'step-pairing',
    doneWhen: 'provider key name is set and the provider link is approved on-chain',
  },
  {
    id: 'publish',
    label: 'Publish Endpoint + Bootstrap',
    anchor: 'step-publish-bootstrap',
    doneWhen: 'public endpoint is defined and bootstrap plus health converge',
  },
  {
    id: 'console',
    label: 'Open Provider Console',
    anchor: 'step-console',
    doneWhen: 'you are in /sp-dashboard to manage this provider',
  },
]

function stepState(
  ready: boolean,
  index: number,
  currentStepIndex: number,
): ProviderOnboardingStepState {
  if (ready) return 'ready'
  if (index === currentStepIndex) return 'action'
  if (index === currentStepIndex + 1) return 'pending'
  return 'idle'
}

function stepStatusLabel(
  ready: boolean,
  index: number,
  currentStepIndex: number,
): string {
  if (ready) return 'Ready'
  if (index === currentStepIndex) return 'Do now'
  if (index === currentStepIndex + 1) return 'Next'
  return 'Queued'
}

function walletNextAction(input: ProviderOnboardingFlowInput): string {
  if (!input.hasOperatorAddress) {
    return 'Connect the operator wallet so this page can capture the Nil address used for provider approval.'
  }
  if (!input.walletReady) {
    return 'Switch the browser wallet to NilStore testnet before moving on.'
  }
  if (!input.funded) {
    return 'Fund the browser wallet so it can approve the provider link transaction.'
  }
  return 'Operator wallet is ready.'
}

function hostNextAction(input: ProviderOnboardingFlowInput): string {
  if (!input.providerRepoReady) {
    return 'Clone nil-store on the provider host and run the onboarding commands from that checkout.'
  }
  return 'Provider host checkout is ready.'
}

function pairingNextAction(input: ProviderOnboardingFlowInput): string {
  if (!input.providerRepoReady) {
    return 'Finish Step 2 first so the provider host can run the pair command.'
  }
  if (!input.providerKeyReady) {
    return 'Set the provider key name that the provider host commands should use.'
  }
  if (!input.hasOperatorAddress) {
    return 'Finish Step 1 so this page has the operator wallet Nil address for pairing.'
  }
  if (input.pairingLinked && !input.pairingConfirmed) {
    return 'Approve the pending provider link from the browser wallet in this step.'
  }
  if (!input.pairingConfirmed) {
    return 'Run the provider-host pair command, then refresh until the pending link appears.'
  }
  return 'Provider identity is paired and approved on-chain.'
}

function publishNextAction(input: ProviderOnboardingFlowInput): string {
  if (!input.providerRepoReady) {
    return 'Finish Step 2 so the provider host commands can run from a local nil-store checkout.'
  }
  if (!input.providerKeyReady || !input.pairingConfirmed) {
    return 'Finish Step 3 by setting the provider key name, running the pair command, and approving the provider link before bootstrap.'
  }
  if (!input.endpointReady) {
    return 'Finish Step 4 so the bootstrap command has the public endpoint.'
  }
  if (!input.providerRegistered && !input.publicHealthReady) {
    return 'Run the provider host bootstrap command, then watch registration and public health converge.'
  }
  if (!input.providerRegistered) {
    return 'Wait for bootstrap to register or update the provider endpoints on-chain.'
  }
  if (!input.publicHealthReady) {
    return 'Wait for provider health to converge after bootstrap, then refresh the verification cards.'
  }
  return 'Publish and bootstrap checks are healthy.'
}

function consoleNextAction(): string {
  return 'Onboarding is healthy. Open Provider Console to monitor and operate this provider.'
}

function nextActionForStep(
  stepId: ProviderOnboardingStepId,
  input: ProviderOnboardingFlowInput,
): string {
  if (stepId === 'wallet') return walletNextAction(input)
  if (stepId === 'host') return hostNextAction(input)
  if (stepId === 'pairing') return pairingNextAction(input)
  if (stepId === 'publish') return publishNextAction(input)
  return consoleNextAction()
}

export function buildProviderOnboardingFlow(
  input: ProviderOnboardingFlowInput,
): ProviderOnboardingFlowState {
  const stepReadyById: Record<ProviderOnboardingStepId, boolean> = {
    wallet: input.walletReady && input.funded && input.hasOperatorAddress,
    host: input.providerRepoReady,
    pairing: input.providerKeyReady && input.pairingConfirmed,
    publish: input.pairingConfirmed && input.endpointReady && input.providerRegistered && input.publicHealthReady,
    console: false,
  }

  const currentStepId: ProviderOnboardingStepId = !stepReadyById.wallet
    ? 'wallet'
    : !stepReadyById.host
      ? 'host'
      : !stepReadyById.pairing
        ? 'pairing'
        : !stepReadyById.publish
          ? 'publish'
          : 'console'

  const currentStepIndex = PROVIDER_ONBOARDING_STEPS.findIndex((step) => step.id === currentStepId)

  const steps = PROVIDER_ONBOARDING_STEPS.map((step, index) => {
    const ready = stepReadyById[step.id]
    return {
      ...step,
      index,
      ready,
      state: stepState(ready, index, currentStepIndex),
      statusLabel: stepStatusLabel(ready, index, currentStepIndex),
    }
  })

  const commandReady = input.hasOperatorAddress
    && input.providerRepoReady
    && input.providerKeyReady
    && input.pairingConfirmed
    && input.endpointReady

  return {
    steps,
    stepReadyById,
    currentStepId,
    currentStepIndex,
    currentStep: steps[currentStepIndex],
    nextActionMessage: nextActionForStep(currentStepId, input),
    commandReady,
  }
}
