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
							caseID, err := k.recordEvidenceCase(sdkCtx, evidenceCaseInput{
								DealID:             dealID,
								Slot:               slot,
								Provider:           strings.TrimSpace(oldProvider),
								Reporter:           "chain",
								Reason:             "slot_repair_completed",
								EvidenceID:         eid[:],
								EpochID:            epochID,
								Summary:            fmt.Sprintf("slot %d promoted pending provider %s", slot, newProvider),
								ConsequenceCeiling: "repair completed; no penalty by itself",
							})
							if err != nil {
								sdkCtx.Logger().Error("failed to record structured evidence", "error", err)
							} else if err := k.setSlotHealthState(sdkCtx, slotHealthUpdate{
								DealID:         dealID,
								Slot:           slot,
								Provider:       newProvider,
								Status:         types.SlotHealthStatus_SLOT_HEALTH_STATUS_ACTIVE_PROMOTED,
								Reason:         "slot_repair_completed",
								Class:          types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
								Severity:       types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
								EpochID:        epochID,
								EvidenceCaseID: caseID,
								ResetCounters:  true,
							}); err != nil {
								sdkCtx.Logger().Error("failed to update slot health", "error", err)
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
					if err := k.recordMode2SoftFaultEvidence(sdkCtx, deal, dealID, slot, epochID, "deputy_served_zero_direct", nextMissed); err != nil {
						return false, err
					}
					healthKind := "provider_degraded"
					if params.EvictAfterMissedEpochs > 0 && nextMissed >= params.EvictAfterMissedEpochs {
						healthKind = "provider_delinquent"
					}
					if err := k.recordMode2SoftFaultEvidence(sdkCtx, deal, dealID, slot, epochID, healthKind, nextMissed); err != nil {
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
						coolingDown, attemptState, err := k.repairAttemptCooldownActive(sdkCtx, dealID, slot, epochID)
						if err != nil {
							return false, err
						}
						if coolingDown {
							sdkCtx.Logger().Info(
								"slot repair skipped during cooldown",
								"deal", dealID,
								"slot", slotIdx,
								"provider", entry.Provider,
								"cooldown_until_epoch", attemptState.CooldownUntilEpoch,
							)
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
							if errEvidence := k.recordRepairBackoff(sdkCtx, dealID, entry.Provider, slot, epochID, err); errEvidence != nil {
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
						caseID, err := k.recordMode2RepairStartedEvidence(sdkCtx, dealID, entry.Provider, slot, epochID, "deputy_miss_repair_started", eid[:], entry.PendingProvider, entry.RepairTargetGen)
						if err != nil {
							sdkCtx.Logger().Error("failed to record structured repair evidence", "error", err)
						} else if err := k.recordRepairAttemptStarted(sdkCtx, dealID, slot, entry.Provider, entry.PendingProvider, epochID, "deputy_miss_repair_started", entry.RepairTargetGen, caseID); err != nil {
							sdkCtx.Logger().Error("failed to record repair attempt state", "error", err)
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
					if err := k.recordMode2SoftFaultEvidence(sdkCtx, deal, dealID, slot, epochID, "quota_miss_recorded", nextMissed); err != nil {
						return false, err
					}
					healthKind := "provider_degraded"
					if params.EvictAfterMissedEpochs > 0 && nextMissed >= params.EvictAfterMissedEpochs {
						healthKind = "provider_delinquent"
					}
					if err := k.recordMode2SoftFaultEvidence(sdkCtx, deal, dealID, slot, epochID, healthKind, nextMissed); err != nil {
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
						coolingDown, attemptState, err := k.repairAttemptCooldownActive(sdkCtx, dealID, slot, epochID)
						if err != nil {
							return false, err
						}
						if coolingDown {
							sdkCtx.Logger().Info(
								"slot repair skipped during cooldown",
								"deal", dealID,
								"slot", slotIdx,
								"provider", entry.Provider,
								"cooldown_until_epoch", attemptState.CooldownUntilEpoch,
							)
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
							if errEvidence := k.recordRepairBackoff(sdkCtx, dealID, entry.Provider, slot, epochID, err); errEvidence != nil {
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
						caseID, err := k.recordMode2RepairStartedEvidence(sdkCtx, dealID, entry.Provider, slot, epochID, "quota_miss_repair_started", eid[:], entry.PendingProvider, entry.RepairTargetGen)
						if err != nil {
							sdkCtx.Logger().Error("failed to record structured repair evidence", "error", err)
						} else if err := k.recordRepairAttemptStarted(sdkCtx, dealID, slot, entry.Provider, entry.PendingProvider, epochID, "quota_miss_repair_started", entry.RepairTargetGen, caseID); err != nil {
							sdkCtx.Logger().Error("failed to record repair attempt state", "error", err)
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
	// Finalize health transitions after reward accounting so a provider jailed
	// through this epoch cannot earn by expiring at the boundary height.
	if err := k.applyProviderHealthEpochDecay(sdkCtx, epochID); err != nil {
		return err
	}
	if err := k.scheduleUnderbondedRepairs(sdkCtx, epochID); err != nil {
		return err
	}
	// Run controlled churn after rewards are distributed so a draining provider
	// is still paid for the epoch they served.
	if err := k.scheduleDrainingRepairs(sdkCtx, epochID); err != nil {
		return err
	}
	return k.scheduleRoutineRotations(sdkCtx, epochID)
}

func (k Keeper) recordRepairBackoff(ctx sdk.Context, dealID uint64, provider string, slot uint32, epochID uint64, reason error) error {
	reasonText := "unknown repair backoff reason"
	if reason != nil {
		reasonText = reason.Error()
	}
	extra := make([]byte, 0, 4+len(reasonText))
	extra = binary.BigEndian.AppendUint32(extra, slot)
	extra = append(extra, []byte(reasonText)...)
	eid := deriveEvidenceID("repair_backoff_entered", dealID, epochID, extra)
	if err := k.recordEvidenceSummary(ctx, dealID, provider, "repair_backoff_entered", eid[:], "chain:"+reasonText, false); err != nil {
		return err
	}
	caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
		DealID:             dealID,
		Slot:               slot,
		Provider:           provider,
		Reporter:           "chain:" + reasonText,
		Reason:             "repair_backoff_entered",
		Class:              types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
		Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
		EvidenceID:         eid[:],
		EpochID:            epochID,
		Summary:            reasonText,
		ConsequenceCeiling: "operator alert; no slash",
	})
	if err != nil {
		return err
	}
	if err := k.setSlotHealthState(ctx, slotHealthUpdate{
		DealID:         dealID,
		Slot:           slot,
		Provider:       provider,
		Status:         types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIR_BACKOFF,
		Reason:         "repair_backoff_entered",
		Class:          types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
		Severity:       types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
		EpochID:        epochID,
		EvidenceCaseID: caseID,
	}); err != nil {
		return err
	}
	return k.recordRepairBackoffAttempt(ctx, dealID, slot, provider, epochID, reasonText, caseID, errors.Is(reason, errNoReplacementProviderCandidates))
}

func (k Keeper) recordMode2RepairStartedEvidence(
	ctx sdk.Context,
	dealID uint64,
	provider string,
	slot uint32,
	epochID uint64,
	kind string,
	evidenceID []byte,
	pendingProvider string,
	repairTargetGen uint64,
) (uint64, error) {
	caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
		DealID:             dealID,
		Slot:               slot,
		Provider:           provider,
		Reporter:           "chain",
		Reason:             kind,
		Class:              types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT,
		Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED,
		CountsAsFailure:    shouldCountEvidenceAsFailedChallenge(kind, false),
		EpochID:            epochID,
		EvidenceID:         evidenceID,
		Summary:            fmt.Sprintf("slot %d entered repair with pending provider %s", slot, strings.TrimSpace(pendingProvider)),
		ConsequenceCeiling: "repair and reward exclusion; no soft-fault slash by default",
	})
	if err != nil {
		return 0, err
	}
	if err := k.setSlotHealthState(ctx, slotHealthUpdate{
		DealID:          dealID,
		Slot:            slot,
		Provider:        provider,
		Status:          types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING,
		Reason:          kind,
		Class:           types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
		Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT,
		EpochID:         epochID,
		EvidenceCaseID:  caseID,
		PendingProvider: pendingProvider,
		RepairTargetGen: repairTargetGen,
	}); err != nil {
		return 0, err
	}
	return caseID, nil
}

func (k Keeper) recordMode2SoftFaultEvidence(
	ctx sdk.Context,
	deal types.Deal,
	dealID uint64,
	slot uint32,
	epochID uint64,
	kind string,
	missedEpochs uint64,
) error {
	if int(slot) >= len(deal.Mode2Slots) {
		return nil
	}
	entry := deal.Mode2Slots[slot]
	if entry == nil {
		return nil
	}
	provider := strings.TrimSpace(entry.Provider)
	if provider == "" {
		return nil
	}

	extra := make([]byte, 0, 4+8)
	extra = binary.BigEndian.AppendUint32(extra, slot)
	extra = binary.BigEndian.AppendUint64(extra, missedEpochs)
	eid := deriveEvidenceID(kind, dealID, epochID, extra)
	reporter := fmt.Sprintf("chain:slot=%d:missed_epochs=%d", slot, missedEpochs)
	if err := k.recordEvidenceSummary(ctx, dealID, provider, kind, eid[:], reporter, false); err != nil {
		return err
	}

	caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
		DealID:             dealID,
		Slot:               slot,
		Provider:           provider,
		Reporter:           reporter,
		Reason:             kind,
		Class:              types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
		Severity:           softFaultSeverity(kind),
		Status:             softFaultEvidenceStatus(kind),
		CountsAsFailure:    shouldCountEvidenceAsFailedChallenge(kind, false),
		EpochID:            epochID,
		Count:              missedEpochs,
		EvidenceID:         eid[:],
		Summary:            fmt.Sprintf("slot %d missed soft-fault threshold counter=%d", slot, missedEpochs),
		ConsequenceCeiling: softFaultConsequence(kind),
	})
	if err != nil {
		return err
	}

	health := types.SlotHealthStatus_SLOT_HEALTH_STATUS_SUSPECT
	if softFaultEvidenceStatus(kind) == types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED {
		health = types.SlotHealthStatus_SLOT_HEALTH_STATUS_DELINQUENT
	}
	update := slotHealthUpdate{
		DealID:         dealID,
		Slot:           slot,
		Provider:       provider,
		Status:         health,
		Reason:         kind,
		Class:          types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
		Severity:       softFaultSeverity(kind),
		EpochID:        epochID,
		EvidenceCaseID: caseID,
	}
	if strings.Contains(kind, "deputy") {
		update.DeputyMissedEpochs = missedEpochs
	} else {
		update.MissedEpochs = missedEpochs
	}
	return k.setSlotHealthState(ctx, update)
}

func softFaultSeverity(kind string) types.EvidenceSeverity {
	if strings.TrimSpace(kind) == "provider_delinquent" {
		return types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT
	}
	return types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED
}

func softFaultEvidenceStatus(kind string) types.EvidenceCaseStatus {
	if strings.TrimSpace(kind) == "provider_delinquent" {
		return types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED
	}
	return types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED
}

func softFaultConsequence(kind string) string {
	if strings.TrimSpace(kind) == "provider_delinquent" {
		return "repair and reward exclusion; no soft-fault slash by default"
	}
	return "health decay and operator alert; no slash"
}
