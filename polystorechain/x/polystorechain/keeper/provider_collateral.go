package keeper

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

type providerAssignmentCounts struct {
	active  uint64
	pending uint64
}

type providerAssignmentCountSnapshot map[string]providerAssignmentCounts

func (s providerAssignmentCountSnapshot) countsFor(providerAddr string) (uint64, uint64) {
	counts := s[strings.TrimSpace(providerAddr)]
	return counts.active, counts.pending
}

func assignmentCountTotal(active uint64, pending uint64) uint64 {
	total, overflow := addUint64(active, pending)
	if overflow {
		return ^uint64(0)
	}
	return total
}

func assignmentCountWithAdditional(active uint64, pending uint64, additional uint64) uint64 {
	total := assignmentCountTotal(active, pending)
	total, overflow := addUint64(total, additional)
	if overflow {
		return ^uint64(0)
	}
	return total
}

func (s providerAssignmentCountSnapshot) incrementPending(providerAddr string) {
	providerAddr = strings.TrimSpace(providerAddr)
	if providerAddr == "" {
		return
	}
	counts := s[providerAddr]
	if counts.pending < ^uint64(0) {
		counts.pending++
	}
	s[providerAddr] = counts
}

func incrementAssignmentCount(count *uint64) {
	if *count < ^uint64(0) {
		*count++
	}
}

func (k Keeper) providerMode2DealAssignmentCountSnapshot(ctx sdk.Context) (providerAssignmentCountSnapshot, error) {
	height := uint64(ctx.BlockHeight())
	snapshot := make(providerAssignmentCountSnapshot)
	err := k.Deals.Walk(ctx, nil, func(_ uint64, deal types.Deal) (bool, error) {
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 {
			return false, nil
		}
		for _, slot := range deal.Mode2Slots {
			if slot == nil {
				continue
			}
			switch slot.Status {
			case types.SlotStatus_SLOT_STATUS_ACTIVE:
				providerAddr := strings.TrimSpace(slot.Provider)
				if providerAddr == "" {
					continue
				}
				counts := snapshot[providerAddr]
				incrementAssignmentCount(&counts.active)
				snapshot[providerAddr] = counts
			case types.SlotStatus_SLOT_STATUS_REPAIRING:
				providerAddr := strings.TrimSpace(slot.PendingProvider)
				if providerAddr == "" {
					continue
				}
				counts := snapshot[providerAddr]
				incrementAssignmentCount(&counts.pending)
				snapshot[providerAddr] = counts
			}
		}
		return false, nil
	})
	return snapshot, err
}

func (k Keeper) providerAssignmentLockCountSnapshot(ctx sdk.Context) (providerAssignmentCountSnapshot, uint64, error) {
	snapshot := make(providerAssignmentCountSnapshot)
	dealActive := make(map[uint64]bool)
	height := uint64(ctx.BlockHeight())
	var total uint64
	err := k.AssignmentCollateralLocks.Walk(ctx, nil, func(key assignmentCollateralLockKey, lock types.AssignmentCollateralLock) (bool, error) {
		dealID := lock.DealId
		if dealID == 0 {
			dealID = key.K2().K1()
		}
		active, ok := dealActive[dealID]
		if !ok {
			deal, err := k.Deals.Get(ctx, dealID)
			if err != nil {
				if errors.Is(err, collections.ErrNotFound) {
					return false, nil
				}
				return false, err
			}
			active = deal.RedundancyMode == 2 && height >= deal.StartBlock && height < deal.EndBlock
			dealActive[dealID] = active
		}
		if !active {
			return false, nil
		}

		providerAddr := strings.TrimSpace(lock.Provider)
		if providerAddr == "" {
			providerAddr = strings.TrimSpace(key.K1())
		}
		if providerAddr == "" {
			return false, nil
		}

		counts := snapshot[providerAddr]
		switch lock.Role {
		case types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE:
			incrementAssignmentCount(&counts.active)
		case types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_PENDING_REPAIR:
			incrementAssignmentCount(&counts.pending)
		default:
			return false, nil
		}
		snapshot[providerAddr] = counts
		incrementAssignmentCount(&total)
		return false, nil
	})
	return snapshot, total, err
}

func (k Keeper) assignmentCollateralLockLedgerEnabled(ctx sdk.Context) (bool, error) {
	perSlot, err := normalizeAssignmentCollateralPerSlot(k.GetParams(ctx))
	if err != nil {
		return false, err
	}
	return perSlot.IsPositive(), nil
}

func (k Keeper) providerMode2AssignmentCountSnapshot(ctx sdk.Context) (providerAssignmentCountSnapshot, error) {
	useLocks, err := k.assignmentCollateralLockLedgerEnabled(ctx)
	if err != nil {
		return nil, err
	}
	if useLocks {
		lockCounts, lockTotal, err := k.providerAssignmentLockCountSnapshot(ctx)
		if err != nil {
			return nil, err
		}
		if lockTotal > 0 {
			return lockCounts, nil
		}
	}

	return k.providerMode2DealAssignmentCountSnapshot(ctx)
}

