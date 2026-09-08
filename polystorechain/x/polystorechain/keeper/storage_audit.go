package keeper

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"math"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func storageAssignmentKey(a types.FrozenStorageAssignment) string {
	return fmt.Sprintf("%020d/%03d/%s", a.DealId, a.Snapshot.Slot, a.Provider)
}

// storageAssignmentsForDeal excludes empty/uncommitted/expired deals. Pending
// repair is a separate purpose and never an ACTIVE audit assignment.
func storageAssignmentsForDeal(ctx sdk.Context, d types.Deal) ([]types.FrozenStorageAssignment, error) {
	if len(d.Mode2Slots) > 256 {
		return nil, fmt.Errorf("deal %d mode2 slot inventory exceeds wire bound", d.Id)
	}
	if d.TotalMdus == 0 || len(d.ManifestRoot) == 0 || d.EndBlock <= uint64(ctx.BlockHeight()) {
		return nil, nil
	}
	if len(d.ManifestRoot) != 32 || d.TotalMdus > 65537 || d.WitnessMdus >= d.TotalMdus || d.EndBlock > math.MaxInt64 || d.StartBlock > math.MaxInt64 {
		return nil, fmt.Errorf("deal %d requires valid bounded content layout before v2 activation", d.Id)
	}
	meta := d.WitnessMdus + 1
	if d.TotalMdus == meta {
		return nil, nil
	}
	stripe, err := stripeParamsForDeal(d)
	if err != nil {
		return nil, err
	}
	setup, _ := hex.DecodeString(types.RetrievalSetupDigest)
	base := types.RetrievalChallengeSnapshot{ChainId: ctx.ChainID(), SetupDigest: setup, Generation: d.CurrentGen, Layout: uint32(retrievalchallenge.Replica), K: 1, MetadataMdus: meta, UserMdus: d.TotalMdus - meta, DealEnd: d.EndBlock}
	if stripe.mode == 2 {
		base.Layout = uint32(retrievalchallenge.Stripe)
		base.K = uint32(stripe.k)
		base.M = uint32(stripe.m)
	}
	out := make([]types.FrozenStorageAssignment, 0)
	add := func(provider string, slot uint32, kind uint8) error {
		if len(out) >= types.MaxStorageAuditAssignments {
			return fmt.Errorf("storage assignment inventory exceeds %d", types.MaxStorageAuditAssignments)
		}
		addr, err := requireCanonicalProviderCreator(provider)
		if err != nil {
			return err
		}
		s := base
		s.Slot = slot
		a := types.FrozenStorageAssignment{DealId: d.Id, Provider: addr, ManifestRoot: append([]byte(nil), d.ManifestRoot...), Snapshot: &s, Kind: uint32(kind), DealStart: d.StartBlock}
		// Validate layout/population with a synthetic legal epoch, independent of the
		// real response window (which may deliberately issue no obligation).
		probe := a
		copySnapshot := s
		copySnapshot.DealEnd = math.MaxInt64
		probe.Snapshot = &copySnapshot
		if _, err := types.StorageAuditContext(types.FrozenStorageAudit{EpochId: 1, Assignment: &probe, SampleCount: 1}, 2); err != nil {
			return err
		}
		out = append(out, a)
		return nil
	}
	if stripe.mode == 2 {
		if len(d.Mode2Slots) == 0 {
			return nil, fmt.Errorf("mode2 v2 storage inventory requires explicit assignment slots")
		}
		seen := map[uint32]bool{}
		for index, slot := range d.Mode2Slots {
			if slot == nil {
				continue
			}
			if slot.Slot != uint32(index) || seen[slot.Slot] || uint64(slot.Slot) >= stripe.slotCount {
				return nil, fmt.Errorf("invalid or duplicate mode2 assignment slot")
			}
			seen[slot.Slot] = true
			switch slot.Status {
			case types.SlotStatus_SLOT_STATUS_ACTIVE:
				if slot.PendingProvider != "" {
					return nil, fmt.Errorf("ACTIVE slot has pending provider")
				}
				if err := add(slot.Provider, slot.Slot, retrievalchallenge.Audit); err != nil {
					return nil, err
				}
			case types.SlotStatus_SLOT_STATUS_REPAIRING:
				if slot.PendingProvider != "" && slot.RepairTargetGen == d.CurrentGen {
					if err := add(slot.PendingProvider, slot.Slot, retrievalchallenge.Repair); err != nil {
						return nil, err
					}
				}
			}
		}
	} else {
		seen := map[string]bool{}
		for _, p := range d.Providers {
			if seen[p] {
				return nil, fmt.Errorf("duplicate replica assignment")
			}
			seen[p] = true
			if err := add(p, 0, retrievalchallenge.Audit); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func (k Keeper) storageAssignmentInventory(ctx sdk.Context) ([]types.FrozenStorageAssignment, error) {
	out := make([]types.FrozenStorageAssignment, 0, types.MaxStorageAuditAssignments)
	err := k.StorageAuditAssignments.Walk(ctx, nil, func(key string, a types.FrozenStorageAssignment) (bool, error) {
		if len(out) >= types.MaxStorageAuditAssignments {
			return true, fmt.Errorf("storage assignment inventory exceeds bound")
		}
		if a.Snapshot == nil || key != storageAssignmentKey(a) {
			return true, fmt.Errorf("corrupt storage assignment index")
		}
		out = append(out, a)
		return false, nil
	})
	return out, err
}

// Activation examines at most 65 legacy deal records, including expired records.
// Larger legacy inventories require a separately reviewed bounded migration;
// silently skipping history would make completeness impossible to establish.
func (k Keeper) preflightStorageAudits(ctx sdk.Context, params types.Params) error {
	if params.EpochLenBlocks < 2 || params.EpochLenBlocks > math.MaxInt64 || params.QuotaMaxBlobs > retrievalchallenge.MaxSamples || params.QuotaMinBlobs > retrievalchallenge.MaxSamples {
		return fmt.Errorf("invalid bounded storage audit profile")
	}
	assignments := make([]types.FrozenStorageAssignment, 0, types.MaxStorageAuditAssignments)
	legacySlots := make([]collections.Pair[uint64, uint32], 0, types.MaxStorageAuditAssignments)
	examined := 0
	err := k.Deals.Walk(ctx, nil, func(_ uint64, d types.Deal) (bool, error) {
		examined++
		if examined > types.MaxStorageAuditAssignments {
			return true, fmt.Errorf("v2 migration examines at most 64 legacy deals; larger inventory requires reviewed bounded migration")
		}
		a, err := storageAssignmentsForDeal(ctx, d)
		if err != nil {
			return true, err
		}
		if len(assignments)+len(a) > types.MaxStorageAuditAssignments {
			return true, fmt.Errorf("v2 ACTIVE and repair inventory exceeds 64 assignments")
		}
		if len(legacySlots)+len(d.Mode2Slots) > types.MaxStorageAuditAssignments {
			return true, fmt.Errorf("v2 migration clears at most 64 legacy slots; larger inventory requires reviewed bounded migration")
		}
		assignments = append(assignments, a...)
		// Completion addresses slots by array index. Clear even empty/expired
		// entries: no pre-activation readiness has v2 proof provenance.
		for slot := range d.Mode2Slots {
			legacySlots = append(legacySlots, collections.Join(d.Id, uint32(slot)))
		}
		return false, nil
	})
	if err != nil {
		return err
	}
	// Only mutate after the entire bounded legacy inventory passes preflight.
	for _, key := range legacySlots {
		if err := k.clearMode2RepairReadiness(ctx, key.K1(), key.K2()); err != nil {
			return err
		}
	}
	for _, a := range assignments {
		if err := k.StorageAuditAssignments.Set(ctx, storageAssignmentKey(a), a); err != nil {
			return err
		}
	}
	return k.StorageAuditEpochLength.Set(ctx, params.EpochLenBlocks)
}

// syncStorageAuditAssignments runs inside the shared deal mutation cache. It
// examines only the bounded live view; historic Deals are never scanned here.
func (k Keeper) syncStorageAuditAssignments(ctx sdk.Context, d types.Deal) error {
	active, err := optionalSessionCount(k.RetrievalV2ActivatedHeight.Get(ctx))
	if err != nil || active == 0 {
		return err
	}
	desired, err := storageAssignmentsForDeal(ctx, d)
	if err != nil {
		return err
	}
	old, err := k.storageAssignmentInventory(ctx)
	if err != nil {
		return err
	}
	remove := make([]string, 0)
	remaining := 0
	for _, a := range old {
		if a.DealId == d.Id || a.Snapshot.DealEnd <= uint64(ctx.BlockHeight()) {
			remove = append(remove, storageAssignmentKey(a))
		} else {
			remaining++
		}
	}
	if remaining+len(desired) > types.MaxStorageAuditAssignments {
		return fmt.Errorf("v2 ACTIVE and repair inventory exceeds 64 assignments")
	}
	// Scalar legacy readiness is safe only while identity, root and generation
	// remain identical. This protects explicit CompleteSlotRepair admission too.
	previous, err := k.Deals.Get(ctx, d.Id)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	for _, slot := range previous.Mode2Slots {
		if slot == nil {
			continue
		}
		same := false
		for _, next := range d.Mode2Slots {
			if next != nil && next.Slot == slot.Slot {
				same = slot.Status == next.Status && slot.PendingProvider == next.PendingProvider && slot.RepairTargetGen == next.RepairTargetGen && sameRepairContent(previous, d)
				break
			}
		}
		if !same {
			if err := k.clearMode2RepairReadiness(ctx, d.Id, slot.Slot); err != nil {
				return err
			}
		}
	}
	for _, key := range remove {
		if err := k.StorageAuditAssignments.Remove(ctx, key); err != nil {
			return err
		}
	}
	for _, a := range desired {
		if err := k.StorageAuditAssignments.Set(ctx, storageAssignmentKey(a), a); err != nil {
			return err
		}
	}
	return nil
}

// storageAuditQuota operates on the exact finite population. A zero max is the
// explicit disabled policy in v2; legacy v1 retains its historical uncapped rule.
// A scalar readiness marker is usable only for the entire same frozen content
// layout, even if a future mutation path permits a profile change at one root.
func sameRepairContent(a, b types.Deal) bool {
	if a.CurrentGen != b.CurrentGen || !bytes.Equal(a.ManifestRoot, b.ManifestRoot) || a.RedundancyMode != b.RedundancyMode || a.TotalMdus != b.TotalMdus || a.WitnessMdus != b.WitnessMdus {
		return false
	}
	if a.Mode2Profile == nil || b.Mode2Profile == nil {
		return a.Mode2Profile == nil && b.Mode2Profile == nil
	}
	return a.Mode2Profile.K == b.Mode2Profile.K && a.Mode2Profile.M == b.Mode2Profile.M
}

func storageAuditQuota(p types.Params, d types.Deal, a types.FrozenStorageAssignment) (uint64, error) {
	s := a.Snapshot
	rows := uint64(64)
	if s.Layout == uint32(retrievalchallenge.Stripe) {
		if s.K == 0 {
			return 0, fmt.Errorf("invalid stripe")
		}
		rows /= uint64(s.K)
	}
	u, overflow := mulUint64(s.UserMdus, rows)
	if overflow {
		return 0, fmt.Errorf("audit population overflow")
	}
	if u == 0 || p.QuotaMaxBlobs == 0 {
		return 0, nil
	}
	if p.QuotaMinBlobs > retrievalchallenge.MaxSamples || p.QuotaMaxBlobs > retrievalchallenge.MaxSamples {
		return 0, fmt.Errorf("audit quota exceeds protocol cap")
	}
	q := mulDivCeil(u, quotaBpsForDeal(p, d), 10000)
	if q < p.QuotaMinBlobs {
		q = p.QuotaMinBlobs
	}
	if q > p.QuotaMaxBlobs {
		q = p.QuotaMaxBlobs
	}
	if q > u {
		q = u
	}
	if a.Kind == uint32(retrievalchallenge.Repair) {
		q = mulDivCeil(q, p.RepairReadinessQuotaBps, 10000)
		if q == 0 {
			q = 1 // preserve the existing readiness minimum for an enabled quota
		}
	}
	return q, nil
}

func (k Keeper) StorageAuditsForEpoch(ctx sdk.Context, epoch uint64) ([]types.FrozenStorageAudit, error) {
	record, err := k.StorageAuditEpochs.Get(ctx, epoch)
	if err != nil {
		return nil, err
	}
	if record.ObligationCount > types.MaxStorageAuditAssignments {
		return nil, fmt.Errorf("audit epoch exceeds bound")
	}
	out := make([]types.FrozenStorageAudit, 0, record.ObligationCount)
	for i := uint32(0); i < record.ObligationCount; i++ {
		a, err := k.StorageAudits.Get(ctx, collections.Join(epoch, i))
		if err != nil {
			return nil, err
		}
		if a.EpochId != epoch {
			return nil, fmt.Errorf("corrupt audit epoch")
		}
		out = append(out, a)
	}
	return out, nil
}

func (k Keeper) processStorageAudits(ctx sdk.Context) error {
	p, err := k.Params.Get(ctx)
	if err != nil {
		return err
	}
	length, err := k.StorageAuditEpochLength.Get(ctx)
	if err != nil {
		return err
	}
	if length != p.EpochLenBlocks {
		return fmt.Errorf("storage audit epoch length cannot change while v2 active")
	}
	if !isEpochStart(ctx.BlockHeight(), length) {
		return nil
	}
	epoch := epochIDAtHeight(ctx.BlockHeight(), length)
	exists, err := k.StorageAuditEpochs.Has(ctx, epoch)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("storage audit snapshot already frozen")
	}
	// Retain only current and previous epochs; release shared anchors only when
	// both audit and session reference counts reach zero.
	if epoch > 2 {
		if err := k.pruneStorageAuditEpoch(ctx, epoch-2); err != nil {
			return err
		}
	}
	inventory, err := k.storageAssignmentInventory(ctx)
	if err != nil {
		return err
	}
	record := types.FrozenStorageAuditEpoch{EpochId: epoch, EpochLength: length, Params: &p}
	for _, a := range inventory {
		s := a.Snapshot
		w, issued, err := retrievalchallenge.AuditWindow(epoch, length, s.DealEnd)
		if err != nil {
			return err
		}
		if s.DealEnd <= uint64(ctx.BlockHeight()) {
			if err := k.StorageAuditAssignments.Remove(ctx, storageAssignmentKey(a)); err != nil {
				return err
			}
			continue
		}
		if !issued || a.DealStart > w.Snapshot {
			continue
		}
		d, err := k.Deals.Get(ctx, a.DealId)
		if err != nil {
			return err
		}
		q, err := storageAuditQuota(p, d, a)
		if err != nil {
			return err
		}
		if q == 0 {
			continue
		}
		audit := types.FrozenStorageAudit{EpochId: epoch, Assignment: &a, SampleCount: q, Coverage: make([]byte, (q+7)/8)}
		if _, err := types.StorageAuditContext(audit, length); err != nil {
			return err
		}
		if err := k.StorageAudits.Set(ctx, collections.Join(epoch, record.ObligationCount), audit); err != nil {
			return err
		}
		record.ObligationCount++
		anchor, err := k.ChallengeAnchors.Get(ctx, w.Anchor)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
		if anchor.AuditReferences >= types.MaxStorageAuditAssignments {
			return fmt.Errorf("audit anchor reference bound")
		}
		anchor.AuditReferences++
		if err := k.ChallengeAnchors.Set(ctx, w.Anchor, anchor); err != nil {
			return err
		}
		if err := k.ChallengePendingAnchors.Set(ctx, w.Anchor, true); err != nil {
			return err
		}
		key := collections.Join(a.DealId, s.Generation)
		refs, err := optionalSessionCount(k.StorageAuditGenerationRefs.Get(ctx, key))
		if err != nil {
			return err
		}
		if refs >= 2*types.MaxStorageAuditAssignments {
			return fmt.Errorf("audit generation reference bound")
		}
		if err := k.StorageAuditGenerationRefs.Set(ctx, key, refs+1); err != nil {
			return err
		}
	}
	return k.StorageAuditEpochs.Set(ctx, epoch, record)
}

func (k Keeper) pruneStorageAuditEpoch(ctx sdk.Context, epoch uint64) error {
	exists, err := k.StorageAuditEpochs.Has(ctx, epoch)
	if err != nil || !exists {
		return err
	}
	record, err := k.StorageAuditEpochs.Get(ctx, epoch)
	if err != nil {
		return err
	}
	audits, err := k.StorageAuditsForEpoch(ctx, epoch)
	if err != nil {
		return err
	}
	for i, a := range audits {
		c, err := types.StorageAuditContext(a, record.EpochLength)
		if err != nil {
			return err
		}
		anchor, err := k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
		if err != nil {
			return err
		}
		if anchor.AuditReferences == 0 {
			return fmt.Errorf("audit anchor reference underflow")
		}
		anchor.AuditReferences--
		if anchor.AuditReferences == 0 && anchor.SessionReferences == 0 {
			err = k.ChallengeAnchors.Remove(ctx, c.Window.Anchor)
		} else {
			err = k.ChallengeAnchors.Set(ctx, c.Window.Anchor, anchor)
		}
		if err != nil {
			return err
		}
		key := collections.Join(c.DealID, c.Generation)
		refs, err := k.StorageAuditGenerationRefs.Get(ctx, key)
		if err != nil {
			return err
		}
		if refs == 0 {
			return fmt.Errorf("audit generation reference underflow")
		}
		if refs == 1 {
			err = k.StorageAuditGenerationRefs.Remove(ctx, key)
		} else {
			err = k.StorageAuditGenerationRefs.Set(ctx, key, refs-1)
		}
		if err != nil {
			return err
		}
		if err := k.StorageAudits.Remove(ctx, collections.Join(epoch, uint32(i))); err != nil {
			return err
		}
	}
	return k.StorageAuditEpochs.Remove(ctx, epoch)
}
