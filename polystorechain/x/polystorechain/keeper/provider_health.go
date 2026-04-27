package keeper

import (
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

func providerLifecycleFromRegistration(provider types.Provider) types.ProviderLifecycleStatus {
	status := strings.TrimSpace(strings.ToLower(provider.Status))
	switch {
	case status == "jailed":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED
	case status == "exited":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED
	case provider.Draining:
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING
	case status == "offline":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DEGRADED
	case status == "active":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
	case status == "paired":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_PAIRED
	case status == "probationary":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_PROBATIONARY
	case status == "preferred":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_PREFERRED
	case status == "high_bandwidth":
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_HIGH_BANDWIDTH
	default:
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
	}
}

func providerHealthFromProvider(provider types.Provider, height int64) types.ProviderHealthState {
	lifecycle := providerLifecycleFromRegistration(provider)
	reason := "provider_active"
	severity := types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO
	if lifecycle == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING {
		reason = "provider_draining"
		severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR
	} else if lifecycle == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED {
		reason = "provider_jailed"
		severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD
	} else if lifecycle == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED {
		reason = "provider_exited"
		severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO
	} else if lifecycle == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DEGRADED {
		reason = "provider_offline"
		severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED
	}

	return types.ProviderHealthState{
		Provider:           strings.TrimSpace(provider.Address),
		LifecycleStatus:    lifecycle,
		Reason:             reason,
		EvidenceClass:      types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
		Severity:           severity,
		UpdatedHeight:      height,
		ConsequenceCeiling: "registration state only",
	}
}

func isAdministrativeProviderLifecycle(status types.ProviderLifecycleStatus) bool {
	return status == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED ||
		status == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED
}

func shouldOverlayRegistrationLifecycle(current types.ProviderLifecycleStatus, registration types.ProviderLifecycleStatus) bool {
	if current == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_UNSPECIFIED {
		return true
	}
	if isAdministrativeProviderLifecycle(registration) {
		return true
	}
	if registration == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING &&
		current != types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT {
		return true
	}
	return false
}

func providerHealthFromProviderOverlay(health types.ProviderHealthState, provider types.Provider, height int64) types.ProviderHealthState {
	registration := providerHealthFromProvider(provider, height)
	if health.Provider == "" {
		health.Provider = registration.Provider
	}
	if shouldOverlayRegistrationLifecycle(health.LifecycleStatus, registration.LifecycleStatus) {
		health.LifecycleStatus = registration.LifecycleStatus
		health.Reason = registration.Reason
		health.EvidenceClass = registration.EvidenceClass
		health.Severity = registration.Severity
		health.UpdatedHeight = height
		health.ConsequenceCeiling = registration.ConsequenceCeiling
	}
	return health
}

func providerLifecycleFromEvidence(ev types.EvidenceCase, current types.ProviderHealthState) types.ProviderLifecycleStatus {
	if isAdministrativeProviderLifecycle(current.LifecycleStatus) {
		return current.LifecycleStatus
	}

	switch {
	case ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD || ev.Slashable:
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT
	case ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT ||
		ev.Status == types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED:
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT
	case ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED ||
		ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_SOFT:
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DEGRADED
	case ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR:
		if current.LifecycleStatus != types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_UNSPECIFIED {
			return current.LifecycleStatus
		}
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
	default:
		if current.LifecycleStatus != types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_UNSPECIFIED {
			return current.LifecycleStatus
		}
		return types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
	}
}

func (k Keeper) deriveProviderHealthState(ctx sdk.Context, providerAddr string) (types.ProviderHealthState, error) {
	providerAddr = strings.TrimSpace(providerAddr)
	if providerAddr == "" {
		return types.ProviderHealthState{}, collections.ErrNotFound
	}

	health, err := k.ProviderHealthStates.Get(ctx, providerAddr)
	if err == nil {
		if provider, providerErr := k.Providers.Get(ctx, providerAddr); providerErr == nil {
			active, pending, countErr := k.providerMode2AssignmentCounts(ctx, providerAddr)
			if countErr != nil {
				return types.ProviderHealthState{}, countErr
			}
			health = providerHealthFromProviderOverlay(health, provider, ctx.BlockHeight())
			health = overlayProviderBondHealth(health, provider, k.GetParams(ctx), ctx.BlockHeight(), active+pending)
		}
		return health, nil
	}
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return types.ProviderHealthState{}, err
	}

	provider, err := k.Providers.Get(ctx, providerAddr)
	if err != nil {
		return types.ProviderHealthState{}, err
	}
	health = providerHealthFromProvider(provider, ctx.BlockHeight())
	active, pending, err := k.providerMode2AssignmentCounts(ctx, providerAddr)
	if err != nil {
		return types.ProviderHealthState{}, err
	}
	return overlayProviderBondHealth(health, provider, k.GetParams(ctx), ctx.BlockHeight(), active+pending), nil
}

