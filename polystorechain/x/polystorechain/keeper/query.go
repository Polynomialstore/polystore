package keeper

import (
	"context"
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/types"
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

// GetDealActivity implements the deal activity query.
func (q queryServer) GetDealActivity(goCtx context.Context, req *types.QueryGetDealActivityRequest) (*types.QueryGetDealActivityResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	activity, err := q.k.DealActivityStates.Get(ctx, req.DealId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			// Return an empty activity state instead of error for UX
			return &types.QueryGetDealActivityResponse{
				Activity: types.DealActivityState{
					BytesServedTotal:      0,
					FailedChallengesTotal: 0,
					LastUpdateHeight:      0,
				},
			}, nil
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetDealActivityResponse{Activity: activity}, nil
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

	response := &types.QueryGetRetrievalSessionResponse{Session: session}
	if session.ChallengeVersion == 2 {
		c, err := types.RetrievalChallengeContext(session)
		if err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		response.ChallengeContext, err = c.Bytes()
		if err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		hash, err := c.Hash()
		if err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		response.ChallengeContextHash = hash[:]
		anchor, err := q.k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.Internal, err.Error())
		}
		if err == nil && len(anchor.Seed) == 32 {
			response.ChallengeSeed = anchor.Seed
		}
	}
	return response, nil
}

func (q queryServer) GetRetrievalSessionV3(goCtx context.Context, req *types.QueryGetRetrievalSessionV3Request) (*types.QueryGetRetrievalSessionV3Response, error) {
	if req == nil || len(req.SessionId) != 32 {
		return nil, status.Error(codes.InvalidArgument, "session_id must be 32 bytes")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	session, err := q.k.retrievalSessionV3(ctx, req.SessionId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "v3 retrieval session not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	response := &types.QueryGetRetrievalSessionV3Response{Session: session}
	anchorSeed, err := q.k.retrievalSessionV3AnchorSeed(ctx, session)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err == nil && len(anchorSeed) == 32 {
		response.AnchorSeed = append([]byte(nil), anchorSeed...)
	}
	return response, nil
}

func (q queryServer) GetRetrievalSessionV3Nonce(goCtx context.Context, req *types.QueryGetRetrievalSessionV3NonceRequest) (*types.QueryGetRetrievalSessionV3NonceResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	owner, err := canonicalAddress(req.Owner, "owner")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	nonce, err := q.k.RetrievalSessionV3Nonces.Get(ctx, collections.Join(owner, req.DealId))
	if errors.Is(err, collections.ErrNotFound) {
		return &types.QueryGetRetrievalSessionV3NonceResponse{}, nil
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &types.QueryGetRetrievalSessionV3NonceResponse{Nonce: nonce, Found: true}, nil
}

func (q queryServer) GetRetrievalSessionV3ByNonce(goCtx context.Context, req *types.QueryGetRetrievalSessionV3ByNonceRequest) (*types.QueryGetRetrievalSessionV3ByNonceResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	owner, err := canonicalAddress(req.Owner, "owner")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	id, err := q.k.RetrievalSessionV3NonceIDs.Get(ctx, collections.Join(collections.Join(owner, req.DealId), req.Nonce))
	if errors.Is(err, collections.ErrNotFound) {
		return nil, status.Error(codes.NotFound, "v3 retrieval session nonce not found")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if len(id) != 32 {
		return nil, status.Error(codes.Internal, "invalid stored v3 retrieval session ID")
	}
	return &types.QueryGetRetrievalSessionV3ByNonceResponse{SessionId: append([]byte(nil), id...)}, nil
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
