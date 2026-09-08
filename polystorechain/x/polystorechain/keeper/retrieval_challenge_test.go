package keeper_test

import (
	"bytes"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// The activation fixture is deliberately isolated from deployment qualification:
// production activation also requires the C4 audit and #256/#257/#260 gates.
func activateSessionFixture(t *testing.T, f *fixture) sdk.Context {
	t.Helper()
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1).WithChainID("retrieval-v2-test").WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	params, err := f.keeper.Params.Get(ctx)
	require.NoError(t, err)
	params.RetrievalV2ActivationHeight = 1
	require.NoError(t, f.keeper.Params.Set(ctx, params))
	require.NoError(t, f.keeper.BeginBlock(ctx))
	active, err := f.keeper.RetrievalV2Active(ctx)
	require.NoError(t, err)
	require.True(t, active)
	return ctx.WithBlockHeight(2)
}

func TestRetrievalV2RejectsCopiedProofBeforePayeePin(t *testing.T) {
	f, _, server, owner, created, _ := setupRetrievalExpiryDeal(t)
	ctx := activateSessionFixture(t, f)
	data := make([]byte, types.MDU_SIZE)
	for i := 0; i < len(data); i += 32 {
		data[i+31] = byte(i/32%251 + 1)
	}
	_, proof := commitMode2ContentAndProofData(t, f, ctx, server, owner, created.DealId, data)
	deal, err := f.keeper.Deals.Get(ctx, created.DealId)
	require.NoError(t, err)
	opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{
		Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot,
		StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20, ChallengeVersion: 2,
	})
	require.NoError(t, err)
	header := ctx.BlockHeader()
	header.Height = 3
	seed := bytes.Repeat([]byte{0x37}, 32)
	ctx = ctx.WithBlockHeader(header).WithHeaderHash(seed)
	require.NoError(t, f.keeper.BeginBlock(ctx))
	ctx = ctx.WithBlockHeight(4)
	session, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	challenge, err := types.RetrievalChallengeContext(session)
	require.NoError(t, err)
	expected, err := challenge.Challenges(seed)
	require.NoError(t, err)
	proof.ZValue = expected[0].Z[:]
	proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(data[:types.BlobSizeBytes], proof.ZValue)
	require.NoError(t, err)
	_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{
		Creator: created.AssignedProviders[1], SessionId: opened.SessionId, Proofs: []types.ChainedProof{proof},
	})
	require.ErrorContains(t, err, "authorized proof provider")
	_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, opened.SessionId)
	require.ErrorIs(t, err, collections.ErrNotFound)
	wrongZ := proof
	wrongZ.ZValue = bytes.Repeat([]byte{1}, 32)
	_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: []types.ChainedProof{wrongZ}})
	require.ErrorContains(t, err, "exact session challenge")
	// A later content generation cannot invalidate the already funded statement.
	deal.ManifestRoot = bytes.Repeat([]byte{0x99}, 32)
	deal.CurrentGen++
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
	require.NoError(t, f.keeper.Providers.Remove(ctx, created.AssignedProviders[0]))
	msg := &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: []types.ChainedProof{proof}}
	_, err = server.SubmitRetrievalSessionProof(ctx, msg)
	require.NoError(t, err)
	submitted, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, submitted.Status)
	_, err = f.keeper.DealActivityStates.Get(ctx, deal.Id)
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.NoError(t, f.keeper.Mode2EpochSlotServed.Walk(ctx, nil, func(_ collections.Pair[collections.Pair[uint64, uint32], uint64], _ uint64) (bool, error) {
		t.Fatal("session proof must not create audit served credit")
		return true, nil
	}))
	// A retry budget below one proof's crypto price establishes that accepted-state
	// retries cannot reenter prepaid verification or add another counter update.
	retryCtx := ctx.WithBlockHeight(5).WithGasMeter(storetypes.NewGasMeter(499999))
	_, err = server.SubmitRetrievalSessionProof(retryCtx, msg)
	require.NoError(t, err)
	unchanged, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	require.Equal(t, submitted, unchanged)
	_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.NoError(t, err)
	activity, err := f.keeper.DealActivityStates.Get(ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, uint64(types.BlobSizeBytes), activity.BytesServedTotal)
	require.Equal(t, uint64(1), activity.SuccessfulRetrievalsTotal)
	_, err = server.SubmitRetrievalSessionProof(retryCtx, msg)
	require.NoError(t, err)
	_, err = server.ConfirmRetrievalSession(retryCtx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.NoError(t, err)
	after, err := f.keeper.DealActivityStates.Get(ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, activity, after)
	_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, opened.SessionId)
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestRetrievalV2ChallengeWindowAndSeedFailBeforeCrypto(t *testing.T) {
	f, _, server, owner, created, deal := setupRetrievalExpiryDeal(t)
	ctx := activateSessionFixture(t, f)
	opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
	require.NoError(t, err)
	msg := &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: []types.ChainedProof{{MduIndex: 2}}}
	for _, height := range []int64{2, 3} {
		bounded := ctx.WithBlockHeight(height).WithGasMeter(storetypes.NewGasMeter(499999))
		_, err := server.SubmitRetrievalSessionProof(bounded, msg)
		require.ErrorContains(t, err, "response window")
		require.Less(t, bounded.GasMeter().GasConsumed(), uint64(499999))
	}
	ctx = ctx.WithBlockHeight(3).WithHeaderHash(nil)
	require.NoError(t, f.keeper.BeginBlock(ctx))
	bounded := ctx.WithBlockHeight(4).WithGasMeter(storetypes.NewGasMeter(499999))
	_, err = server.SubmitRetrievalSessionProof(bounded, msg)
	require.ErrorContains(t, err, "seed unavailable")
	require.Less(t, bounded.GasMeter().GasConsumed(), uint64(499999))
	require.NoError(t, f.keeper.BeginBlock(ctx.WithBlockHeight(4).WithHeaderHash(bytes.Repeat([]byte{7}, 32))))
	anchor, err := f.keeper.ChallengeAnchors.Get(ctx, 3)
	require.NoError(t, err)
	require.Empty(t, anchor.Seed)
	_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, opened.SessionId)
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestRetrievalV2ExpiryReleasesRetentionWithoutCancelAndPreservesRefund(t *testing.T) {
	f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
	ctx := activateSessionFixture(t, f)
	opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 4, ChallengeVersion: 2})
	require.NoError(t, err)
	require.Equal(t, "98stake", bank.moduleBalances[types.ModuleName].String())
	ctx = ctx.WithBlockHeight(3).WithHeaderHash(bytes.Repeat([]byte{8}, 32))
	require.NoError(t, f.keeper.BeginBlock(ctx))
	require.NoError(t, f.keeper.BeginBlock(ctx.WithBlockHeight(4)))
	live, err := f.keeper.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(1), live)
	ctx = ctx.WithBlockHeight(5)
	require.NoError(t, f.keeper.BeginBlock(ctx))
	live, err = f.keeper.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Zero(t, live)
	_, err = f.keeper.ChallengeAnchors.Get(ctx, 3)
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = f.keeper.RetrievalSessionGenerationRefs.Get(ctx, collections.Join(deal.Id, deal.CurrentGen))
	require.ErrorIs(t, err, collections.ErrNotFound)
	session, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, session.Status)
	require.Equal(t, "3", session.LockedFee.String())
	_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.ErrorContains(t, err, "expired")
	after, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	require.Equal(t, session, after, "an error must not mutate persisted status")
	_, err = server.CancelRetrievalSession(ctx, &types.MsgCancelRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.NoError(t, err)
	refunded, err := f.keeper.Deals.Get(ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, "98", refunded.EscrowBalance.String())
	_, err = server.CancelRetrievalSession(ctx, &types.MsgCancelRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.NoError(t, err)
	require.Equal(t, "98stake", bank.moduleBalances[types.ModuleName].String())
	_, err = f.keeper.DealActivityStates.Get(ctx, deal.Id)
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestRetrievalV2AdmissionCapsBeforeFundingAndNonce(t *testing.T) {
	for _, capName := range []string{"opens", "expiry", "live", "deal generations", "global generations"} {
		t.Run(capName, func(t *testing.T) {
			f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
			ctx := activateSessionFixture(t, f)
			switch capName {
			case "opens":
				require.NoError(t, f.keeper.RetrievalSessionOpenCounts.Set(ctx, 2, types.MaxRetrievalSessionOpensPerBlock))
			case "expiry":
				require.NoError(t, f.keeper.RetrievalSessionExpiryCounts.Set(ctx, 10, types.MaxRetrievalSessionExpiryRefsPerBlock))
			case "live":
				require.NoError(t, f.keeper.RetrievalSessionLiveCount.Set(ctx, types.MaxLiveRetrievalSessionContexts))
			case "deal generations":
				require.NoError(t, f.keeper.RetrievalSessionGenerationCounts.Set(ctx, deal.Id, types.MaxRetrievalSessionGenerationsPerDeal))
			case "global generations":
				require.NoError(t, f.keeper.RetrievalSessionGenerationCount.Set(ctx, types.MaxRetrievalSessionGenerations))
			}
			_, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
			require.ErrorContains(t, err, "capacity exhausted")
			requireNoRetrievalSessionState(t, f, ctx)
			after, err := f.keeper.Deals.Get(ctx, deal.Id)
			require.NoError(t, err)
			require.Equal(t, deal.EscrowBalance, after.EscrowBalance)
			require.Equal(t, "100stake", bank.moduleBalances[types.ModuleName].String())
		})
	}
}

func TestRetrievalV2ProtocolAndSponsoredRefundDestinations(t *testing.T) {
	t.Run("protocol", func(t *testing.T) {
		setup := setupProtocolRepairSession(t)
		ctx := activateSessionFixture(t, setup.f)
		msg := &types.MsgOpenProtocolRetrievalSession{Creator: setup.pending, DealId: setup.deal.Id, Provider: setup.active, ManifestRoot: setup.deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, MaxTotalFee: math.ZeroInt(), ChallengeVersion: 2, Purpose: types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR, Auth: &types.MsgOpenProtocolRetrievalSession_Repair{Repair: &types.RepairAuth{Slot: 0}}}
		msg.AuthorizedProofProvider = setup.pending
		_, err := setup.msgServer.OpenProtocolRetrievalSession(ctx, msg)
		require.ErrorContains(t, err, "does not authorize a deputy")
		require.Equal(t, "1000stake", setup.bank.moduleBalances[types.ProtocolBudgetModuleName].String())
		msg.AuthorizedProofProvider = ""
		opened, err := setup.msgServer.OpenProtocolRetrievalSession(ctx, msg)
		require.NoError(t, err)
		require.Equal(t, "997stake", setup.bank.moduleBalances[types.ProtocolBudgetModuleName].String())
		_, err = setup.msgServer.CancelRetrievalSession(ctx.WithBlockHeight(11), &types.MsgCancelRetrievalSession{Creator: setup.pending, SessionId: opened.SessionId})
		require.NoError(t, err)
		require.Equal(t, "999stake", setup.bank.moduleBalances[types.ProtocolBudgetModuleName].String())
		require.Empty(t, setup.bank.moduleBalances[types.ModuleName])
	})
	t.Run("sponsored", func(t *testing.T) {
		f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
		ctx := activateSessionFixture(t, f)
		// Public retrieval preserves requester funding and records its exact payer.
		_, err := server.UpdateDealRetrievalPolicy(ctx, &types.MsgUpdateDealRetrievalPolicy{Creator: owner, DealId: deal.Id, Policy: types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC}})
		require.NoError(t, err)
		requester := sdk.AccAddress(bytes.Repeat([]byte{0x71}, 20))
		bank.setAccountBalance(requester, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
		opened, err := server.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{Creator: requester.String(), DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, MaxTotalFee: math.ZeroInt(), ChallengeVersion: 2, AuthorizedProofProvider: created.AssignedProviders[1]})
		require.NoError(t, err)
		require.Equal(t, "95stake", bank.accountBalances[requester.String()].String())
		_, err = server.CancelRetrievalSession(ctx.WithBlockHeight(11), &types.MsgCancelRetrievalSession{Creator: requester.String(), SessionId: opened.SessionId})
		require.NoError(t, err)
		require.Equal(t, "98stake", bank.accountBalances[requester.String()].String())
		require.Equal(t, "100stake", bank.moduleBalances[types.ModuleName].String())
	})
}

func TestRetrievalV2LegacyLiabilityQuarantineAndZeroFeeMissingPin(t *testing.T) {
	f, _, server, owner, created, deal := setupRetrievalExpiryDeal(t)
	legacyCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	opened, err := server.OpenRetrievalSession(legacyCtx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10})
	require.NoError(t, err)
	ctx := activateSessionFixture(t, f)
	_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.ErrorContains(t, err, "expiry-refund-only")
	_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: []types.ChainedProof{{}}})
	require.ErrorContains(t, err, "expiry-refund-only")
	params, err := f.keeper.Params.Get(ctx)
	require.NoError(t, err)
	params.RetrievalV2ActivationHeight = 0
	require.ErrorContains(t, f.keeper.SetParams(ctx, params), "irreversible")
	_, err = server.CancelRetrievalSession(ctx.WithBlockHeight(11), &types.MsgCancelRetrievalSession{Creator: owner, SessionId: opened.SessionId})
	require.NoError(t, err)
	// A zero-price accepted state still requires an authenticated persisted pin.
	secured, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 2, ExpiresAt: 10, ChallengeVersion: 2})
	require.NoError(t, err)
	session, err := f.keeper.RetrievalSessions.Get(ctx, secured.SessionId)
	require.NoError(t, err)
	session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED
	session.LockedFee = math.ZeroInt()
	require.NoError(t, f.keeper.RetrievalSessions.Set(ctx, secured.SessionId, session))
	_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: secured.SessionId})
	require.ErrorContains(t, err, "proof provider unavailable")
	unchanged, err := f.keeper.RetrievalSessions.Get(ctx, secured.SessionId)
	require.NoError(t, err)
	require.Equal(t, session, unchanged)
}