func providerLifecyclePlacementIneligibility(status types.ProviderLifecycleStatus) string {
	switch status {
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING:
		return "provider health lifecycle is DRAINING"
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT:
		return "provider health lifecycle is DELINQUENT"
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED:
		return "provider health lifecycle is JAILED"
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED:
		return "provider health lifecycle is EXITED"
	default:
		return ""
	}
}

func providerLifecycleRewardIneligibility(status types.ProviderLifecycleStatus) string {
	switch status {
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT:
		return "provider health lifecycle is DELINQUENT"
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED:
		return "provider health lifecycle is JAILED"
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED:
		return "provider health lifecycle is EXITED"
	default:
		return ""
	}
}

func (k Keeper) providerHealthPlacementIneligibility(ctx sdk.Context, provider types.Provider) (string, error) {
	return k.providerHealthPlacementIneligibilityForAssignments(ctx, provider, 0)
}

func (k Keeper) providerHealthPlacementIneligibilityForAssignments(ctx sdk.Context, provider types.Provider, additionalAssignments uint64) (string, error) {
	counts, err := k.providerMode2AssignmentCountSnapshot(ctx)
	if err != nil {
		return "", err
	}
	return k.providerHealthPlacementIneligibilityForAssignmentsWithCounts(ctx, provider, additionalAssignments, counts)
}

func (k Keeper) providerHealthPlacementIneligibilityForAssignmentsWithCounts(ctx sdk.Context, provider types.Provider, additionalAssignments uint64, counts providerAssignmentCountSnapshot) (string, error) {
	providerAddr := strings.TrimSpace(provider.Address)
	if providerAddr == "" {
		return "", nil
	}
	if reason := providerLifecyclePlacementIneligibility(providerLifecycleFromRegistration(provider)); reason != "" {
		return reason, nil
	}
	if reason := k.providerAssignmentCollateralIneligibilityWithCounts(ctx, provider, additionalAssignments, counts); reason != "" {
		return reason, nil
	}
	health, err := k.ProviderHealthStates.Get(ctx, providerAddr)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	health = providerHealthFromProviderOverlay(health, provider, ctx.BlockHeight())
	return providerLifecyclePlacementIneligibility(health.LifecycleStatus), nil
}

func (k Keeper) providerHealthRewardIneligibility(ctx sdk.Context, provider types.Provider) (string, error) {
	providerAddr := strings.TrimSpace(provider.Address)
	if providerAddr == "" {
		return "", nil
	}
	if reason := providerLifecycleRewardIneligibility(providerLifecycleFromRegistration(provider)); reason != "" {
		return reason, nil
	}
	reason, err := k.providerAssignmentCollateralIneligibility(ctx, provider, 0)
	if err != nil {
		return "", err
	}
	if reason != "" {
		return reason, nil
	}
	health, err := k.ProviderHealthStates.Get(ctx, providerAddr)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	health = providerHealthFromProviderOverlay(health, provider, ctx.BlockHeight())
	return providerLifecycleRewardIneligibility(health.LifecycleStatus), nil
}

func (k Keeper) updateProviderHealthFromEvidence(ctx sdk.Context, ev types.EvidenceCase) error {
	providerAddr := strings.TrimSpace(ev.Provider)
	if providerAddr == "" {
		return nil
	}

	current, err := k.deriveProviderHealthState(ctx, providerAddr)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if errors.Is(err, collections.ErrNotFound) {
		current = types.ProviderHealthState{
			Provider:           providerAddr,
			LifecycleStatus:    types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE,
			Reason:             "provider_unregistered_evidence",
			EvidenceClass:      types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
			Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO,
			ConsequenceCeiling: "evidence for unknown provider",
		}
	}

	health := current
	health.Provider = providerAddr
	health.LifecycleStatus = providerLifecycleFromEvidence(ev, current)
	health.Reason = strings.TrimSpace(ev.Reason)
	health.EvidenceClass = ev.EvidenceClass
	health.Severity = ev.Severity
	health.LastEvidenceCaseId = ev.Id
	health.LastDealId = ev.DealId
	health.LastSlot = ev.Slot
	health.LastEpochId = ev.EpochId
	health.UpdatedHeight = ctx.BlockHeight()
	health.ConsequenceCeiling = strings.TrimSpace(ev.ConsequenceCeiling)

	switch {
	case ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD || ev.Slashable:
		health.HardFaultCount += ev.Count
	case ev.CountsAsFailure ||
		ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT ||
		ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED ||
		ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_SOFT:
		health.SoftFaultCount += ev.Count
	}
	if ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR || strings.Contains(strings.ToLower(ev.Reason), "repair") {
		health.RepairEventCount += ev.Count
	}

	return k.ProviderHealthStates.Set(ctx, providerAddr, health)
}
