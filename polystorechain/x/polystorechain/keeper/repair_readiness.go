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

func mode2RepairReadinessValue(repairTargetGen uint64) (uint64, error) {
	if repairTargetGen == ^uint64(0) {
		return 0, fmt.Errorf("repair target generation overflow")
	}
	return repairTargetGen + 1, nil
}

func (k Keeper) clearMode2RepairReadiness(ctx sdk.Context, dealID uint64, slot uint32) error {
	key := collections.Join(dealID, slot)
	err := k.Mode2RepairReadiness.Remove(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	err = k.Mode2RepairReadinessProofs.Remove(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	return nil
}

func (k Keeper) mode2RepairReady(ctx sdk.Context, dealID uint64, slot uint32, repairTargetGen uint64) (bool, error) {
	expected, err := mode2RepairReadinessValue(repairTargetGen)
	if err != nil {
		return false, err
	}

	actual, err := k.Mode2RepairReadiness.Get(ctx, collections.Join(dealID, slot))
	if errors.Is(err, collections.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return actual == expected, nil
}

func repairReadinessRequiredProofs(params types.Params, deal types.Deal, stripe stripeParams) uint64 {
	in, ok := slabInputs(deal)
	if !ok {
		return 1
	}
	quota := requiredBlobsMode2(params, deal, stripe, in)
	if quota == 0 {
		return 1
	}
	if params.RepairReadinessQuotaBps == 0 {
		return 1
	}
	required := mulDivCeil(quota, params.RepairReadinessQuotaBps, 10000)
	if required == 0 {
		return 1
	}
	return required
}

func (k Keeper) markMode2RepairReady(ctx sdk.Context, params types.Params, deal types.Deal, slot uint32, pendingProvider string, epochID uint64) error {
	if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || int(slot) >= len(deal.Mode2Slots) {
		return nil
	}
	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return err
	}

	entry := deal.Mode2Slots[slot]
	if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_REPAIRING {
		return nil
	}
	pending := strings.TrimSpace(pendingProvider)
	if pending == "" || pending != strings.TrimSpace(entry.PendingProvider) {
		return nil
	}

	value, err := mode2RepairReadinessValue(entry.RepairTargetGen)
	if err != nil {
		return err
	}

	key := collections.Join(deal.Id, slot)
	current, err := k.Mode2RepairReadiness.Get(ctx, key)
	if err == nil && current == value {
		return nil
	}
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}

	currentProofs, err := k.Mode2RepairReadinessProofs.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	nextProofs := currentProofs + 1
	if nextProofs < currentProofs {
		return fmt.Errorf("repair readiness proof counter overflow")
	}
	if err := k.Mode2RepairReadinessProofs.Set(ctx, key, nextProofs); err != nil {
		return err
	}

	requiredProofs := repairReadinessRequiredProofs(params, deal, stripe)
	if nextProofs < requiredProofs {
		return nil
	}
	if err := k.Mode2RepairReadiness.Set(ctx, key, value); err != nil {
		return err
	}

	extra := make([]byte, 0, 4+8)
	extra = binary.BigEndian.AppendUint32(extra, slot)
	extra = binary.BigEndian.AppendUint64(extra, entry.RepairTargetGen)
	eid := deriveEvidenceID("slot_repair_ready", deal.Id, epochID, extra)
	if err := k.recordEvidenceSummary(ctx, deal.Id, pending, "slot_repair_ready", eid[:], "chain", true); err != nil {
		return err
	}
	caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
		DealID:             deal.Id,
		Slot:               slot,
		Provider:           pending,
		Reporter:           "chain",
		Reason:             "slot_repair_ready",
		Class:              types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO,
		Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
		EvidenceID:         eid[:],
		EpochID:            epochID,
		Summary:            fmt.Sprintf("pending provider proved %d/%d catch-up proofs for repair target generation %d", nextProofs, requiredProofs, entry.RepairTargetGen),
		ConsequenceCeiling: "promotion guardrail only",
	})
	if err != nil {
		return err
	}
	return k.setSlotHealthState(ctx, slotHealthUpdate{
		DealID:          deal.Id,
		Slot:            slot,
		Provider:        strings.TrimSpace(entry.Provider),
		Status:          types.SlotHealthStatus_SLOT_HEALTH_STATUS_CATCHUP_READY,
		Reason:          "slot_repair_ready",
		Class:           types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
		Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO,
		EpochID:         epochID,
		EvidenceCaseID:  caseID,
		PendingProvider: pending,
		RepairTargetGen: entry.RepairTargetGen,
	})
}
