package keeper

import (
	"encoding/binary"
	"fmt"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

// scheduleDrainingRepairs deterministically moves a bounded amount of slot-bytes into
// REPAIRING due to voluntary provider draining.
//
// Ordering:
// - providers are iterated in address order (collections walk order)
// - slots are iterated in (deal_id, slot) order
//
// This is intentionally conservative and Mode2-only: Mode1 assignments do not currently
// have an explicit "slot state" to safely coordinate make-before-break churn.
func (k Keeper) scheduleDrainingRepairs(ctx sdk.Context, epochID uint64) error {
	params := k.GetParams(ctx)
	if params.MaxDrainBytesPerEpoch == 0 {
		return nil
	}

	height := uint64(ctx.BlockHeight())

	// Track global active/repairing bytes for enforcing the repairing ratio cap.
	activeBytes := uint64(0)
	repairingBytes := uint64(0)
	if params.MaxRepairingBytesRatioBps > 0 {
		var err error
		activeBytes, repairingBytes, err = k.totalMode2ActiveAndRepairingSlotBytes(ctx, height)
		if err != nil {
			return err
		}
	}

	scheduledBytes := uint64(0)
	stopAll := false

	walkProvidersErr := k.Providers.Walk(ctx, nil, func(addr string, p types.Provider) (stop bool, err error) {
		if stopAll {
			return true, nil
		}
		if strings.TrimSpace(p.Status) != "Active" || !p.Draining {
			return false, nil
		}

		// For each draining provider, walk deals in ID order and mark their ACTIVE slots as REPAIRING.
		if err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
			if stopAll {
				return true, nil
			}
			// end_block is exclusive: once height >= end_block, the deal is expired.
			if height < deal.StartBlock || height >= deal.EndBlock {
				return false, nil
			}
			if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 {
				return false, nil
			}

			in, ok := slabInputs(deal)
			if !ok {
				return false, nil
			}
			stripe, err := stripeParamsForDeal(deal)
			if err != nil || stripe.mode != 2 || stripe.rows == 0 {
				return false, nil
			}

			slotBytes, overflow := mulUint64(in.userMdus, stripe.rows)
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}
			slotBytes, overflow = mulUint64(slotBytes, uint64(types.BlobSizeBytes))
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}
			if slotBytes == 0 {
				return false, nil
			}

			dealChanged := false
			for i := 0; i < len(deal.Mode2Slots); i++ {
				if stopAll {
					break
				}
				entry := deal.Mode2Slots[i]
				if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
					continue
				}
				if strings.TrimSpace(entry.PendingProvider) != "" {
					continue
				}
				if strings.TrimSpace(entry.Provider) != strings.TrimSpace(p.Address) {
					continue
				}
				coolingDown, attemptState, err := k.repairAttemptCooldownActive(ctx, dealID, uint32(i), epochID)
				if err != nil {
					return true, err
				}
				if coolingDown {
					ctx.Logger().Info(
						"drain repair skipped during cooldown",
						"deal", dealID,
						"slot", i,
						"provider", entry.Provider,
						"cooldown_until_epoch", attemptState.CooldownUntilEpoch,
					)
					continue
				}

				// Enforce drain budget.
				nextScheduled, overflow := addUint64(scheduledBytes, slotBytes)
				if overflow {
					return true, fmt.Errorf("scheduled bytes overflow")
				}
				if nextScheduled > params.MaxDrainBytesPerEpoch {
					stopAll = true
					break
				}

				// Enforce repairing ratio cap if configured.
				if params.MaxRepairingBytesRatioBps > 0 && activeBytes > 0 {
					nextRepairing, overflow := addUint64(repairingBytes, slotBytes)
					if overflow {
						return true, fmt.Errorf("repairing bytes overflow")
					}
					// cap = ceil(active_bytes * bps / 10_000)
					cap := mulDivCeil(activeBytes, params.MaxRepairingBytesRatioBps, 10000)
					if cap > 0 && nextRepairing > cap {
						stopAll = true
						break
					}
				}

				slot := uint32(i)
				pending, err := k.selectMode2ReplacementProvider(ctx, deal, slot, epochID)
				if err != nil {
					ctx.Logger().Error(
						"failed to select replacement provider (drain)",
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
				entry.StatusSinceHeight = ctx.BlockHeight()
				entry.RepairTargetGen = deal.CurrentGen
				if err := k.clearMode2RepairReadiness(ctx, dealID, slot); err != nil {
					return true, err
				}
				deal.Mode2Slots[i] = entry
				dealChanged = true

				scheduledBytes = nextScheduled
				if params.MaxRepairingBytesRatioBps > 0 {
					// Move bytes from ACTIVE -> REPAIRING to keep the cap tight while scheduling.
					if activeBytes >= slotBytes {
						activeBytes -= slotBytes
					} else {
						activeBytes = 0
					}
					repairingBytes += slotBytes
				}

				extra := make([]byte, 0, 4)
				extra = binary.BigEndian.AppendUint32(extra, slot)
				eid := deriveEvidenceID("drain_repair_started", dealID, epochID, extra)
				if err := k.recordEvidenceSummary(ctx, dealID, strings.TrimSpace(entry.Provider), "drain_repair_started", eid[:], "chain", false); err != nil {
					ctx.Logger().Error("failed to record evidence summary", "error", err)
				}
				caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
					DealID:             dealID,
					Slot:               slot,
					Provider:           strings.TrimSpace(entry.Provider),
					Reporter:           "chain",
					Reason:             "drain_repair_started",
					Class:              types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
					Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
					Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
					EvidenceID:         eid[:],
					EpochID:            epochID,
					Summary:            fmt.Sprintf("draining provider scheduled replacement %s", entry.PendingProvider),
					ConsequenceCeiling: "voluntary drain repair; no penalty by itself",
				})
				if err != nil {
					ctx.Logger().Error("failed to record structured drain repair evidence", "error", err)
				} else if err := k.setSlotHealthState(ctx, slotHealthUpdate{
					DealID:          dealID,
					Slot:            slot,
					Provider:        strings.TrimSpace(entry.Provider),
					Status:          types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING,
					Reason:          "drain_repair_started",
					Class:           types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
					Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
					EpochID:         epochID,
					EvidenceCaseID:  caseID,
					PendingProvider: entry.PendingProvider,
					RepairTargetGen: entry.RepairTargetGen,
				}); err != nil {
					ctx.Logger().Error("failed to update drain repair slot health", "error", err)
				} else if err := k.recordRepairAttemptStarted(ctx, dealID, slot, entry.Provider, entry.PendingProvider, epochID, "drain_repair_started", entry.RepairTargetGen, caseID); err != nil {
					ctx.Logger().Error("failed to record drain repair attempt state", "error", err)
				}

				ctx.Logger().Info(
					"slot repair started (drain)",
					"deal", dealID,
					"slot", slot,
					"provider", entry.Provider,
					"pending_provider", entry.PendingProvider,
					"scheduled_bytes", scheduledBytes,
				)
			}

			if dealChanged {
				if err := k.setDealWithAssignmentCollateralLocks(ctx, dealID, deal); err != nil {
					return true, err
				}
			}
			return false, nil
		}); err != nil {
			return true, err
		}

		return false, nil
	})
	if walkProvidersErr != nil {
		return walkProvidersErr
	}
	return nil
}

