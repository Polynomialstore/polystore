package keeper_test

import (
	"bytes"
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalV2DeputyConfirmFirstConservesFees(t *testing.T) {
	for _, tc := range []struct {
		price int64
		bps   uint64
	}{{0, 500}, {3, 0}, {3, 500}, {3, 10000}} {
		t.Run(fmt.Sprintf("price%d_bps%d", tc.price, tc.bps), func(t *testing.T) {
			f, bank, server, owner, created, _ := setupRetrievalExpiryDeal(t)
			ctx := activateSessionFixture(t, f)
			params, err := f.keeper.Params.Get(ctx)
			require.NoError(t, err)
			params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, tc.price)
			require.NoError(t, f.keeper.SetParams(ctx, params))
			_, proof := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
			deal, err := f.keeper.Deals.Get(ctx, created.DealId)
			require.NoError(t, err)
			deputy := created.AssignedProviders[1]
			opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], AuthorizedProofProvider: deputy, ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
			require.NoError(t, err)
			// The existing economics contract uses the configured completion-time rate.
			params.RetrievalBurnBps = tc.bps
			require.NoError(t, f.keeper.SetParams(ctx, params))
			_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
			require.NoError(t, err)
			seed := bytes.Repeat([]byte{0x52}, 32)
			ctx = ctx.WithBlockHeight(3).WithHeaderHash(seed)
			require.NoError(t, f.keeper.BeginBlock(ctx))
			ctx = ctx.WithBlockHeight(4)
			session, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
			require.NoError(t, err)
			c, err := types.RetrievalChallengeContext(session)
			require.NoError(t, err)
			points, err := c.Challenges(seed)
			require.NoError(t, err)
			proof.ZValue = points[0].Z[:]
			proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(make([]byte, types.BlobSizeBytes), proof.ZValue)
			require.NoError(t, err)
			// Frozen deputy remains authorized even after registry and assignment changes.
			require.NoError(t, f.keeper.Providers.Remove(ctx, deputy))
			deal, err = f.keeper.Deals.Get(ctx, deal.Id)
			require.NoError(t, err)
			deal.Providers = nil
			deal.Mode2Slots = nil
			require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
			_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: []types.ChainedProof{proof}})
			require.ErrorContains(t, err, "authorized proof provider")
			msg := &types.MsgSubmitRetrievalSessionProof{Creator: deputy, SessionId: opened.SessionId, Proofs: []types.ChainedProof{proof}}
			_, err = server.SubmitRetrievalSessionProof(ctx, msg)
			require.NoError(t, err)
			completed, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
			require.NoError(t, err)
			require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, completed.Status)
			require.True(t, completed.LockedFee.IsZero())
			burn := (uint64(tc.price)*tc.bps + 9999) / 10000
			paid := bank.accountBalances[deputy].AmountOf(sdk.DefaultBondDenom)
			require.Equal(t, math.NewInt(tc.price-int64(burn)), paid)
			require.Equal(t, math.NewInt(98-tc.price), bank.moduleBalances[types.ModuleName].AmountOf(sdk.DefaultBondDenom))
			require.Equal(t, math.NewInt(100), bank.moduleBalances[types.ModuleName].AmountOf(sdk.DefaultBondDenom).Add(paid).Add(math.NewIntFromUint64(2+burn)), "remaining escrow + provider payout + burns conserve initial module funding")
			beforeTransfers := len(bank.transfers)
			_, err = server.SubmitRetrievalSessionProof(ctx.WithGasMeter(storetypes.NewGasMeter(499999)), msg)
			require.NoError(t, err)
			_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
			require.NoError(t, err)
			require.Len(t, bank.transfers, beforeTransfers)
			activity, err := f.keeper.DealActivityStates.Get(ctx, deal.Id)
			require.NoError(t, err)
			require.Equal(t, uint64(1), activity.SuccessfulRetrievalsTotal)
			require.Equal(t, uint64(types.BlobSizeBytes), activity.BytesServedTotal)
		})
	}
}

