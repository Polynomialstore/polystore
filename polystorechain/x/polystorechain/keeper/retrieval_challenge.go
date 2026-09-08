package keeper

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

// Candidate reservation for bounded future anchor and expiry KV work.
// Qualification against the session profile is required by #260.
const RetrievalSessionRetentionGas = uint64(100000)

func optionalSessionCount(n uint64, err error) (uint64, error) {
	if errors.Is(err, collections.ErrNotFound) {
		return 0, nil
	}
	return n, err
}

// RetrievalV2Active fails closed if an activation boundary was skipped or state
// is unreadable. The durable latch prevents a parameter rollback reviving v1.
func (k Keeper) RetrievalV2Active(ctx sdk.Context) (bool, error) {
	h, err := optionalSessionCount(k.RetrievalV2ActivatedHeight.Get(ctx))
	if err != nil {
		return false, err
	}
	if h != 0 {
		return true, nil
	}
	params, err := k.Params.Get(ctx)
	if err != nil {
		return false, err
	}
	if params.RetrievalV2ActivationHeight != 0 && ctx.BlockHeight() >= 0 && uint64(ctx.BlockHeight()) >= params.RetrievalV2ActivationHeight {
		return false, fmt.Errorf("retrieval v2 activation must execute in BeginBlock before transaction admission")
	}
	return false, nil
}

func (k Keeper) activateRetrievalV2(ctx sdk.Context) error {
	h, err := optionalSessionCount(k.RetrievalV2ActivatedHeight.Get(ctx))
	if err != nil || h != 0 {
		return err
	}
	params, err := k.Params.Get(ctx)
	if err != nil {
		return err
	}
	if params.RetrievalV2ActivationHeight == 0 || ctx.BlockHeight() < 0 || uint64(ctx.BlockHeight()) < params.RetrievalV2ActivationHeight {
		return nil
	}
	if uint64(ctx.BlockHeight()) != params.RetrievalV2ActivationHeight {
		return fmt.Errorf("missed retrieval v2 activation boundary")
	}
	if err := params.Validate(); err != nil {
		return err
	}
	// C4 integration must add its bounded assignment preflight here before
	// coordinated activation. Merging this session slice does not qualify it.
	return k.RetrievalV2ActivatedHeight.Set(ctx, params.RetrievalV2ActivationHeight)
}