func (k Keeper) providerMode2AssignmentCounts(ctx sdk.Context, providerAddr string) (active uint64, pending uint64, err error) {
	providerAddr = strings.TrimSpace(providerAddr)
	if providerAddr == "" {
		return 0, 0, nil
	}

	snapshot, err := k.providerMode2AssignmentCountSnapshot(ctx)
	if err != nil {
		return 0, 0, err
	}
	active, pending = snapshot.countsFor(providerAddr)
	return active, pending, nil
}

func (k Keeper) providerAssignmentCollateralIneligibility(ctx sdk.Context, provider types.Provider, additionalAssignments uint64) (string, error) {
	counts, err := k.providerMode2AssignmentCountSnapshot(ctx)
	if err != nil {
		return "", err
	}
	return k.providerAssignmentCollateralIneligibilityWithCounts(ctx, provider, additionalAssignments, counts), nil
}

func (k Keeper) providerAssignmentCollateralIneligibilityWithCounts(ctx sdk.Context, provider types.Provider, additionalAssignments uint64, counts providerAssignmentCountSnapshot) string {
	active, pending := counts.countsFor(provider.Address)
	assignments := assignmentCountWithAdditional(active, pending, additionalAssignments)
	return providerBondPlacementIneligibilityForAssignments(provider, k.GetParams(ctx), assignments)
}

func (k Keeper) affordableActiveAssignments(ctx sdk.Context, provider types.Provider) (uint64, string, error) {
	affordable, reason, err := providerBondAffordableAssignments(provider, k.GetParams(ctx))
	if err != nil {
		return 0, "", err
	}
	return affordable, reason, nil
}

func (k Keeper) deriveProviderCollateralSummary(ctx sdk.Context, provider types.Provider, counts providerAssignmentCountSnapshot) (types.ProviderCollateralSummary, error) {
	providerAddr := strings.TrimSpace(provider.Address)
	params := k.GetParams(ctx)

	minBond, err := normalizeMinProviderBond(params)
	if err != nil {
		return types.ProviderCollateralSummary{}, err
	}
	perSlot, err := normalizeAssignmentCollateralPerSlot(params)
	if err != nil {
		return types.ProviderCollateralSummary{}, err
	}
	active, pending := counts.countsFor(providerAddr)
	total := assignmentCountTotal(active, pending)
	required, err := providerBondRequirementForAssignments(params, total)
	if err != nil {
		return types.ProviderCollateralSummary{}, err
	}
	affordable, affordableReason, err := providerBondAffordableAssignments(provider, params)
	if err != nil {
		return types.ProviderCollateralSummary{}, err
	}

	bond := normalizeCoinAmount(provider.Bond)
	if strings.TrimSpace(bond.Denom) == "" {
		bond.Denom = minBond.Denom
	}

	summary := types.ProviderCollateralSummary{
		Provider:                    providerAddr,
		ActiveAssignments:           active,
		PendingAssignments:          pending,
		TotalAssignments:            total,
		Bond:                        bond,
		MinProviderBond:             minBond,
		AssignmentCollateralPerSlot: perSlot,
		RequiredCollateral:          required,
		AffordableAssignments:       affordable,
	}

	if affordable == ^uint64(0) {
		summary.UnlimitedAssignments = true
	} else if affordable >= total {
		summary.AssignmentHeadroom = affordable - total
	} else {
		summary.OverassignedAssignments = total - affordable
	}

	reason, err := k.providerHealthPlacementIneligibilityForAssignmentsWithCounts(ctx, provider, 1, counts)
	if err != nil {
		return types.ProviderCollateralSummary{}, err
	}
	if reason != "" {
		summary.EligibleForNewAssignment = false
		summary.IneligibilityReason = reason
	} else {
		summary.EligibleForNewAssignment = true
	}
	if summary.IneligibilityReason == "" && affordableReason != "" {
		summary.IneligibilityReason = affordableReason
	}

	return summary, nil
}