func TestRetrievalV2AllOpenedBlobsAndWholeListAdmission(t *testing.T) {
	f, _, server, owner, created, _ := setupRetrievalExpiryDeal(t)
	ctx := activateSessionFixture(t, f)
	_, first := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
	deal, err := f.keeper.Deals.Get(ctx, created.DealId)
	require.NoError(t, err)
	opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 2, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
	require.NoError(t, err)
	query := keeper.NewQueryServerImpl(f.keeper)
	before, err := query.GetRetrievalSession(ctx, &types.QueryGetRetrievalSessionRequest{SessionId: opened.SessionId})
	require.NoError(t, err)
	require.NotEmpty(t, before.ChallengeContext)
	require.Len(t, before.ChallengeContextHash, 32)
	require.Empty(t, before.ChallengeSeed)
	seed := bytes.Repeat([]byte{0x62}, 32)
	ctx = ctx.WithBlockHeight(3).WithHeaderHash(seed)
	require.NoError(t, f.keeper.BeginBlock(ctx))
	ctx = ctx.WithBlockHeight(4)
	session, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	c, err := types.RetrievalChallengeContext(session)
	require.NoError(t, err)
	expected, err := c.Challenges(seed)
	require.NoError(t, err)
	data := make([]byte, types.MDU_SIZE)
	witness, shards, err := crypto_ffi.ExpandMduRs(data, uint64(deal.Mode2Profile.K), uint64(deal.Mode2Profile.M))
	require.NoError(t, err)
	second := first
	_, second.BlobCommitment, second.MerklePath, _, _, _ = buildMode2LeafProof(t, data, uint64(deal.Mode2Profile.K), uint64(deal.Mode2Profile.M), witness, shards, 1, 0)
	second.BlobIndex = 1
	proofs := []types.ChainedProof{first, second}
	for i := range proofs {
		proofs[i].ZValue = expected[i].Z[:]
		proofs[i].KzgOpeningProof, proofs[i].YValue, err = crypto_ffi.ComputeBlobProof(data[:types.BlobSizeBytes], proofs[i].ZValue)
		require.NoError(t, err)
	}
	msg := &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: proofs[:1]}
	_, err = server.SubmitRetrievalSessionProof(ctx, msg)
	require.ErrorContains(t, err, "proof count mismatch")
	for _, mode := range []string{"wrong position", "wrong z", "malformed shape"} {
		bad := append([]types.ChainedProof(nil), proofs...)
		switch mode {
		case "wrong position":
			bad[1].BlobIndex = 0
		case "wrong z":
			bad[1].ZValue = bad[0].ZValue
		case "malformed shape":
			bad[1].KzgOpeningProof = nil
		}
		bounded := ctx.WithGasMeter(storetypes.NewGasMeter(499999))
		msg.Proofs = bad
		_, err = server.SubmitRetrievalSessionProof(bounded, msg)
		require.Error(t, err, mode)
		require.Less(t, bounded.GasMeter().GasConsumed(), uint64(499999), "late list failure must precede any prepaid crypto")
		_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, opened.SessionId)
		require.ErrorIs(t, err, collections.ErrNotFound)
	}
	msg.Proofs = proofs
	_, err = server.SubmitRetrievalSessionProof(ctx, msg)
	require.NoError(t, err)
	deal.ManifestRoot = bytes.Repeat([]byte{0x99}, 32)
	deal.CurrentGen++
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
	after, err := query.GetRetrievalSession(ctx, &types.QueryGetRetrievalSessionRequest{SessionId: opened.SessionId})
	require.NoError(t, err)
	require.Equal(t, before.ChallengeContext, after.ChallengeContext)
	require.Equal(t, before.ChallengeContextHash, after.ChallengeContextHash)
	require.Equal(t, seed, after.ChallengeSeed)
}

