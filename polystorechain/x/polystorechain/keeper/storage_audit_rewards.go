package keeper

import (
	"errors"
	"fmt"
	"math"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func (k Keeper) usableStorageAudit(ctx sdk.Context, a types.FrozenStorageAudit, length uint64) (bool, error) {
	c, err := types.StorageAuditContext(a, length)
	if err != nil {
		return false, nil
	}
	anchor, err := k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
	if errors.Is(err, collections.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(anchor.Seed) != 32 || a.AcceptedCount > a.SampleCount || len(a.Coverage) != int((a.SampleCount+7)/8) {
		return false, nil
	}
	count := uint64(0)
	for i := uint64(0); i < a.SampleCount; i++ {
		if a.Coverage[i/8]&(1<<(i%8)) != 0 {
			count++
		}
	}
	return count == a.AcceptedCount, nil
}

func storageAuditBytes(a types.FrozenStorageAudit) (uint64, error) {
	s := a.Assignment.Snapshot
	rows := uint64(64)
	if s.Layout == uint32(retrievalchallenge.Stripe) {
		if s.K == 0 {
			return 0, fmt.Errorf("invalid storage stripe")
		}
		rows /= uint64(s.K)
	}
	n, overflow := mulUint64(s.UserMdus, rows)
	if overflow {
		return 0, fmt.Errorf("storage population overflow")
	}
	n, overflow = mulUint64(n, uint64(types.BlobSizeBytes))
	if overflow {
		return 0, fmt.Errorf("storage bytes overflow")
	}
	return n, nil
}

func (k Keeper) frozenStorageRewardWeights(ctx sdk.Context, epochID uint64) (baseRewardWeights, error) {
	out := baseRewardWeights{byProvider: make(map[string]uint64)}
	epoch, err := k.StorageAuditEpochs.Get(ctx, epochID)
	if err != nil {
		return out, err
	}
	audits, err := k.StorageAuditsForEpoch(ctx, epochID)
	if err != nil {
		return out, err
	}
	for _, a := range audits {
		if a.Assignment == nil || a.Assignment.Kind != uint32(retrievalchallenge.Audit) {
			continue
		}
		usable, err := k.usableStorageAudit(ctx, a, epoch.EpochLength)
		if err != nil {
			return out, err
		}
		if !usable {
			continue
		}
		n, err := storageAuditBytes(a)
		if err != nil {
			return out, err
		}
		var overflow bool
		out.totalActiveSlotBytes, overflow = addUint64(out.totalActiveSlotBytes, n)
		if overflow {
			return out, fmt.Errorf("storage reward bytes overflow")
		}
		if a.AcceptedCount != a.SampleCount {
			continue
		}
		provider, err := k.Providers.Get(ctx, a.Assignment.Provider)
		if errors.Is(err, collections.ErrNotFound) {
			continue
		}
		if err != nil {
			return out, err
		}
		reason, err := k.providerHealthRewardIneligibility(ctx, provider)
		if err != nil {
			return out, err
		}
		if reason != "" {
			continue
		}
		out.totalWeight, overflow = addUint64(out.totalWeight, n)
		if overflow {
			return out, fmt.Errorf("storage reward weight overflow")
		}
		out.byProvider[a.Assignment.Provider] += n
	}
	return out, nil
}

func (k Keeper) finalizeStorageAuditEpoch(ctx sdk.Context) error {
	length, err := k.StorageAuditEpochLength.Get(ctx)
	if err != nil {
		return err
	}
	if !isEpochEnd(ctx.BlockHeight(), length) {
		return nil
	}
	epochID := epochIDAtHeight(ctx.BlockHeight(), length)
	epoch, err := k.StorageAuditEpochs.Get(ctx, epochID)
	if errors.Is(err, collections.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if epoch.Finalized {
		return nil
	}
	if epoch.Params == nil {
		return fmt.Errorf("missing frozen audit policy")
	}
	audits, err := k.StorageAuditsForEpoch(ctx, epochID)
	if err != nil {
		return err
	}
	previous := map[string]uint64{}
	if epochID > 1 {
		old, err := k.StorageAuditsForEpoch(ctx, epochID-1)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
		for _, a := range old {
			if a.Assignment != nil && a.Assignment.Snapshot != nil && a.Assignment.Kind == uint32(retrievalchallenge.Audit) {
				previous[storageAssignmentKey(*a.Assignment)] = a.MissedEpochs
			}
		}
	}
	for i, a := range audits {
		if a.Assignment == nil || a.Assignment.Kind != uint32(retrievalchallenge.Audit) {
			continue
		}
		usable, err := k.usableStorageAudit(ctx, a, length)
		if err != nil {
			return err
		}
		if !usable {
			continue
		}
		c, err := types.StorageAuditContext(a, length)
		if err != nil {
			return err
		}
		missing := a.AcceptedCount < a.SampleCount
		if missing {
			prev := previous[storageAssignmentKey(*a.Assignment)]
			if prev == math.MaxUint64 {
				return fmt.Errorf("audit missed epochs overflow")
			}
			a.MissedEpochs = prev + 1
		}
		if err := k.StorageAudits.Set(ctx, collections.Join(epochID, uint32(i)), a); err != nil {
			return err
		}
		if c.Layout == retrievalchallenge.Replica {
			key := collections.Join(c.DealID, a.Assignment.Provider)
			if missing {
				err = k.Mode1MissedEpochs.Set(ctx, key, a.MissedEpochs)
			} else {
				err = k.Mode1MissedEpochs.Remove(ctx, key)
			}
			if err != nil {
				return err
			}
			continue
		}
		d, err := k.Deals.Get(ctx, c.DealID)
		if err != nil {
			return err
		}
		// Frozen provider outcomes survive root/assignment changes. Slot mutation is
		// permitted only if this is still the same ACTIVE provider; a replacement
		// never inherits its predecessor's missed count or slot-health transition.
		same := uint64(ctx.BlockHeight()) < d.EndBlock && int(c.Slot) < len(d.Mode2Slots) && d.Mode2Slots[c.Slot] != nil && d.Mode2Slots[c.Slot].Provider == a.Assignment.Provider && d.Mode2Slots[c.Slot].Status == types.SlotStatus_SLOT_STATUS_ACTIVE
		if !same {
			if missing {
				for _, kind := range []string{"quota_miss_recorded", storageMissHealthKind(*epoch.Params, a.MissedEpochs)} {
					if err := k.recordMode2SoftFaultForAssignment(ctx, a.Assignment.Provider, c.DealID, c.Slot, epochID, kind, a.MissedEpochs, false); err != nil {
						return err
					}
				}
			}
			continue
		}
		key := collections.Join(c.DealID, c.Slot)
		if !missing {
			if err := k.Mode2MissedEpochs.Remove(ctx, key); err != nil {
				return err
			}
			continue
		}
		if err := k.Mode2MissedEpochs.Set(ctx, key, a.MissedEpochs-1); err != nil {
			return err
		}
		changed, err := k.applyMode2QuotaShortfall(ctx, *epoch.Params, &d, c.Slot, epochID, a.SampleCount, 0, a.AcceptedCount)
		if err != nil {
			return err
		}
		if changed {
			if err := k.setDealWithAssignmentCollateralLocks(ctx, d.Id, d); err != nil {
				return err
			}
		}
	}
	if err := k.distributeBaseRewardPool(ctx, epochID); err != nil {
		return err
	}
	epoch.Finalized = true
	if err := k.StorageAuditEpochs.Set(ctx, epochID, epoch); err != nil {
		return err
	}
	// Existing global operational hooks remain shared. Their historical scans are
	// not made bounded by the new C4 inventory and need whole-chain capacity evidence.
	if err := k.applyProviderHealthEpochDecay(ctx, epochID); err != nil {
		return err
	}
	if err := k.scheduleUnderbondedRepairs(ctx, epochID); err != nil {
		return err
	}
	if err := k.scheduleDrainingRepairs(ctx, epochID); err != nil {
		return err
	}
	return k.scheduleRoutineRotations(ctx, epochID)
}

func storageMissHealthKind(p types.Params, missed uint64) string {
	if p.EvictAfterMissedEpochs > 0 && missed >= p.EvictAfterMissedEpochs {
		return "provider_delinquent"
	}
	return "provider_degraded"
}