func (k Keeper) scheduleUnderbondedRepairs(ctx sdk.Context, epochID uint64) error {
	params := k.GetParams(ctx)
	min, err := normalizeMinProviderBond(params)
	if err != nil {
		return err
	}
	perSlot, err := normalizeAssignmentCollateralPerSlot(params)
	if err != nil {
		return err
	}
	if !min.Amount.IsPositive() && !perSlot.Amount.IsPositive() {
		return nil
	}

	height := uint64(ctx.BlockHeight())
	scheduledByProvider := make(map[string]uint64)
	assignmentCounts, err := k.providerMode2AssignmentCountSnapshot(ctx)
	if err != nil {
		return err
	}

	return k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (bool, error) {
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 {
			return false, nil
		}

		dealChanged := false
		for i := 0; i < len(deal.Mode2Slots); i++ {
			entry := deal.Mode2Slots[i]
			if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
				continue
			}
			if strings.TrimSpace(entry.PendingProvider) != "" {
				continue
			}

			providerAddr := strings.TrimSpace(entry.Provider)
			if providerAddr == "" {
				continue
			}
			provider, err := k.Providers.Get(ctx, providerAddr)
			if err != nil {
				return true, err
			}
			active, _ := assignmentCounts.countsFor(providerAddr)
			if active == 0 {
				continue
			}
			affordable, reason, err := k.affordableActiveAssignments(ctx, provider)
			if err != nil {
				return true, err
			}
			if reason == "" && active <= affordable {
				continue
			}
			excess := active
			if reason == "" && affordable < active {
				excess = active - affordable
			}
			if scheduledByProvider[providerAddr] >= excess {
				continue
			}

			slot := uint32(i)
			coolingDown, attemptState, err := k.repairAttemptCooldownActive(ctx, dealID, slot, epochID)
			if err != nil {
				return true, err
			}
			if coolingDown {
				ctx.Logger().Info(
					"underbonded repair skipped during cooldown",
					"deal", dealID,
					"slot", slot,
					"provider", entry.Provider,
					"cooldown_until_epoch", attemptState.CooldownUntilEpoch,
				)
				continue
			}

			pending, err := k.selectMode2ReplacementProviderWithCounts(ctx, deal, slot, epochID, assignmentCounts)
			if err != nil {
				ctx.Logger().Error(
					"failed to select replacement provider (underbonded)",
					"deal", dealID,
					"slot", slot,
					"provider", entry.Provider,
					"error", err,
				)
				if errEvidence := k.recordRepairBackoff(ctx, dealID, entry.Provider, slot, epochID, err); errEvidence != nil {
					ctx.Logger().Error("failed to record repair backoff evidence", "error", errEvidence)
				}
				continue
			}

			entry.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
			entry.PendingProvider = strings.TrimSpace(pending)
			assignmentCounts.incrementPending(entry.PendingProvider)
			entry.StatusSinceHeight = ctx.BlockHeight()
			entry.RepairTargetGen = deal.CurrentGen
			if err := k.clearMode2RepairReadiness(ctx, dealID, slot); err != nil {
				return true, err
			}
			deal.Mode2Slots[i] = entry
			dealChanged = true
			scheduledByProvider[providerAddr]++

			extra := make([]byte, 0, 4+len(providerAddr))
			extra = binary.BigEndian.AppendUint32(extra, slot)
			extra = append(extra, []byte(providerAddr)...)
			eid := deriveEvidenceID("underbonded_repair_started", dealID, epochID, extra)
			if err := k.recordEvidenceSummary(ctx, dealID, providerAddr, "underbonded_repair_started", eid[:], "chain", false); err != nil {
				ctx.Logger().Error("failed to record evidence summary", "error", err)
			}
			summary := fmt.Sprintf("provider collateral headroom insufficient; scheduled replacement %s", entry.PendingProvider)
			if reason != "" {
				summary = reason + "; " + summary
			}
			caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
				DealID:             dealID,
				Slot:               slot,
				Provider:           providerAddr,
				Reporter:           "chain",
				Reason:             "underbonded_repair_started",
				Class:              types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
				Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
				Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED,
				EvidenceID:         eid[:],
				EpochID:            epochID,
				Summary:            summary,
				ConsequenceCeiling: "assignment collateral repair; no additional slash by default",
			})
			if err != nil {
				ctx.Logger().Error("failed to record structured underbonded repair evidence", "error", err)
			} else if err := k.setSlotHealthState(ctx, slotHealthUpdate{
				DealID:          dealID,
				Slot:            slot,
				Provider:        providerAddr,
				Status:          types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING,
				Reason:          "underbonded_repair_started",
				Class:           types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
				Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
				EpochID:         epochID,
				EvidenceCaseID:  caseID,
				PendingProvider: entry.PendingProvider,
				RepairTargetGen: entry.RepairTargetGen,
			}); err != nil {
				ctx.Logger().Error("failed to update underbonded repair slot health", "error", err)
			} else if err := k.recordRepairAttemptStarted(ctx, dealID, slot, providerAddr, entry.PendingProvider, epochID, "underbonded_repair_started", entry.RepairTargetGen, caseID); err != nil {
				ctx.Logger().Error("failed to record underbonded repair attempt state", "error", err)
			}

			ctx.EventManager().EmitEvent(
				sdk.NewEvent(
					"underbonded_repair_started",
					sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", dealID)),
					sdk.NewAttribute("slot", fmt.Sprintf("%d", slot)),
					sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
					sdk.NewAttribute("pending_provider", entry.PendingProvider),
					sdk.NewAttribute("epoch_id", fmt.Sprintf("%d", epochID)),
				),
			)
		}

		if dealChanged {
			if err := k.setDealWithAssignmentCollateralLocks(ctx, dealID, deal); err != nil {
				return true, err
			}
		}
		return false, nil
	})
}
