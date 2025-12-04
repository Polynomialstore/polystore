package keeper

import (
	"context"

	"github.com/cosmos/cosmos-sdk/types/query"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"nilchain/x/nilchain/types"
)

func (k queryServer) ListProofs(ctx context.Context, req *types.QueryListProofsRequest) (*types.QueryListProofsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	proofs, pageRes, err := query.CollectionPaginate(
		ctx,
		k.k.Proofs,
		req.Pagination,
		func(key uint64, value types.Proof) (*types.Proof, error) {
			return &value, nil
		},
	)

	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListProofsResponse{Proof: proofs, Pagination: pageRes}, nil
}