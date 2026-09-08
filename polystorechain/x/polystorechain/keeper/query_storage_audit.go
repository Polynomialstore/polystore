package keeper

import (
	"context"
	"errors"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"polystorechain/x/polystorechain/types"
)

func (q queryServer) storageAuditView(ctx sdk.Context, a types.FrozenStorageAudit, e types.FrozenStorageAuditEpoch) (types.StorageAuditView, error) {
	c, err := types.StorageAuditContext(a, e.EpochLength)
	if err != nil {
		return types.StorageAuditView{}, err
	}
	transcript, err := c.Bytes()
	if err != nil {
		return types.StorageAuditView{}, err
	}
	anchor, err := q.k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return types.StorageAuditView{}, err
	}
	seed := anchor.Seed
	if len(seed) != 32 {
		seed = nil
	}
	return types.StorageAuditView{Audit: &a, EpochLength: e.EpochLength, CanonicalContext: transcript, Seed: seed, Finalized: e.Finalized}, nil
}

func (q queryServer) ListStorageAuditsByProvider(goCtx context.Context, req *types.QueryListStorageAuditsByProviderRequest) (*types.QueryListStorageAuditsByProviderResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "request required")
	}
	provider, err := requireCanonicalProviderCreator(req.Provider)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	length, err := q.k.StorageAuditEpochLength.Get(ctx)
	if errors.Is(err, collections.ErrNotFound) {
		return &types.QueryListStorageAuditsByProviderResponse{}, nil
	}
	if err != nil {
		return nil, err
	}
	current := epochIDAtHeight(ctx.BlockHeight(), length)
	out := &types.QueryListStorageAuditsByProviderResponse{}
	for epoch := current; epoch > 0 && current-epoch < 2; epoch-- {
		e, err := q.k.StorageAuditEpochs.Get(ctx, epoch)
		if errors.Is(err, collections.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		audits, err := q.k.StorageAuditsForEpoch(ctx, epoch)
		if err != nil {
			return nil, err
		}
		for _, a := range audits {
			if a.Assignment == nil || a.Assignment.Provider != provider {
				continue
			}
			view, err := q.storageAuditView(ctx, a, e)
			if err != nil {
				return nil, err
			}
			out.Audits = append(out.Audits, view)
		}
	}
	return out, nil
}

func (q queryServer) GetStorageAuditChallenge(goCtx context.Context, req *types.QueryGetStorageAuditChallengeRequest) (*types.QueryGetStorageAuditChallengeResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "request required")
	}
	provider, err := requireCanonicalProviderCreator(req.Provider)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	epoch, err := q.k.StorageAuditEpochs.Get(ctx, req.EpochId)
	if err != nil {
		return nil, status.Error(codes.NotFound, "storage audit epoch not retained")
	}
	audits, err := q.k.StorageAuditsForEpoch(ctx, req.EpochId)
	if err != nil {
		return nil, err
	}
	for _, a := range audits {
		if a.Assignment == nil || a.Assignment.Snapshot == nil || a.Assignment.DealId != req.DealId || a.Assignment.Provider != provider || a.Assignment.Snapshot.Slot != req.Slot {
			continue
		}
		view, err := q.storageAuditView(ctx, a, epoch)
		if err != nil {
			return nil, err
		}
		out := &types.QueryGetStorageAuditChallengeResponse{Audit: &view}
		if len(view.Seed) != 32 {
			return out, nil
		}
		c, err := types.StorageAuditContext(a, epoch.EpochLength)
		if err != nil {
			return nil, err
		}
		challenges, err := c.Challenges(view.Seed)
		if err != nil {
			return nil, err
		}
		for _, v := range challenges {
			out.Challenges = append(out.Challenges, types.StorageAuditChallenge{Ordinal: v.Ordinal, PopulationIndex: v.PopulationIndex, MduIndex: v.MDUIndex, LeafIndex: v.LeafIndex, Z: append([]byte(nil), v.Z[:]...)})
		}
		return out, nil
	}
	return nil, status.Error(codes.NotFound, "storage obligation not issued")
}
