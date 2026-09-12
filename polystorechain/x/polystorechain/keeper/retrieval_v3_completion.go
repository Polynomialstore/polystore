package keeper

import (
	"errors"
	"fmt"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

// fullySettledV3 is used only after stored-session validation. A zero price is
// not completion: every represented obligation must have actually settled.
func fullySettledV3(s types.RetrievalSessionV3) bool {
	if len(s.Obligations) == 0 {
		return false
	}
	for _, o := range s.Obligations {
		if s.SettledSlotsMask&(uint32(1)<<o.Slot) == 0 {
			return false
		}
	}
	return true
}

// retrievalSessionV3AnchorSeed preserves the existing query/replay contract.
// Only chain-created, fully settled sessions may use durable terminal material.
func (k Keeper) retrievalSessionV3AnchorSeed(ctx sdk.Context, s types.RetrievalSessionV3) ([]byte, error) {
	if fullySettledV3(s) {
		seed, err := k.RetrievalSessionV3TerminalAnchors.Get(ctx, s.SessionId)
		if err == nil {
			if len(seed) != 32 {
				return nil, fmt.Errorf("invalid v3 terminal anchor seed")
			}
			return seed, nil
		}
		if !errors.Is(err, collections.ErrNotFound) {
			return nil, err
		}
	}
	anchor, err := k.ChallengeAnchors.Get(ctx, s.AnchorHeight)
	return anchor.Seed, err
}

// releaseTerminalRetrievalSessionV3 executes in the caller's transaction cache.
// Its seed row is also the durable exactly-once release marker. Old completed
// rows have no marker: an authenticated retry can release them before expiry.
func (k Keeper) releaseTerminalRetrievalSessionV3(ctx sdk.Context, s types.RetrievalSessionV3) (bool, error) {
	if !fullySettledV3(s) {
		return false, nil
	}
	seed, err := k.RetrievalSessionV3TerminalAnchors.Get(ctx, s.SessionId)
	if err == nil {
		if len(seed) != 32 {
			return false, fmt.Errorf("invalid v3 terminal anchor seed")
		}
		return false, nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	anchor, err := k.ChallengeAnchors.Get(ctx, s.AnchorHeight)
	if err != nil {
		return false, err
	}
	if len(anchor.Seed) != 32 || anchor.SessionReferences == 0 {
		return false, fmt.Errorf("invalid v3 terminal anchor reference")
	}
	expiryKey := collections.Join(s.DeadlineHeight, s.SessionId)
	has, err := k.RetrievalSessionExpiryRefs.Has(ctx, expiryKey)
	if err != nil {
		return false, err
	}
	if !has {
		return false, fmt.Errorf("missing v3 terminal expiry reference")
	}
	count, err := k.RetrievalSessionExpiryCounts.Get(ctx, s.DeadlineHeight)
	if err != nil {
		return false, err
	}
	live, err := k.RetrievalSessionLiveCount.Get(ctx)
	if err != nil {
		return false, err
	}
	if count == 0 || live == 0 {
		return false, fmt.Errorf("v3 terminal admission reference underflow")
	}
	if err := k.releaseRetrievalSessionChallengeRefs(ctx, s.DealId, s.Generation, s.AnchorHeight); err != nil {
		return false, err
	}
	if err := k.RetrievalSessionExpiryRefs.Remove(ctx, expiryKey); err != nil {
		return false, err
	}
	if count == 1 {
		err = k.RetrievalSessionExpiryCounts.Remove(ctx, s.DeadlineHeight)
	} else {
		err = k.RetrievalSessionExpiryCounts.Set(ctx, s.DeadlineHeight, count-1)
	}
	if err != nil {
		return false, err
	}
	if err := k.RetrievalSessionLiveCount.Set(ctx, live-1); err != nil {
		return false, err
	}
	if err := k.RetrievalSessionV3TerminalAnchors.Set(ctx, s.SessionId, anchor.Seed); err != nil {
		return false, err
	}
	return true, nil
}
