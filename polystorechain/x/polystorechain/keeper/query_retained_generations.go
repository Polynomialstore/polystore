package keeper

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"sort"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

type retainedGenerationKey struct{ deal, generation uint64 }

func retainedPairKey(key collections.Pair[uint64, uint64]) retainedGenerationKey {
	return retainedGenerationKey{key.K1(), key.K2()}
}
func retainedUintKey(key uint64) uint64 { return key }

const maxRetainedGenerationTuples = types.MaxRetrievalSessionGenerations + 2*types.MaxStorageAuditAssignments

// RetainedGenerations reads only reference inventories, never session/deal
// history. Terminal sessions remain protected until their actual expiry release.
// Any inconsistency fails the entire response; a partial list is unsafe for GC.
func (q queryServer) RetainedGenerations(goCtx context.Context, req *types.QueryRetainedGenerationsRequest) (*types.QueryRetainedGenerationsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "request required")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	if ctx.BlockHeight() < 0 {
		return nil, status.Error(codes.Internal, "invalid committed height")
	}
	tuples, err := q.k.retainedGenerations(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &types.QueryRetainedGenerationsResponse{CommittedHeight: uint64(ctx.BlockHeight()), Generations: tuples}, nil
}

func (k Keeper) retainedGenerations(ctx sdk.Context) ([]types.RetainedGeneration, error) {
	type generationKey = retainedGenerationKey
	roots := make(map[generationKey][32]byte)
	sessionGenerations := make(map[generationKey]uint64)
	auditGenerations := make(map[generationKey]uint64)
	sessionPerDeal := make(map[uint64]uint64)
	expiryCounts := make(map[uint64]uint64)
	anchors := make(map[uint64]types.ChallengeAnchor)
	addFields := func(chainID string, dealID, generation uint64, root [32]byte, anchor uint64, session bool) error {
		if chainID != ctx.ChainID() {
			return fmt.Errorf("retained context chain mismatch")
		}
		key := retainedGenerationKey{dealID, generation}
		if existing, exists := roots[key]; exists && existing != root {
			return fmt.Errorf("conflicting retained roots for one deal generation")
		}
		roots[key] = root
		if uint64(len(roots)) > maxRetainedGenerationTuples {
			return fmt.Errorf("retained generation union exceeds bound")
		}
		a := anchors[anchor]
		if session {
			if sessionGenerations[key] == 0 {
				sessionPerDeal[dealID]++
				if sessionPerDeal[dealID] > types.MaxRetrievalSessionGenerationsPerDeal {
					return fmt.Errorf("retained session generations per deal exceed bound")
				}
			}
			sessionGenerations[key]++
			if uint64(len(sessionGenerations)) > types.MaxRetrievalSessionGenerations {
				return fmt.Errorf("retained session generations exceed bound")
			}
			a.SessionReferences++
		} else {
			auditGenerations[key]++
			a.AuditReferences++
		}
		anchors[anchor] = a
		return nil
	}
	add := func(c retrievalchallenge.Context, session bool) error {
		return addFields(c.ChainID, c.DealID, c.Generation, c.Root, c.Window.Anchor, session)
	}
	live, err := optionalSessionCount(k.RetrievalSessionLiveCount.Get(ctx))
	if err != nil {
		return nil, err
	}
	if live > types.MaxLiveRetrievalSessionContexts {
		return nil, fmt.Errorf("live session reference count exceeds bound")
	}
	sessionCount := uint64(0)
	err = k.RetrievalSessionExpiryRefs.Walk(ctx, nil, func(key collections.Pair[uint64, []byte], present bool) (bool, error) {
		sessionCount++
		if sessionCount > types.MaxLiveRetrievalSessionContexts || sessionCount > live {
			return true, fmt.Errorf("session expiry inventory exceeds count or bound")
		}
		if !present || len(key.K2()) != 32 {
			return true, fmt.Errorf("malformed session expiry reference")
		}
		var chainID string
		var dealID, generation, anchor uint64
		var root [32]byte
		s, err := k.RetrievalSessions.Get(ctx, key.K2())
		if err == nil {
			c, err := types.RetrievalChallengeContext(s)
			if err != nil {
				return true, err
			}
			if !bytes.Equal(s.SessionId, key.K2()) || c.Window.Deadline != key.K1() {
				return true, fmt.Errorf("session expiry reference/context mismatch")
			}
			chainID, dealID, generation, root, anchor = c.ChainID, c.DealID, c.Generation, c.Root, c.Window.Anchor
		} else if errors.Is(err, collections.ErrNotFound) {
			v3, v3err := k.retrievalSessionV3(ctx, key.K2())
			if v3err != nil {
				return true, v3err
			}
			if v3.DeadlineHeight != key.K1() || v3.Expired {
				return true, fmt.Errorf("v3 session expiry reference/context mismatch")
			}
			copy(root[:], v3.PolyfsRoot)
			chainID, dealID, generation, anchor = v3.ChainId, v3.DealId, v3.Generation, v3.AnchorHeight
		} else {
			return true, err
		}
		expiryCounts[key.K1()]++
		if expiryCounts[key.K1()] > types.MaxRetrievalSessionExpiryRefsPerBlock {
			return true, fmt.Errorf("session expiry bucket exceeds bound")
		}
		return false, addFields(chainID, dealID, generation, root, anchor, true)
	})
	if err != nil {
		return nil, err
	}
	if sessionCount != live {
		return nil, fmt.Errorf("live session reference count mismatch")
	}
	if err := checkRetentionCounts(ctx, k.RetrievalSessionExpiryCounts, expiryCounts, types.MaxLiveRetrievalSessionContexts, retainedUintKey); err != nil {
		return nil, err
	}
	if err := checkRetentionCounts(ctx, k.RetrievalSessionGenerationRefs, sessionGenerations, types.MaxRetrievalSessionGenerations, retainedPairKey); err != nil {
		return nil, err
	}
	if err := checkRetentionCounts(ctx, k.RetrievalSessionGenerationCounts, sessionPerDeal, types.MaxRetrievalSessionGenerations, retainedUintKey); err != nil {
		return nil, err
	}
	global, err := optionalSessionCount(k.RetrievalSessionGenerationCount.Get(ctx))
	if err != nil {
		return nil, err
	}
	if global != uint64(len(sessionGenerations)) {
		return nil, fmt.Errorf("global session generation count mismatch")
	}

	// Two epochs and 128 records are checked independently, so an orphan index or
	// extra historic record cannot silently disappear from a supposedly full list.
	epochCounts := make(map[uint64]uint64)
	epochLengths := make(map[uint64]uint64)
	length, err := optionalSessionCount(k.StorageAuditEpochLength.Get(ctx))
	if err != nil {
		return nil, err
	}
	err = k.StorageAuditEpochs.Walk(ctx, nil, func(id uint64, e types.FrozenStorageAuditEpoch) (bool, error) {
		if len(epochCounts) >= 2 {
			return true, fmt.Errorf("retained audit epochs exceed bound")
		}
		if length < 2 || length > math.MaxInt64 || e.EpochLength != length || e.EpochId != id || e.Params == nil || e.ObligationCount > types.MaxStorageAuditAssignments {
			return true, fmt.Errorf("malformed retained audit epoch")
		}
		current := epochIDAtHeight(ctx.BlockHeight(), length)
		if id == 0 || id > current || current-id >= 2 {
			return true, fmt.Errorf("audit epoch outside retention window")
		}
		epochCounts[id] = uint64(e.ObligationCount)
		epochLengths[id] = e.EpochLength
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	auditCounts := make(map[uint64]uint64)
	auditCount := uint64(0)
	err = k.StorageAudits.Walk(ctx, nil, func(key collections.Pair[uint64, uint32], a types.FrozenStorageAudit) (bool, error) {
		auditCount++
		if auditCount > 2*types.MaxStorageAuditAssignments {
			return true, fmt.Errorf("retained audit records exceed bound")
		}
		count, exists := epochCounts[key.K1()]
		if !exists || uint64(key.K2()) >= count || a.EpochId != key.K1() {
			return true, fmt.Errorf("audit index/context mismatch")
		}
		c, err := types.StorageAuditContext(a, epochLengths[key.K1()])
		if err != nil {
			return true, err
		}
		auditCounts[key.K1()]++
		return false, add(c, false)
	})
	if err != nil {
		return nil, err
	}
	for id, count := range epochCounts {
		if auditCounts[id] != count {
			return nil, fmt.Errorf("audit epoch record count mismatch")
		}
	}
	if err := checkRetentionCounts(ctx, k.StorageAuditGenerationRefs, auditGenerations, 2*types.MaxStorageAuditAssignments, retainedPairKey); err != nil {
		return nil, err
	}
	for height, want := range anchors {
		a, err := k.ChallengeAnchors.Get(ctx, height)
		if err != nil {
			return nil, err
		}
		if (len(a.Seed) != 0 && len(a.Seed) != 32) || a.SessionReferences != want.SessionReferences || a.AuditReferences != want.AuditReferences {
			return nil, fmt.Errorf("retained anchor reference mismatch")
		}
	}
	out := make([]types.RetainedGeneration, 0, len(roots))
	for key, root := range roots {
		out = append(out, types.RetainedGeneration{DealId: key.deal, Generation: key.generation, ManifestRoot: append([]byte(nil), root[:]...)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DealId != out[j].DealId {
			return out[i].DealId < out[j].DealId
		}
		if out[i].Generation != out[j].Generation {
			return out[i].Generation < out[j].Generation
		}
		return bytes.Compare(out[i].ManifestRoot, out[j].ManifestRoot) < 0
	})
	return out, nil
}

// Check both directions, including orphan counters, with a fixed record ceiling.
func checkRetentionCounts[K any, C comparable](ctx sdk.Context, stored collections.Map[K, uint64], expected map[C]uint64, limit uint64, canonical func(K) C) error {
	seen := uint64(0)
	err := stored.Walk(ctx, nil, func(key K, count uint64) (bool, error) {
		seen++
		if seen > limit {
			return true, fmt.Errorf("retention counter inventory exceeds bound")
		}
		if count == 0 || expected[canonical(key)] != count {
			return true, fmt.Errorf("retention counter/index mismatch")
		}
		return false, nil
	})
	if err != nil {
		return err
	}
	if seen != uint64(len(expected)) {
		return fmt.Errorf("missing retention counter")
	}
	return nil
}
