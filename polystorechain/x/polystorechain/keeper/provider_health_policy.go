package keeper

import (
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

func reputationSlashAmount(score int64, slashBps uint64) int64 {
	if score <= 0 || slashBps == 0 {
		return 0
	}
	slash := mulDivCeil(uint64(score), slashBps, 10000)
	if slash == 0 {
		slash = 1
	}
	if slash > uint64(score) {
		return score
	}
	return int64(slash)
}

func saturatingMulUint64(a uint64, b uint64) uint64 {
	product, overflow := mulUint64(a, b)
	if overflow {
		return ^uint64(0)
	}
	return product
}

func saturatingAddUint64(a uint64, b uint64) uint64 {
	if ^uint64(0)-a < b {
		return ^uint64(0)
	}
	return a + b
}

func currentBlockHeightUint64(ctx sdk.Context) uint64 {
	if ctx.BlockHeight() <= 0 {
		return 0
	}
	return uint64(ctx.BlockHeight())
}

func hardFaultEvidence(ev types.EvidenceCase) bool {
	return ev.Slashable || ev.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD
}

func (k Keeper) applyEvidenceConsequences(ctx sdk.Context, ev types.EvidenceCase) error {
	if !hardFaultEvidence(ev) {
		return nil
	}
	if ev.Status != types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED {
		return nil
	}
	providerAddr := strings.TrimSpace(ev.Provider)
	if providerAddr == "" {
		return nil
	}

	provider, err := k.Providers.Get(ctx, providerAddr)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil
		}
		return err
	}

	params := k.GetParams(ctx)
	reputationBefore := provider.ReputationScore
	reputationSlash := reputationSlashAmount(reputationBefore, params.HardFaultReputationSlashBps)
	if reputationSlash > 0 {
		provider.ReputationScore -= reputationSlash
		if provider.ReputationScore < 0 {
			provider.ReputationScore = 0
		}
	}

	bondBefore := normalizeCoinAmount(provider.Bond)
	if strings.TrimSpace(bondBefore.Denom) == "" {
		bondBefore.Denom = sdk.DefaultBondDenom
	}
	bondSlash := providerBondSlashAmount(bondBefore, params.HardFaultBondSlashBps)
	if bondSlash.Amount.IsPositive() {
		if err := k.BankKeeper.BurnCoins(ctx, types.ProviderBondModuleName, sdk.NewCoins(bondSlash)); err != nil {
			return fmt.Errorf("failed to burn provider bond slash: %w", err)
		}
		provider.Bond = sdk.NewCoin(bondBefore.Denom, bondBefore.Amount.Sub(bondSlash.Amount))
		provider.BondSlashed = addBondCoins(provider.BondSlashed, bondSlash)
	} else {
		provider.Bond = bondBefore
		if strings.TrimSpace(provider.BondSlashed.Denom) == "" {
			provider.BondSlashed = zeroBondLike(bondBefore.Denom)
		}
	}

	jailUntilHeight := uint64(0)
	if params.JailHardFaultEpochs > 0 && params.EpochLenBlocks > 0 {
		jailBlocks := saturatingMulUint64(params.JailHardFaultEpochs, params.EpochLenBlocks)
		jailUntilHeight = saturatingAddUint64(currentBlockHeightUint64(ctx), jailBlocks)
		provider.Status = "Jailed"
		if err := k.ProviderJailUntil.Set(ctx, providerAddr, jailUntilHeight); err != nil {
			return err
		}
	}

	if err := k.Providers.Set(ctx, providerAddr, provider); err != nil {
		return err
	}

	if jailUntilHeight > 0 {
		health, err := k.deriveProviderHealthState(ctx, providerAddr)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
		if errors.Is(err, collections.ErrNotFound) {
			health = providerHealthFromProvider(provider, ctx.BlockHeight())
		}
		health.Provider = providerAddr
		health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED
		health.Reason = "hard_fault_jailed"
		health.EvidenceClass = ev.EvidenceClass
		health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD
		health.LastEvidenceCaseId = ev.Id
		health.LastDealId = ev.DealId
		health.LastSlot = ev.Slot
		health.LastEpochId = ev.EpochId
		health.UpdatedHeight = ctx.BlockHeight()
		health.ConsequenceCeiling = fmt.Sprintf("jailed until height %d; reputation slash %d; bond slash %s", jailUntilHeight, reputationSlash, bondSlash)
		if err := k.ProviderHealthStates.Set(ctx, providerAddr, health); err != nil {
			return err
		}
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"provider_hard_fault_penalty",
			sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
			sdk.NewAttribute("evidence_case_id", fmt.Sprintf("%d", ev.Id)),
			sdk.NewAttribute("reputation_before", fmt.Sprintf("%d", reputationBefore)),
			sdk.NewAttribute("reputation_slash", fmt.Sprintf("%d", reputationSlash)),
			sdk.NewAttribute("reputation_after", fmt.Sprintf("%d", provider.ReputationScore)),
			sdk.NewAttribute("bond_before", bondBefore.String()),
			sdk.NewAttribute("bond_slash", bondSlash.String()),
			sdk.NewAttribute("bond_after", provider.Bond.String()),
			sdk.NewAttribute("bond_slashed_total", provider.BondSlashed.String()),
			sdk.NewAttribute("jail_until_height", fmt.Sprintf("%d", jailUntilHeight)),
		),
	)
	return nil
}

