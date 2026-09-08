package keeper

import (
	"errors"
	"sort"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

// The funded retrieval task pool is separate from ACTIVE storage obligations.
// On v2 its candidate work is bounded by the same frozen ACTIVE view; task
// completion still earns zero storage-audit or readiness coverage.
func (k Keeper) frozenAuditTaskDeals(ctx sdk.Context) ([]types.Deal, error) {
	length, err := k.StorageAuditEpochLength.Get(ctx)
	if err != nil {
		return nil, err
	}
	epoch := epochIDAtHeight(ctx.BlockHeight(), length)
	audits, err := k.StorageAuditsForEpoch(ctx, epoch)
	if err != nil {
		return nil, err
	}
	byDeal := make(map[uint64]*types.Deal)
	for _, a := range audits {
		if a.Assignment == nil || a.Assignment.Kind != uint32(retrievalchallenge.Audit) {
			continue
		}
		valid, err := k.usableStorageAudit(ctx, a, length)
		if err != nil {
			return nil, err
		}
		if !valid {
			continue
		}
		f := a.Assignment
		s := f.Snapshot
		d := byDeal[f.DealId]
		if d == nil {
			d = &types.Deal{Id: f.DealId, ManifestRoot: f.ManifestRoot, CurrentGen: s.Generation, StartBlock: f.DealStart, EndBlock: s.DealEnd, TotalMdus: s.MetadataMdus + s.UserMdus, WitnessMdus: s.MetadataMdus - 1}
			byDeal[d.Id] = d
		}
		d.Providers = append(d.Providers, f.Provider)
		if s.Layout == uint32(retrievalchallenge.Stripe) {
			d.RedundancyMode = 2
			d.Mode2Profile = &types.StripeReplicaProfile{K: s.K, M: s.M}
			d.Mode2Slots = append(d.Mode2Slots, &types.DealSlot{Slot: s.Slot, Provider: f.Provider, Status: types.SlotStatus_SLOT_STATUS_ACTIVE})
		}
	}
	ids := make([]uint64, 0, len(byDeal))
	for id := range byDeal {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]types.Deal, 0, len(ids))
	for _, id := range ids {
		out = append(out, *byDeal[id])
	}
	return out, nil
}

func (k Keeper) walkProtocolAuditDeals(ctx sdk.Context, visit func(uint64, types.Deal) (bool, error)) error {
	active, err := k.RetrievalV2Active(ctx)
	if err != nil {
		return err
	}
	if !active {
		return k.Deals.Walk(ctx, nil, visit)
	}
	deals, err := k.frozenAuditTaskDeals(ctx)
	if err != nil {
		return err
	}
	for _, d := range deals {
		stop, err := visit(d.Id, d)
		if err != nil || stop {
			return err
		}
	}
	return nil
}
func (k Keeper) walkProtocolAuditProviders(ctx sdk.Context, visit func(string, types.Provider) (bool, error)) error {
	active, err := k.RetrievalV2Active(ctx)
	if err != nil {
		return err
	}
	if !active {
		return k.Providers.Walk(ctx, nil, visit)
	}
	deals, err := k.frozenAuditTaskDeals(ctx)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, d := range deals {
		for _, p := range d.Providers {
			seen[p] = true
		}
	}
	providers := make([]string, 0, len(seen))
	for p := range seen {
		providers = append(providers, p)
	}
	sort.Strings(providers)
	for _, p := range providers {
		record, err := k.Providers.Get(ctx, p)
		if errors.Is(err, collections.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		stop, err := visit(p, record)
		if stop || err != nil {
			return err
		}
	}
	return nil
}
