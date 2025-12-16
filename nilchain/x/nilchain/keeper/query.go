package keeper

import (
	"context"
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"nilchain/x/nilchain/types"
)

var _ types.QueryServer = queryServer{}

// NewQueryServerImpl returns an implementation of the QueryServer interface
// for the provided Keeper.
func NewQueryServerImpl(k Keeper) types.QueryServer {
	return queryServer{k}
}

type queryServer struct {
	k Keeper
}

// GetDealHeat implements types.QueryServer.
func (q queryServer) GetDealHeat(goCtx context.Context, req *types.QueryGetDealHeatRequest) (*types.QueryGetDealHeatResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	heat, err := q.k.DealHeatStates.Get(ctx, req.DealId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			// Return empty heat state instead of error for UX
			return &types.QueryGetDealHeatResponse{
				Heat: types.DealHeatState{
					BytesServedTotal:      0,
					FailedChallengesTotal: 0,
					LastUpdateHeight:      0,
				},
			}, nil
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetDealHeatResponse{Heat: heat}, nil
}

// GetReceiptNonce returns the last accepted retrieval receipt nonce for a (deal_id, file_path).
func (q queryServer) GetReceiptNonce(goCtx context.Context, req *types.QueryGetReceiptNonceRequest) (*types.QueryGetReceiptNonceResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	filePath := strings.TrimSpace(req.FilePath)
	if filePath == "" {
		return nil, status.Error(codes.InvalidArgument, "file_path is required")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	lastNonce, err := q.k.ReceiptNoncesByDealFile.Get(ctx, collections.Join(req.DealId, filePath))
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return &types.QueryGetReceiptNonceResponse{LastNonce: 0}, nil
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetReceiptNonceResponse{LastNonce: lastNonce}, nil
}

func (q queryServer) GetRetrievalSession(goCtx context.Context, req *types.QueryGetRetrievalSessionRequest) (*types.QueryGetRetrievalSessionResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	if len(req.SessionId) != 32 {
		return nil, status.Error(codes.InvalidArgument, "session_id must be 32 bytes")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	session, err := q.k.RetrievalSessions.Get(ctx, req.SessionId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "retrieval session not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetRetrievalSessionResponse{Session: session}, nil
}

func (q queryServer) ListRetrievalSessionsByOwner(goCtx context.Context, req *types.QueryListRetrievalSessionsByOwnerRequest) (*types.QueryListRetrievalSessionsByOwnerResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	owner := strings.TrimSpace(req.Owner)
	if owner == "" {
		return nil, status.Error(codes.InvalidArgument, "owner is required")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	sessions := make([]types.RetrievalSession, 0)
	err := q.k.RetrievalSessionsByOwner.Walk(ctx, nil, func(key collections.Pair[string, []byte], _ uint64) (stop bool, err error) {
		if key.K1() != owner {
			return false, nil
		}
		s, err := q.k.RetrievalSessions.Get(ctx, key.K2())
		if err != nil {
			return false, nil
		}
		sessions = append(sessions, s)
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListRetrievalSessionsByOwnerResponse{Sessions: sessions}, nil
}

func (q queryServer) ListRetrievalSessionsByProvider(goCtx context.Context, req *types.QueryListRetrievalSessionsByProviderRequest) (*types.QueryListRetrievalSessionsByProviderResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		return nil, status.Error(codes.InvalidArgument, "provider is required")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	sessions := make([]types.RetrievalSession, 0)
	err := q.k.RetrievalSessionsByProvider.Walk(ctx, nil, func(key collections.Pair[string, []byte], _ uint64) (stop bool, err error) {
		if key.K1() != provider {
			return false, nil
		}
		s, err := q.k.RetrievalSessions.Get(ctx, key.K2())
		if err != nil {
			return false, nil
		}
		sessions = append(sessions, s)
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListRetrievalSessionsByProviderResponse{Sessions: sessions}, nil
}