func TestRetrievalV2FullExpiryBucketReleasesSessionRefsAndPreservesAuditAnchor(t *testing.T) {
	f, _, server, owner, created, deal := setupRetrievalExpiryDeal(t)
	ctx := activateSessionFixture(t, f)
	params, err := f.keeper.Params.Get(ctx)
	require.NoError(t, err)
	params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	require.NoError(t, f.keeper.SetParams(ctx, params))
	for nonce := uint64(1); nonce <= types.MaxRetrievalSessionOpensPerBlock; nonce++ {
		_, err = server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: nonce, ExpiresAt: 4, ChallengeVersion: 2})
		require.NoError(t, err)
	}
	anchor, err := f.keeper.ChallengeAnchors.Get(ctx, 3)
	require.NoError(t, err)
	require.Equal(t, types.MaxRetrievalSessionOpensPerBlock, anchor.SessionReferences)
	anchor.AuditReferences = 1
	require.NoError(t, f.keeper.ChallengeAnchors.Set(ctx, 3, anchor))
	_, err = server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 129, ExpiresAt: 4, ChallengeVersion: 2})
	require.ErrorContains(t, err, "capacity exhausted")
	seed := bytes.Repeat([]byte{0x73}, 32)
	require.NoError(t, f.keeper.BeginBlock(ctx.WithBlockHeight(3).WithHeaderHash(seed)))
	require.NoError(t, f.keeper.BeginBlock(ctx.WithBlockHeight(4)))
	require.NoError(t, f.keeper.BeginBlock(ctx.WithBlockHeight(5)))
	live, err := f.keeper.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Zero(t, live)
	generations, err := f.keeper.RetrievalSessionGenerationCount.Get(ctx)
	require.NoError(t, err)
	require.Zero(t, generations)
	anchor, err = f.keeper.ChallengeAnchors.Get(ctx, 3)
	require.NoError(t, err)
	require.Zero(t, anchor.SessionReferences)
	require.Equal(t, uint64(1), anchor.AuditReferences)
	require.Equal(t, seed, anchor.Seed)
	require.NoError(t, f.keeper.RetrievalSessionExpiryRefs.Walk(ctx, nil, func(_ collections.Pair[uint64, []byte], _ bool) (bool, error) {
		t.Fatal("expiry references leaked")
		return true, nil
	}))
	var liabilities uint64
	require.NoError(t, f.keeper.RetrievalSessions.Walk(ctx, nil, func(_ []byte, s types.RetrievalSession) (bool, error) {
		liabilities++
		require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, s.Status)
		return false, nil
	}))
	require.Equal(t, types.MaxRetrievalSessionOpensPerBlock, liabilities, "cleanup preserves terminal/refundable records")
}

func TestRetrievalV2TerminalAdmissionAndMissingPinFailClosed(t *testing.T) {
	for _, state := range []types.RetrievalSessionStatus{types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_UNSPECIFIED} {
		t.Run(state.String(), func(t *testing.T) {
			f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
			ctx := activateSessionFixture(t, f)
			opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
			require.NoError(t, err)
			s, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
			require.NoError(t, err)
			s.Status = state
			require.NoError(t, f.keeper.RetrievalSessions.Set(ctx, s.SessionId, s))
			bounded := ctx.WithBlockHeight(4).WithGasMeter(storetypes.NewGasMeter(499999))
			transfers := len(bank.transfers)
			_, err = server.SubmitRetrievalSessionProof(bounded, &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: s.SessionId, Proofs: []types.ChainedProof{{}}})
			require.Error(t, err)
			_, err = server.ConfirmRetrievalSession(bounded, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: s.SessionId})
			require.Error(t, err)
			after, err := f.keeper.RetrievalSessions.Get(ctx, s.SessionId)
			require.NoError(t, err)
			require.Equal(t, s, after)
			require.Len(t, bank.transfers, transfers)
		})
	}
	for _, pin := range []string{"", "malformed", sdk.AccAddress(bytes.Repeat([]byte{0x91}, 20)).String()} {
		t.Run("pin_"+pin, func(t *testing.T) {
			f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
			ctx := activateSessionFixture(t, f)
			opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
			require.NoError(t, err)
			s, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
			require.NoError(t, err)
			s.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED
			require.NoError(t, f.keeper.RetrievalSessions.Set(ctx, s.SessionId, s))
			if pin != "" {
				require.NoError(t, f.keeper.RetrievalSessionProofProvider.Set(ctx, s.SessionId, pin))
			}
			balance := bank.moduleBalances[types.ModuleName].String()
			transfers := len(bank.transfers)
			_, err = server.ConfirmRetrievalSession(ctx.WithBlockHeight(4), &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: s.SessionId})
			require.Error(t, err)
			after, err := f.keeper.RetrievalSessions.Get(ctx, s.SessionId)
			require.NoError(t, err)
			require.Equal(t, s, after)
			require.Len(t, bank.transfers, transfers)
			require.Equal(t, balance, bank.moduleBalances[types.ModuleName].String())
		})
	}
}

