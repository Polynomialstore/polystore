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
	return status == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING ||
		status == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED ||
		status == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED
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
		return health, nil
	}
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return types.ProviderHealthState{}, err
	}

	provider, err := k.Providers.Get(ctx, providerAddr)
	if err != nil {
		return types.ProviderHealthState{}, err
	}
	return providerHealthFromProvider(provider, ctx.BlockHeight()), nil
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