func (k Keeper) expireProviderJails(ctx sdk.Context) error {
	height := currentBlockHeightUint64(ctx)
	expired := make([]string, 0)
	if err := k.ProviderJailUntil.Walk(ctx, nil, func(provider string, untilHeight uint64) (bool, error) {
		if untilHeight != 0 && height >= untilHeight {
			expired = append(expired, provider)
		}
		return false, nil
	}); err != nil {
		return err
	}

	for _, providerAddr := range expired {
		if err := k.ProviderJailUntil.Remove(ctx, providerAddr); err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}

		provider, err := k.Providers.Get(ctx, providerAddr)
		if err != nil {
			if errors.Is(err, collections.ErrNotFound) {
				continue
			}
			return err
		}
		if strings.EqualFold(strings.TrimSpace(provider.Status), "jailed") {
			provider.Status = "Active"
			if err := k.Providers.Set(ctx, providerAddr, provider); err != nil {
				return err
			}
		}

		health, err := k.deriveProviderHealthState(ctx, providerAddr)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
		if errors.Is(err, collections.ErrNotFound) {
			health = providerHealthFromProvider(provider, ctx.BlockHeight())
		}
		health.Provider = providerAddr
		health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
		health.Reason = "provider_jail_expired"
		health.EvidenceClass = types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL
		health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO
		health.UpdatedHeight = ctx.BlockHeight()
		health.ConsequenceCeiling = "jail window expired; provider restored to active eligibility"
		health = overlayProviderBondHealth(health, provider, k.GetParams(ctx), ctx.BlockHeight())
		if err := k.ProviderHealthStates.Set(ctx, providerAddr, health); err != nil {
			return err
		}

		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				"provider_jail_expired",
				sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
				sdk.NewAttribute("height", fmt.Sprintf("%d", height)),
			),
		)
	}
	return nil
}

func providerHealthDecayEligible(status types.ProviderLifecycleStatus) bool {
	switch status {
	case types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED,
		types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_EXITED,
		types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING:
		return false
	default:
		return true
	}
}

func quietEpochWindowElapsed(lastEpoch uint64, currentEpoch uint64, quietEpochs uint64) bool {
	if currentEpoch <= lastEpoch {
		return false
	}
	return currentEpoch-lastEpoch >= quietEpochs
}

func (k Keeper) applyProviderHealthEpochDecay(ctx sdk.Context, epochID uint64) error {
	if err := k.expireProviderJails(ctx); err != nil {
		return err
	}

	params := k.GetParams(ctx)
	if params.ProviderHealthDecayEpochs == 0 || params.ProviderHealthDecayBps == 0 {
		return nil
	}

	type update struct {
		provider string
		health   types.ProviderHealthState
	}
	updates := make([]update, 0)
	if err := k.ProviderHealthStates.Walk(ctx, nil, func(provider string, health types.ProviderHealthState) (bool, error) {
		if strings.TrimSpace(provider) == "" || health.SoftFaultCount == 0 {
			return false, nil
		}
		if !providerHealthDecayEligible(health.LifecycleStatus) {
			return false, nil
		}
		if !quietEpochWindowElapsed(health.LastEpochId, epochID, params.ProviderHealthDecayEpochs) {
			return false, nil
		}

		reduction := mulDivCeil(health.SoftFaultCount, params.ProviderHealthDecayBps, 10000)
		if reduction == 0 {
			reduction = 1
		}
		if reduction >= health.SoftFaultCount {
			health.SoftFaultCount = 0
		} else {
			health.SoftFaultCount -= reduction
		}

		health.Reason = "provider_health_decay"
		health.EvidenceClass = types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL
		health.LastEpochId = epochID
		health.UpdatedHeight = ctx.BlockHeight()
		if health.SoftFaultCount == 0 {
			if health.LifecycleStatus == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DEGRADED ||
				health.LifecycleStatus == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT {
				health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
			}
			health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO
			health.ConsequenceCeiling = "soft-fault window decayed"
		} else {
			if health.LifecycleStatus == types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT {
				health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DEGRADED
			}
			health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED
			health.ConsequenceCeiling = fmt.Sprintf("soft-fault window partially decayed; remaining=%d", health.SoftFaultCount)
		}
		updates = append(updates, update{provider: provider, health: health})
		return false, nil
	}); err != nil {
		return err
	}

	for _, update := range updates {
		if err := k.ProviderHealthStates.Set(ctx, update.provider, update.health); err != nil {
			return err
		}
		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				"provider_health_decay",
				sdk.NewAttribute(types.AttributeKeyProvider, update.provider),
				sdk.NewAttribute("epoch_id", fmt.Sprintf("%d", epochID)),
				sdk.NewAttribute("soft_fault_count", fmt.Sprintf("%d", update.health.SoftFaultCount)),
				sdk.NewAttribute("lifecycle_status", update.health.LifecycleStatus.String()),
			),
		)
	}
	return nil
}
