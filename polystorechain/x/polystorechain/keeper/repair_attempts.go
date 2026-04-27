package keeper

import (
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

func repairAttemptKey(dealID uint64, slot uint32) collections.Pair[uint64, uint32] {
	return collections.Join(dealID, slot)
}

func (k Keeper) repairAttemptCooldownActive(ctx sdk.Context, dealID uint64, slot uint32, epochID uint64) (bool, types.RepairAttemptState, error) {
	state, err := k.RepairAttemptStates.Get(ctx, repairAttemptKey(dealID, slot))
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return false, types.RepairAttemptState{}, nil
		}
		return false, types.RepairAttemptState{}, err
	}
	if state.CooldownUntilEpoch == 0 {
		return false, state, nil
	}
	return epochID <= state.CooldownUntilEpoch, state, nil
}

func (k Keeper) recordRepairAttemptStarted(
	ctx sdk.Context,
	dealID uint64,
	slot uint32,
	provider string,
	pendingProvider string,
	epochID uint64,
	reason string,
	repairTargetGen uint64,
	evidenceCaseID uint64,
) error {
	key := repairAttemptKey(dealID, slot)
	state, err := k.RepairAttemptStates.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if errors.Is(err, collections.ErrNotFound) {
		state.DealId = dealID
		state.Slot = slot
	}

	state.AttemptCount++
	state.CooldownUntilEpoch = 0
	state.LastAttemptEpoch = epochID
	state.LastAttemptHeight = ctx.BlockHeight()
	state.Provider = strings.TrimSpace(provider)
	state.PendingProvider = strings.TrimSpace(pendingProvider)
	state.LastReason = strings.TrimSpace(reason)
	state.RepairTargetGen = repairTargetGen
	state.LastEvidenceCaseId = evidenceCaseID

	return k.RepairAttemptStates.Set(ctx, key, state)
}

func (k Keeper) recordRepairBackoffAttempt(
	ctx sdk.Context,
	dealID uint64,
	slot uint32,
	provider string,
	epochID uint64,
	reason string,
	evidenceCaseID uint64,
) error {
	key := repairAttemptKey(dealID, slot)
	state, err := k.RepairAttemptStates.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if errors.Is(err, collections.ErrNotFound) {
		state.DealId = dealID
		state.Slot = slot
	}

	state.AttemptCount++
	state.BackoffCount++
	if strings.Contains(strings.ToLower(reason), "no replacement provider candidates") {
		state.CandidateExhaustionCount++
	}
	state.LastAttemptEpoch = epochID
	state.LastAttemptHeight = ctx.BlockHeight()
	state.Provider = strings.TrimSpace(provider)
	state.PendingProvider = ""
	state.LastReason = "repair_backoff_entered"
	state.RepairTargetGen = 0
	state.LastEvidenceCaseId = evidenceCaseID

	params := k.GetParams(ctx)
	if params.RepairBackoffEpochs == 0 {
		state.CooldownUntilEpoch = 0
	} else {
		state.CooldownUntilEpoch = epochID + params.RepairBackoffEpochs
		if state.CooldownUntilEpoch < epochID {
			state.CooldownUntilEpoch = ^uint64(0)
		}
	}

	return k.RepairAttemptStates.Set(ctx, key, state)
}