// processRetrievalChallengeState does at most 128 expiry-reference releases and
// captures at most one height anchor. It never scans sessions or changes their
// economic/status records. Admission reserves these finite future operations.
func (k Keeper) processRetrievalChallengeState(ctx sdk.Context) error {
	if err := k.activateRetrievalV2(ctx); err != nil {
		return err
	}
	active, err := k.RetrievalV2Active(ctx)
	if err != nil || !active {
		return err
	}
	if ctx.BlockHeight() < 2 {
		return nil
	}
	height := uint64(ctx.BlockHeight())
	anchorHeight := height - 1
	pending, err := k.ChallengePendingAnchors.Has(ctx, anchorHeight)
	if err != nil {
		return err
	}
	if pending {
		anchor, err := k.ChallengeAnchors.Get(ctx, anchorHeight)
		if err != nil {
			return err
		}
		if len(anchor.Seed) != 0 {
			return fmt.Errorf("challenge anchor already captured")
		}
		// At H+2 this is the committed H+1 block, not the current proposal hash.
		seed := ctx.BlockHeader().LastBlockId.Hash
		if len(seed) == 32 {
			anchor.Seed = append([]byte(nil), seed...)
		}
		// An unavailable anchor stays unavailable; do not retry using a later block.
		if err := k.ChallengeAnchors.Set(ctx, anchorHeight, anchor); err != nil {
			return err
		}
		if err := k.ChallengePendingAnchors.Remove(ctx, anchorHeight); err != nil {
			return err
		}
	}
	if err := k.RetrievalSessionOpenCounts.Remove(ctx, height-1); err != nil {
		return err
	}
	expiry := height - 1
	count, err := optionalSessionCount(k.RetrievalSessionExpiryCounts.Get(ctx, expiry))
	if err != nil {
		return err
	}
	if count > types.MaxRetrievalSessionExpiryRefsPerBlock {
		return fmt.Errorf("session expiry bucket exceeds profile bound")
	}
	keys := make([]collections.Pair[uint64, []byte], 0, count)
	err = k.RetrievalSessionExpiryRefs.Walk(ctx, collections.NewPrefixedPairRange[uint64, []byte](expiry), func(key collections.Pair[uint64, []byte], _ bool) (bool, error) {
		if uint64(len(keys)) >= count {
			return true, fmt.Errorf("session expiry index/count mismatch")
		}
		keys = append(keys, key)
		return false, nil
	})
	if err != nil {
		return err
	}
	if uint64(len(keys)) != count {
		return fmt.Errorf("session expiry index/count mismatch")
	}
	for _, key := range keys {
		session, err := k.RetrievalSessions.Get(ctx, key.K2())
		if err != nil {
			return err
		}
		c, err := types.RetrievalChallengeContext(session)
		if err != nil {
			return err
		}
		if c.Window.Deadline != expiry {
			return fmt.Errorf("session expiry index/context mismatch")
		}
		anchor, err := k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
		if err != nil {
			return err
		}
		if anchor.SessionReferences == 0 {
			return fmt.Errorf("session anchor reference underflow")
		}
		anchor.SessionReferences--
		if anchor.SessionReferences == 0 && anchor.AuditReferences == 0 {
			if err := k.ChallengeAnchors.Remove(ctx, c.Window.Anchor); err != nil {
				return err
			}
		} else if err := k.ChallengeAnchors.Set(ctx, c.Window.Anchor, anchor); err != nil {
			return err
		}
		generationKey := collections.Join(session.DealId, c.Generation)
		refs, err := k.RetrievalSessionGenerationRefs.Get(ctx, generationKey)
		if err != nil {
			return err
		}
		if refs == 0 {
			return fmt.Errorf("session generation reference underflow")
		}
		if refs == 1 {
			dealCount, err := k.RetrievalSessionGenerationCounts.Get(ctx, session.DealId)
			if err != nil {
				return err
			}
			globalCount, err := k.RetrievalSessionGenerationCount.Get(ctx)
			if err != nil {
				return err
			}
			if dealCount == 0 || globalCount == 0 {
				return fmt.Errorf("session generation count underflow")
			}
			if err := k.RetrievalSessionGenerationRefs.Remove(ctx, generationKey); err != nil {
				return err
			}
			if dealCount == 1 {
				if err := k.RetrievalSessionGenerationCounts.Remove(ctx, session.DealId); err != nil {
					return err
				}
			} else if err := k.RetrievalSessionGenerationCounts.Set(ctx, session.DealId, dealCount-1); err != nil {
				return err
			}
			if err := k.RetrievalSessionGenerationCount.Set(ctx, globalCount-1); err != nil {
				return err
			}
		} else if err := k.RetrievalSessionGenerationRefs.Set(ctx, generationKey, refs-1); err != nil {
			return err
		}
		if err := k.RetrievalSessionExpiryRefs.Remove(ctx, key); err != nil {
			return err
		}
	}
	if count > 0 {
		live, err := k.RetrievalSessionLiveCount.Get(ctx)
		if err != nil {
			return err
		}
		if live < count {
			return fmt.Errorf("live session reference underflow")
		}
		if err := k.RetrievalSessionLiveCount.Set(ctx, live-count); err != nil {
			return err
		}
		if err := k.RetrievalSessionExpiryCounts.Remove(ctx, expiry); err != nil {
			return err
		}
	}
	return nil
}

