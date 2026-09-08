package keeper_test

import (
	"bytes"
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// The activation fixture is deliberately isolated from deployment qualification:
// production activation also requires the C4 audit and #256/#257/#260 gates.
func activateSessionFixture(t *testing.T, f *fixture) sdk.Context {
	t.Helper()
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1).WithChainID("retrieval-v2-test")
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
	_, proof := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
	deal, err := f.keeper.Deals.Get(ctx, created.DealId)
	require.NoError(t, err)
	opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{
		Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot,
		StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20, ChallengeVersion: 2,
	})
	require.NoError(t, err)
	header := ctx.BlockHeader()
	header.Height = 4
	header.LastBlockId.Hash = bytes.Repeat([]byte{0x37}, 32)
	ctx = ctx.WithBlockHeader(header)
	require.NoError(t, f.keeper.BeginBlock(ctx))
	session, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
	require.NoError(t, err)
	challenge, err := types.RetrievalChallengeContext(session)
	require.NoError(t, err)
	expected, err := challenge.Challenges(header.LastBlockId.Hash)
	require.NoError(t, err)
	proof.ZValue = expected[0].Z[:]
	proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(make([]byte, types.BlobSizeBytes), proof.ZValue)
	require.NoError(t, err)
	_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{
		Creator: created.AssignedProviders[1], SessionId: opened.SessionId, Proofs: []types.ChainedProof{proof},
	})
	require.ErrorContains(t, err, "authorized proof provider")
	_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, opened.SessionId)
	require.ErrorIs(t, err, collections.ErrNotFound)
}
