package keeper

import (
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

type assignmentCollateralLockKey = collections.Pair[string, collections.Pair[uint64, uint32]]
type assignmentCollateralLockByDealKey = collections.Pair[uint64, collections.Pair[uint32, string]]

func makeAssignmentCollateralLockKey(provider string, dealID uint64, slot uint32) assignmentCollateralLockKey {
	return collections.Join(strings.TrimSpace(provider), collections.Join(dealID, slot))
}

func makeAssignmentCollateralLockByDealKey(provider string, dealID uint64, slot uint32) assignmentCollateralLockByDealKey {
	return collections.Join(dealID, collections.Join(slot, strings.TrimSpace(provider)))
}

func assignmentCollateralLockID(provider string, dealID uint64, slot uint32) string {
	return fmt.Sprintf("%s/%d/%d", strings.TrimSpace(provider), dealID, slot)
}

func (k Keeper) setDealWithAssignmentCollateralLocks(ctx sdk.Context, dealID uint64, deal types.Deal) error {
	if err := k.Deals.Set(ctx, dealID, deal); err != nil {
		return err
	}
	return k.syncAssignmentCollateralLocksForDeal(ctx, deal)
}

func (k Keeper) syncAssignmentCollateralLocksForDeal(ctx sdk.Context, deal types.Deal) error {
	existing := make(map[string]types.AssignmentCollateralLock)
	existingKeys := make([]assignmentCollateralLockKey, 0)
	if err := k.AssignmentCollateralLocksByDeal.Walk(ctx, collections.NewPrefixedPairRange[uint64, collections.Pair[uint32, string]](deal.Id), func(byDealKey assignmentCollateralLockByDealKey, _ bool) (bool, error) {
		slotProvider := byDealKey.K2()
		slot := slotProvider.K1()
		provider := slotProvider.K2()
		key := makeAssignmentCollateralLockKey(provider, deal.Id, slot)
		lock, err := k.AssignmentCollateralLocks.Get(ctx, key)
		if err != nil {
			if errors.Is(err, collections.ErrNotFound) {
				return false, k.AssignmentCollateralLocksByDeal.Remove(ctx, byDealKey)
			}
			return false, err
		}
		existing[assignmentCollateralLockID(lock.Provider, lock.DealId, lock.Slot)] = lock
		existingKeys = append(existingKeys, key)
		return false, nil
	}); err != nil {
		return err
	}

	desired, err := k.desiredAssignmentCollateralLocksForDeal(ctx, deal, existing)
	if err != nil {
		return err
	}
	keep := make(map[string]struct{}, len(desired))
	for _, lock := range desired {
		keep[assignmentCollateralLockID(lock.Provider, lock.DealId, lock.Slot)] = struct{}{}
	}

	for _, key := range existingKeys {
		provider := key.K1()
		dealSlot := key.K2()
		if _, ok := keep[assignmentCollateralLockID(provider, dealSlot.K1(), dealSlot.K2())]; ok {
			continue
		}
		if err := k.AssignmentCollateralLocks.Remove(ctx, key); err != nil {
			return err
		}
		if err := k.AssignmentCollateralLocksByDeal.Remove(ctx, makeAssignmentCollateralLockByDealKey(provider, dealSlot.K1(), dealSlot.K2())); err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
	}
	for _, lock := range desired {
		if err := k.AssignmentCollateralLocks.Set(ctx, makeAssignmentCollateralLockKey(lock.Provider, lock.DealId, lock.Slot), lock); err != nil {
			return err
		}
		if err := k.AssignmentCollateralLocksByDeal.Set(ctx, makeAssignmentCollateralLockByDealKey(lock.Provider, lock.DealId, lock.Slot), true); err != nil {
			return err
		}
	}
	return nil
}

func (k Keeper) desiredAssignmentCollateralLocksForDeal(ctx sdk.Context, deal types.Deal, existing map[string]types.AssignmentCollateralLock) ([]types.AssignmentCollateralLock, error) {
	if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 {
		return nil, nil
	}
	height := uint64(ctx.BlockHeight())
	if height < deal.StartBlock || height >= deal.EndBlock {
		return nil, nil
	}

	params := k.GetParams(ctx)
	perSlot, err := normalizeAssignmentCollateralPerSlot(params)
	if err != nil {
		return nil, err
	}
	if !perSlot.IsPositive() {
		return nil, nil
	}

	locks := make([]types.AssignmentCollateralLock, 0, len(deal.Mode2Slots))
	for _, slot := range deal.Mode2Slots {
		if slot == nil {
			continue
		}
		provider := strings.TrimSpace(slot.Provider)
		role := types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE
		reason := "slot_active"
		generation := deal.CurrentGen

		if slot.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
			provider = strings.TrimSpace(slot.PendingProvider)
			role = types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_PENDING_REPAIR
			reason = "slot_repair_pending"
			generation = slot.RepairTargetGen
		}
		if provider == "" {
			continue
		}

		lockedAtHeight := slot.StatusSinceHeight
		if lockedAtHeight <= 0 {
			lockedAtHeight = ctx.BlockHeight()
		}
		id := assignmentCollateralLockID(provider, deal.Id, slot.Slot)
		if old, ok := existing[id]; ok && old.Role == role {
			lockedAtHeight = old.LockedAtHeight
		}

		locks = append(locks, types.AssignmentCollateralLock{
			Provider:       provider,
			DealId:         deal.Id,
			Slot:           slot.Slot,
			Role:           role,
			Amount:         perSlot,
			Generation:     generation,
			LockedAtHeight: lockedAtHeight,
			UpdatedHeight:  ctx.BlockHeight(),
			Reason:         reason,
		})
	}
	return locks, nil
}