func TestRetrievalV2ExternalFundingCompletionConservesOriginalSource(t *testing.T) {
	for _, funding := range []string{"requester", "protocol"} {
		t.Run(funding, func(t *testing.T) {
			f, bank, server, owner, created, _ := setupRetrievalExpiryDeal(t)
			ctx := activateSessionFixture(t, f)
			_, proof := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
			deal, err := f.keeper.Deals.Get(ctx, created.DealId)
			require.NoError(t, err)
			var id []byte
			var confirmer string
			if funding == "requester" {
				confirmer = sdk.AccAddress(bytes.Repeat([]byte{0xb2}, 20)).String()
				bank.setAccountBalance(sdk.MustAccAddressFromBech32(confirmer), sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)))
				deal.RetrievalPolicy.Mode = types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC
				require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
				opened, err := server.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{Creator: confirmer, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, MaxTotalFee: math.ZeroInt(), ChallengeVersion: 2})
				require.NoError(t, err)
				id = opened.SessionId
			} else {
				confirmer = created.AssignedProviders[1]
				deal.Mode2Slots[0].Status = types.SlotStatus_SLOT_STATUS_REPAIRING
				deal.Mode2Slots[0].PendingProvider = confirmer
				require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
				require.NoError(t, bank.MintCoins(ctx, types.ProtocolBudgetModuleName, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000))))
				opened, err := server.OpenProtocolRetrievalSession(ctx, &types.MsgOpenProtocolRetrievalSession{Creator: confirmer, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, MaxTotalFee: math.ZeroInt(), ChallengeVersion: 2, Purpose: types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR, Auth: &types.MsgOpenProtocolRetrievalSession_Repair{Repair: &types.RepairAuth{Slot: 0}}})
				require.NoError(t, err)
				id = opened.SessionId
			}
			seed := bytes.Repeat([]byte{0xb3}, 32)
			ctx = ctx.WithBlockHeight(3).WithHeaderHash(seed)
			require.NoError(t, f.keeper.BeginBlock(ctx))
			ctx = ctx.WithBlockHeight(4)
			s, err := f.keeper.RetrievalSessions.Get(ctx, id)
			require.NoError(t, err)
			c, err := types.RetrievalChallengeContext(s)
			require.NoError(t, err)
			points, err := c.Challenges(seed)
			require.NoError(t, err)
			proof.ZValue = points[0].Z[:]
			proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(make([]byte, types.BlobSizeBytes), proof.ZValue)
			require.NoError(t, err)
			_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: id, Proofs: []types.ChainedProof{proof}})
			require.NoError(t, err)
			_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: confirmer, SessionId: id})
			require.NoError(t, err)
			source := bank.accountBalances[confirmer].AmountOf(sdk.DefaultBondDenom)
			if funding == "protocol" {
				source = bank.moduleBalances[types.ProtocolBudgetModuleName].AmountOf(sdk.DefaultBondDenom)
			}
			paid := bank.accountBalances[created.AssignedProviders[0]].AmountOf(sdk.DefaultBondDenom)
			require.Equal(t, math.NewInt(995), source)
			require.Equal(t, math.NewInt(2), paid)
			require.Equal(t, math.NewInt(100), bank.moduleBalances[types.ModuleName].AmountOf(sdk.DefaultBondDenom), "unrelated owner escrow remains funded")
			require.Equal(t, math.NewInt(1000), source.Add(paid).Add(math.NewInt(3)), "payer balance + provider payout + base/variable burns conserve external funding")
			done, err := f.keeper.RetrievalSessions.Get(ctx, id)
			require.NoError(t, err)
			require.True(t, done.LockedFee.IsZero())
			_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, id)
			require.ErrorIs(t, err, collections.ErrNotFound)
		})
	}
}