// prepareRetrievalSession performs all nonce, authority, snapshot and future-work
// admission before any fee transfer or voucher consumption. It does not write.
func (k Keeper) prepareRetrievalSession(ctx sdk.Context, deal types.Deal, owner, provider, authorized string, version uint32, startMDU uint64, startLeaf uint32, count, nonce, expiry uint64) (types.RetrievalSession, error) {
	s := types.RetrievalSession{}
	active, err := k.RetrievalV2Active(ctx)
	if err != nil {
		return s, err
	}
	if (active && version != retrievalchallenge.Version) || (!active && version != 0) || (version == 0 && authorized != "") {
		return s, sdkerrors.ErrInvalidRequest.Wrap("unsupported retrieval challenge version; v2 requires coordinated activation")
	}
	ownerAddr, err := sdk.AccAddressFromBech32(owner)
	if err != nil || len(ownerAddr) != 20 {
		return s, sdkerrors.ErrInvalidAddress.Wrap("invalid session owner")
	}
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	if err != nil || len(providerAddr) != 20 {
		return s, sdkerrors.ErrInvalidAddress.Wrap("invalid assigned provider")
	}
	if version == retrievalchallenge.Version && (ownerAddr.String() != owner || providerAddr.String() != provider) {
		return s, sdkerrors.ErrInvalidAddress.Wrap("session actors must use canonical addresses")
	}
	lastNonce, err := optionalSessionCount(k.RetrievalSessionNonces.Get(ctx, collections.Join(collections.Join(owner, deal.Id), provider)))
	if err != nil {
		return s, err
	}
	if nonce <= lastNonce {
		return s, sdkerrors.ErrInvalidRequest.Wrap("nonce replay rejected")
	}
	id, err := types.HashRetrievalSessionID(ownerAddr, deal.Id, providerAddr, deal.ManifestRoot, startMDU, startLeaf, count, nonce, expiry)
	if err != nil {
		return s, err
	}
	totalBytes, overflow := mulUint64(count, types.BlobSizeBytes)
	if overflow {
		return s, sdkerrors.ErrInvalidRequest.Wrap("total_bytes overflow")
	}
	s = types.RetrievalSession{SessionId: id, DealId: deal.Id, Owner: owner, Provider: provider, ManifestRoot: append([]byte(nil), deal.ManifestRoot...), StartMduIndex: startMDU, StartBlobIndex: startLeaf, BlobCount: count, TotalBytes: totalBytes, Nonce: nonce, ExpiresAt: expiry, OpenedHeight: ctx.BlockHeight(), UpdatedHeight: ctx.BlockHeight(), Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, ChallengeVersion: version}
	if version == 0 {
		return s, nil
	}
	if authorized == "" {
		authorized = provider
	}
	payee, err := canonicalAddress(authorized, "authorized_proof_provider")
	if err != nil {
		return s, err
	}
	if _, err := k.Providers.Get(ctx, payee); err != nil {
		return s, sdkerrors.ErrUnauthorized.Wrapf("authorized proof provider is not registered: %v", err)
	}
	s.AuthorizedProofProvider = payee
	payeeAddr, _ := sdk.AccAddressFromBech32(payee)
	s.SessionId, err = types.HashRetrievalSessionIDV2(id, ctx.ChainID(), payeeAddr)
	if err != nil {
		return s, err
	}
	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return s, err
	}
	meta, overflow := addUint64(deal.WitnessMdus, 1)
	if overflow || deal.TotalMdus <= meta || ctx.BlockHeight() < 1 || expiry < uint64(ctx.BlockHeight()) || expiry-uint64(ctx.BlockHeight()) > types.MaxRetrievalSessionTTL {
		return s, sdkerrors.ErrInvalidRequest.Wrap("invalid v2 session allocation or TTL")
	}
	setup, _ := hex.DecodeString(types.RetrievalSetupDigest)
	s.ChallengeSnapshot = &types.RetrievalChallengeSnapshot{ChainId: ctx.ChainID(), SetupDigest: setup, Generation: deal.CurrentGen, Layout: uint32(retrievalchallenge.Replica), K: 1, MetadataMdus: meta, UserMdus: deal.TotalMdus - meta, DealEnd: deal.EndBlock}
	if stripe.mode == 2 {
		slot := uint64(startLeaf) / stripe.rows
		if slot > uint64(^uint32(0)) || stripe.k > 64 || stripe.m > 255 {
			return s, sdkerrors.ErrInvalidRequest.Wrap("invalid v2 stripe profile")
		}
		s.ChallengeSnapshot.Layout = uint32(retrievalchallenge.Stripe)
		s.ChallengeSnapshot.K = uint32(stripe.k)
		s.ChallengeSnapshot.M = uint32(stripe.m)
		s.ChallengeSnapshot.Slot = uint32(slot)
	}
	if _, err := types.RetrievalChallengeContext(s); err != nil {
		return s, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	if err := k.checkSessionChallengeCapacity(ctx, s); err != nil {
		return s, err
	}
	return s, nil
}

