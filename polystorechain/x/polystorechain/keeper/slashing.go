package keeper

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/x/polystorechain/types"
)

// CheckMissedProofs iterates over all deals and slashes providers who have missed their proof window.
func (k Keeper) CheckMissedProofs(ctx context.Context) error {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	params := k.GetParams(sdkCtx)
	if params.EpochLenBlocks == 0 {
		return nil
	}
	if !isEpochEnd(sdkCtx.BlockHeight(), params.EpochLenBlocks) {
		return nil
	}
	epochID := epochIDAtHeight(sdkCtx.BlockHeight(), params.EpochLenBlocks)
	if epochID == 0 {
		return nil
	}
	height := uint64(sdkCtx.BlockHeight())

	err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		// end_block is exclusive: once height >= end_block, the deal is expired.
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		in, ok := slabInputs(deal)
		if !ok {
			return false, nil
		}

		stripe, serr := stripeParamsForDeal(deal)
		if serr != nil {
			sdkCtx.Logger().Error("quota enforcement skipped: invalid stripe params", "deal", dealID, "error", serr)
			return false, nil
		}

		switch stripe.mode {
		case 1:
			for _, provider := range deal.Providers {
				quota := requiredBlobsMode1(params, deal, in)
				if quota == 0 {
					continue
				}
				keyEpoch := mode1EpochKey(dealID, provider, epochID)

				creditsRaw, err := k.Mode1EpochCredits.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}
				synth, err := k.Mode1EpochSynthetic.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}

				creditCap := creditCapBlobs(params, quota)
				credits := creditsRaw
				if creditCap < credits {
					credits = creditCap
				}

				total := credits + synth
				missedKey := collections.Join(dealID, provider)
				if total < quota {
					prev, err := k.Mode1MissedEpochs.Get(ctx, missedKey)
					if err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
					if err := k.Mode1MissedEpochs.Set(ctx, missedKey, prev+1); err != nil {
						return false, err
					}
					sdkCtx.Logger().Info(
						"quota missed (mode1)",
						"epoch", epochID,
						"deal", dealID,
						"provider", provider,
						"quota", quota,
						"credits", credits,
						"synthetic", synth,
						"missed_epochs", prev+1,
					)
				} else {
					if err := k.Mode1MissedEpochs.Remove(ctx, missedKey); err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
				}
			}
		case 2:
			if stripe.slotCount == 0 {
				return false, nil
			}
			quota := requiredBlobsMode2(params, deal, stripe, in)
			if quota == 0 {
				return false, nil
			}
			dealChanged := false
			for slotIdx := uint64(0); slotIdx < stripe.slotCount; slotIdx++ {
				slot := uint32(slotIdx)
				keyEpoch := mode2EpochKey(dealID, slot, epochID)
				creditsRaw, err := k.Mode2EpochCredits.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}
				synth, err := k.Mode2EpochSynthetic.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}
				slotServed, err := k.Mode2EpochSlotServed.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}
				deputyServed, err := k.Mode2EpochDeputyServed.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}

				creditCap := creditCapBlobs(params, quota)
				credits := creditsRaw
				if creditCap < credits {
					credits = creditCap
				}

				total := credits + synth
				missedKey := collections.Join(dealID, slot)

				// Repair coordination: when a slot is REPAIRING, allow the pending provider to
				// satisfy the same quota via synthetic proofs. Once the quota is met for an
				// epoch, complete the make-before-break swap automatically.
				if deal.RedundancyMode == 2 && len(deal.Mode2Slots) > 0 && int(slot) < len(deal.Mode2Slots) {
					entry := deal.Mode2Slots[slot]
					if entry != nil && entry.Status == types.SlotStatus_SLOT_STATUS_REPAIRING && strings.TrimSpace(entry.PendingProvider) != "" {
						if total >= quota {
							ready, err := k.mode2RepairReady(sdkCtx, dealID, slot, entry.RepairTargetGen)
							if err != nil {
								return false, err
							}
							if !ready {
								continue
							}

							oldProvider := entry.Provider
							newProvider := strings.TrimSpace(entry.PendingProvider)

							entry.Provider = newProvider
							entry.PendingProvider = ""
							entry.Status = types.SlotStatus_SLOT_STATUS_ACTIVE
							entry.StatusSinceHeight = sdkCtx.BlockHeight()
							entry.RepairTargetGen = 0
							deal.Mode2Slots[slot] = entry

							// Keep legacy providers[] aligned when possible.
							if int(slot) >= 0 && int(slot) < len(deal.Providers) {
								deal.Providers[slot] = newProvider
							}

							deal.CurrentGen++
							dealChanged = true
							if err := k.clearMode2RepairReadiness(sdkCtx, dealID, slot); err != nil {
								return false, err
							}
							_ = k.Mode2MissedEpochs.Remove(ctx, missedKey)
							_ = k.Mode2DeputyMissedEpochs.Remove(ctx, missedKey)

							extra := make([]byte, 0, 4)
							extra = binary.BigEndian.AppendUint32(extra, slot)
							eid := deriveEvidenceID("slot_repair_completed", dealID, epochID, extra)
							if err := k.recordEvidenceSummary(sdkCtx, dealID, strings.TrimSpace(oldProvider), "slot_repair_completed", eid[:], "chain", true); err != nil {
								sdkCtx.Logger().Error("failed to record evidence summary", "error", err)
							}

							sdkCtx.Logger().Info(
								"slot repair completed",
								"deal", dealID,
								"slot", slotIdx,
								"old_provider", oldProvider,
								"new_provider", newProvider,
								"epoch", epochID,
								"quota", quota,
								"credits", credits,
								"synthetic", synth,
								"current_gen", deal.CurrentGen,
							)
						}
						// Do not count missed epochs while repairing.
						continue
					}
					if entry != nil && entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
						continue
					}
				}

				// Deputy audit debt: if another provider served blobs for this slot but the slot's
				// active provider served none, treat it as a "ghosted" slot and start repairs even
				// if system liveness + synthetic fill satisfies quota.
				if deputyServed > 0 && slotServed == 0 {
					prev, err := k.Mode2DeputyMissedEpochs.Get(ctx, missedKey)
					if err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
					nextMissed := prev + 1
					if err := k.Mode2DeputyMissedEpochs.Set(ctx, missedKey, nextMissed); err != nil {
						return false, err
					}

					sdkCtx.Logger().Info(
						"deputy-served slot had zero retrieval service",
						"epoch", epochID,
						"deal", dealID,
						"slot", slotIdx,
						"deputy_served", deputyServed,
						"slot_served", slotServed,
						"missed_epochs", nextMissed,
					)

					if params.EvictAfterMissedEpochs > 0 && nextMissed >= params.EvictAfterMissedEpochs {
						if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 || int(slot) >= len(deal.Mode2Slots) {
							continue
						}
						entry := deal.Mode2Slots[slot]
						if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
							continue
						}
						if strings.TrimSpace(entry.PendingProvider) != "" {
							continue
						}

						pending, err := k.selectMode2ReplacementProvider(sdkCtx, deal, slot, epochID)
						if err != nil {
							sdkCtx.Logger().Error(
								"failed to select replacement provider",
								"deal", dealID,
								"slot", slotIdx,
								"error", err,
							)
							if errEvidence := k.recordRepairBackoff(sdkCtx, dealID, entry.Provider, slot, epochID, err.Error()); errEvidence != nil {
								sdkCtx.Logger().Error("failed to record repair backoff evidence", "error", errEvidence)
							}
							continue
						}

						entry.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
						entry.PendingProvider = strings.TrimSpace(pending)
						entry.StatusSinceHeight = sdkCtx.BlockHeight()
						entry.RepairTargetGen = deal.CurrentGen
						if err := k.clearMode2RepairReadiness(sdkCtx, dealID, slot); err != nil {
							return false, err
						}
						deal.Mode2Slots[slot] = entry
						dealChanged = true
						_ = k.Mode2DeputyMissedEpochs.Remove(ctx, missedKey)
						_ = k.Mode2MissedEpochs.Remove(ctx, missedKey)

						extra := make([]byte, 0, 4)
						extra = binary.BigEndian.AppendUint32(extra, slot)
						eid := deriveEvidenceID("deputy_miss_repair_started", dealID, epochID, extra)
						if err := k.recordEvidenceSummary(sdkCtx, dealID, entry.Provider, "deputy_miss_repair_started", eid[:], "chain", false); err != nil {
							sdkCtx.Logger().Error("failed to record evidence summary", "error", err)
						}

						sdkCtx.Logger().Info(
							"slot repair started (deputy miss)",
							"deal", dealID,
							"slot", slotIdx,
							"provider", entry.Provider,
							"pending_provider", entry.PendingProvider,
							"repair_target_gen", entry.RepairTargetGen,
						)
						continue
					}
				} else {
					if err := k.Mode2DeputyMissedEpochs.Remove(ctx, missedKey); err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
				}

				if total < quota {
					prev, err := k.Mode2MissedEpochs.Get(ctx, missedKey)
					if err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
					nextMissed := prev + 1
					if err := k.Mode2MissedEpochs.Set(ctx, missedKey, nextMissed); err != nil {
						return false, err
					}
					sdkCtx.Logger().Info(
						"quota missed (mode2)",
						"epoch", epochID,
						"deal", dealID,
						"slot", slotIdx,
						"quota", quota,
						"credits", credits,
						"synthetic", synth,
						"missed_epochs", nextMissed,
					)

					if params.EvictAfterMissedEpochs > 0 && nextMissed >= params.EvictAfterMissedEpochs {
						if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 || int(slot) >= len(deal.Mode2Slots) {
							continue
						}
						entry := deal.Mode2Slots[slot]
						if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
							continue
						}
						if strings.TrimSpace(entry.PendingProvider) != "" {
							continue
						}

						pending, err := k.selectMode2ReplacementProvider(sdkCtx, deal, slot, epochID)
						if err != nil {
							sdkCtx.Logger().Error(
								"failed to select replacement provider",
								"deal", dealID,
								"slot", slotIdx,
								"error", err,
							)
							if errEvidence := k.recordRepairBackoff(sdkCtx, dealID, entry.Provider, slot, epochID, err.Error()); errEvidence != nil {
								sdkCtx.Logger().Error("failed to record repair backoff evidence", "error", errEvidence)
							}
							continue
						}

						entry.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
						entry.PendingProvider = strings.TrimSpace(pending)
						entry.StatusSinceHeight = sdkCtx.BlockHeight()
						entry.RepairTargetGen = deal.CurrentGen
						if err := k.clearMode2RepairReadiness(sdkCtx, dealID, slot); err != nil {
							return false, err
						}
						deal.Mode2Slots[slot] = entry
						dealChanged = true
						_ = k.Mode2MissedEpochs.Remove(ctx, missedKey)

						extra := make([]byte, 0, 4)
						extra = binary.BigEndian.AppendUint32(extra, slot)
						eid := deriveEvidenceID("quota_miss_repair_started", dealID, epochID, extra)
						if err := k.recordEvidenceSummary(sdkCtx, dealID, entry.Provider, "quota_miss_repair_started", eid[:], "chain", false); err != nil {
							sdkCtx.Logger().Error("failed to record evidence summary", "error", err)
						}

						sdkCtx.Logger().Info(
							"slot repair started",
							"deal", dealID,
							"slot", slotIdx,
							"provider", entry.Provider,
							"pending_provider", entry.PendingProvider,
							"repair_target_gen", entry.RepairTargetGen,
						)
					}
				} else {
					if err := k.Mode2MissedEpochs.Remove(ctx, missedKey); err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
				}
			}
			if dealChanged {
				if err := k.Deals.Set(ctx, dealID, deal); err != nil {
					return false, err
				}
			}
		default:
			return false, fmt.Errorf("unexpected stripe mode %d", stripe.mode)
		}

		return false, nil
	})

	if err != nil {
		return err
	}
	if err := k.distributeBaseRewardPool(sdkCtx, epochID); err != nil {
		return err
	}
	// Run controlled churn after rewards are distributed so a draining provider
	// is still paid for the epoch they served.
	if err := k.scheduleDrainingRepairs(sdkCtx, epochID); err != nil {
		return err
	}
	return k.scheduleRoutineRotations(sdkCtx, epochID)
}

func (k Keeper) recordRepairBackoff(ctx sdk.Context, dealID uint64, provider string, slot uint32, epochID uint64, reason string) error {
	extra := make([]byte, 0, 4+len(reason))
	extra = binary.BigEndian.AppendUint32(extra, slot)
	extra = append(extra, []byte(reason)...)
	eid := deriveEvidenceID("repair_backoff_entered", dealID, epochID, extra)
	return k.recordEvidenceSummary(ctx, dealID, provider, "repair_backoff_entered", eid[:], "chain:"+reason, false)
}