func (k Keeper) totalMode2ActiveAndRepairingSlotBytes(ctx sdk.Context, height uint64) (active uint64, repairing uint64, err error) {
	active = 0
	repairing = 0

	err = k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		// end_block is exclusive: once height >= end_block, the deal is expired.
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 {
			return false, nil
		}
		in, ok := slabInputs(deal)
		if !ok {
			return false, nil
		}
		stripe, err := stripeParamsForDeal(deal)
		if err != nil || stripe.mode != 2 || stripe.rows == 0 {
			return false, nil
		}

		slotBytes, overflow := mulUint64(in.userMdus, stripe.rows)
		if overflow {
			return false, fmt.Errorf("slot bytes overflow")
		}
		slotBytes, overflow = mulUint64(slotBytes, uint64(types.BlobSizeBytes))
		if overflow {
			return false, fmt.Errorf("slot bytes overflow")
		}
		if slotBytes == 0 {
			return false, nil
		}

		for _, slot := range deal.Mode2Slots {
			if slot == nil {
				continue
			}
			switch slot.Status {
			case types.SlotStatus_SLOT_STATUS_ACTIVE:
				next, overflow := addUint64(active, slotBytes)
				if overflow {
					return false, fmt.Errorf("active bytes overflow")
				}
				active = next
			case types.SlotStatus_SLOT_STATUS_REPAIRING:
				next, overflow := addUint64(repairing, slotBytes)
				if overflow {
					return false, fmt.Errorf("repairing bytes overflow")
				}
				repairing = next
			}
		}
		return false, nil
	})

	return active, repairing, err
}