func (k Keeper) checkSessionChallengeCapacity(ctx context.Context, s types.RetrievalSession) error {
	live, err := optionalSessionCount(k.RetrievalSessionLiveCount.Get(ctx))
	if err != nil {
		return err
	}
	opens, err := optionalSessionCount(k.RetrievalSessionOpenCounts.Get(ctx, uint64(s.OpenedHeight)))
	if err != nil {
		return err
	}
	expiring, err := optionalSessionCount(k.RetrievalSessionExpiryCounts.Get(ctx, s.ExpiresAt))
	if err != nil {
		return err
	}
	if live >= types.MaxLiveRetrievalSessionContexts || opens >= types.MaxRetrievalSessionOpensPerBlock || expiring >= types.MaxRetrievalSessionExpiryRefsPerBlock {
		return sdkerrors.ErrInvalidRequest.Wrap("retrieval session challenge capacity exhausted")
	}
	refs, err := optionalSessionCount(k.RetrievalSessionGenerationRefs.Get(ctx, collections.Join(s.DealId, s.ChallengeSnapshot.Generation)))
	if err != nil {
		return err
	}
	if refs == 0 {
		perDeal, err := optionalSessionCount(k.RetrievalSessionGenerationCounts.Get(ctx, s.DealId))
		if err != nil {
			return err
		}
		global, err := optionalSessionCount(k.RetrievalSessionGenerationCount.Get(ctx))
		if err != nil {
			return err
		}
		if perDeal >= types.MaxRetrievalSessionGenerationsPerDeal || global >= types.MaxRetrievalSessionGenerations {
			return sdkerrors.ErrInvalidRequest.Wrap("retrieval session retained generation capacity exhausted")
		}
	}
	return nil
}

func (k Keeper) retainSessionChallenge(ctx sdk.Context, s types.RetrievalSession) error {
	if s.ChallengeVersion != retrievalchallenge.Version {
		return nil
	}
	if err := k.checkSessionChallengeCapacity(ctx, s); err != nil {
		return err
	}
	c, err := types.RetrievalChallengeContext(s)
	if err != nil {
		return err
	}
	// Up-front charge reserves bounded future activation and expiry KV work. This
	// is a deterministic devnet reservation, not measured crypto gas.
	ctx.GasMeter().ConsumeGas(RetrievalSessionRetentionGas, "retrieval challenge activation/retention reservation")
	anchor, err := k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if errors.Is(err, collections.ErrNotFound) {
		if err := k.ChallengePendingAnchors.Set(ctx, c.Window.Anchor, true); err != nil {
			return err
		}
	}
	if anchor.SessionReferences >= types.MaxRetrievalSessionOpensPerBlock {
		return fmt.Errorf("session anchor reference capacity exhausted")
	}
	anchor.SessionReferences++
	if err := k.ChallengeAnchors.Set(ctx, c.Window.Anchor, anchor); err != nil {
		return err
	}
	if err := k.RetrievalSessionExpiryRefs.Set(ctx, collections.Join(s.ExpiresAt, s.SessionId), true); err != nil {
		return err
	}
	live, err := optionalSessionCount(k.RetrievalSessionLiveCount.Get(ctx))
	if err != nil {
		return err
	}
	if err := k.RetrievalSessionLiveCount.Set(ctx, live+1); err != nil {
		return err
	}
	opens, err := optionalSessionCount(k.RetrievalSessionOpenCounts.Get(ctx, uint64(s.OpenedHeight)))
	if err != nil {
		return err
	}
	if err := k.RetrievalSessionOpenCounts.Set(ctx, uint64(s.OpenedHeight), opens+1); err != nil {
		return err
	}
	expiring, err := optionalSessionCount(k.RetrievalSessionExpiryCounts.Get(ctx, s.ExpiresAt))
	if err != nil {
		return err
	}
	if err := k.RetrievalSessionExpiryCounts.Set(ctx, s.ExpiresAt, expiring+1); err != nil {
		return err
	}
	genKey := collections.Join(s.DealId, c.Generation)
	refs, err := optionalSessionCount(k.RetrievalSessionGenerationRefs.Get(ctx, genKey))
	if err != nil {
		return err
	}
	if refs == 0 {
		perDeal, err := optionalSessionCount(k.RetrievalSessionGenerationCounts.Get(ctx, s.DealId))
		if err != nil {
			return err
		}
		if err := k.RetrievalSessionGenerationCounts.Set(ctx, s.DealId, perDeal+1); err != nil {
			return err
		}
		global, err := optionalSessionCount(k.RetrievalSessionGenerationCount.Get(ctx))
		if err != nil {
			return err
		}
		if err := k.RetrievalSessionGenerationCount.Set(ctx, global+1); err != nil {
			return err
		}
	}
	return k.RetrievalSessionGenerationRefs.Set(ctx, genKey, refs+1)
}
