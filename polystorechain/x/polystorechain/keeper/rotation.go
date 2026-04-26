package keeper

import (
	"encoding/binary"
	"fmt"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

// scheduleRoutineRotations deterministically moves a bounded amount of slot-bytes into
// REPAIRING even when providers are not draining (Mode2-only).
//
// Ordering:
// - deals are iterated in ID order (collections walk order)
// - slots are iterated in (deal_id, slot) order
func (k Keeper) scheduleRoutineRotations(ctx sdk.Context, epochID uint64) error {
	params := k.GetParams(ctx)
	if params.RotationBytesPerEpoch == 0 {
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

	err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
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
			return true, fmt.Errorf("slot bytes overflow")
		}
		slotBytes, overflow = mulUint64(slotBytes, uint64(types.BlobSizeBytes))
		if overflow {
			return true, fmt.Errorf("slot bytes overflow")
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
			// Skip if the provider is draining (handled by drain scheduler).
			if provider, err := k.Providers.Get(ctx, strings.TrimSpace(entry.Provider)); err == nil && provider.Draining {
				continue
			}

			// Enforce rotation budget.
			nextScheduled, overflow := addUint64(scheduledBytes, slotBytes)
			if overflow {
				return true, fmt.Errorf("scheduled bytes overflow")
			}
			if nextScheduled > params.RotationBytesPerEpoch {
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
					"failed to select replacement provider (rotation)",
					"deal", dealID,
					"slot", slot,
					"provider", entry.Provider,
					"error", err,
				)
				if errEvidence := k.recordRepairBackoff(ctx, dealID, entry.Provider, slot, epochID, err.Error()); errEvidence != nil {
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
			eid := deriveEvidenceID("rotation_repair_started", dealID, epochID, extra)
			if err := k.recordEvidenceSummary(ctx, dealID, strings.TrimSpace(entry.Provider), "rotation_repair_started", eid[:], "chain", false); err != nil {
				ctx.Logger().Error("failed to record evidence summary", "error", err)
			}
			caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
				DealID:             dealID,
				Slot:               slot,
				Provider:           strings.TrimSpace(entry.Provider),
				Reporter:           "chain",
				Reason:             "rotation_repair_started",
				Class:              types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
				Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
				Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
				EvidenceID:         eid[:],
				EpochID:            epochID,
				Summary:            fmt.Sprintf("routine rotation scheduled replacement %s", entry.PendingProvider),
				ConsequenceCeiling: "routine churn repair; no penalty by itself",
			})
			if err != nil {
				ctx.Logger().Error("failed to record structured rotation repair evidence", "error", err)
			} else if err := k.setSlotHealthState(ctx, slotHealthUpdate{
				DealID:          dealID,
				Slot:            slot,
				Provider:        strings.TrimSpace(entry.Provider),
				Status:          types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING,
				Reason:          "rotation_repair_started",
				Class:           types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
				Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
				EpochID:         epochID,
				EvidenceCaseID:  caseID,
				PendingProvider: entry.PendingProvider,
				RepairTargetGen: entry.RepairTargetGen,
			}); err != nil {
				ctx.Logger().Error("failed to update rotation repair slot health", "error", err)
			}

			ctx.Logger().Info(
				"slot repair started (rotation)",
				"deal", dealID,
				"slot", slot,
				"provider", entry.Provider,
				"pending_provider", entry.PendingProvider,
				"scheduled_bytes", scheduledBytes,
			)
		}

		if dealChanged {
			if err := k.Deals.Set(ctx, dealID, deal); err != nil {
				return true, err
			}
		}
		return false, nil
	})
	if err != nil {
		return err
	}
	return nil
}
