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

func (k Keeper) markMode2RepairReady(ctx sdk.Context, deal types.Deal, slot uint32, pendingProvider string, epochID uint64) error {
	if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || int(slot) >= len(deal.Mode2Slots) {
		return nil
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
	if err := k.Mode2RepairReadiness.Set(ctx, key, value); err != nil {
		return err
	}

	extra := make([]byte, 0, 4+8)
	extra = binary.BigEndian.AppendUint32(extra, slot)
	extra = binary.BigEndian.AppendUint64(extra, entry.RepairTargetGen)
	eid := deriveEvidenceID("slot_repair_ready", deal.Id, epochID, extra)
	return k.recordEvidenceSummary(ctx, deal.Id, pending, "slot_repair_ready", eid[:], "chain", true)
}
