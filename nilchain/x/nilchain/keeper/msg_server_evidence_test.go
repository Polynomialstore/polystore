package keeper_test

import (
	"strings"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestCancelRetrievalSession_RecordsNonResponseEvidence(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register enough providers for placement (bootstrap mode caps replication).
	for i := 0; i < 5; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte("evidence_provider__"))
		addrBz[18] = byte('A' + i)
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("evidence_owner_____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(1000000),
		MaxMonthlySpend:     math.NewInt(1000000),
	})
	require.NoError(t, err)
	require.NotEmpty(t, resDeal.AssignedProviders)
	assignedProvider := resDeal.AssignedProviders[0]

	manifestRoot := make([]byte, 48)
	for i := range manifestRoot {
		manifestRoot[i] = byte(i + 1)
	}
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: owner,
		DealId:  resDeal.DealId,
		Cid:     "0x" + hexEncode(manifestRoot),
		Size_:   8 * 1024 * 1024,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)
	require.Len(t, deal.ManifestRoot, 48)

	openRes, err := msgServer.OpenRetrievalSession(f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        owner,
		DealId:         resDeal.DealId,
		Provider:       assignedProvider,
		ManifestRoot:   deal.ManifestRoot,
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      5,
	})
	require.NoError(t, err)
	require.Len(t, openRes.SessionId, 32)

	ctxExpired := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)

	_, err = msgServer.CancelRetrievalSession(ctxExpired, &types.MsgCancelRetrievalSession{
		Creator:   owner,
		SessionId: openRes.SessionId,
	})
	require.NoError(t, err)

	session, err := f.keeper.RetrievalSessions.Get(ctxExpired, openRes.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED, session.Status)

	heat, err := f.keeper.DealHeatStates.Get(ctxExpired, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(1), heat.FailedChallengesTotal)

	failures, err := f.keeper.DealProviderFailures.Get(ctxExpired, collections.Join(resDeal.DealId, assignedProvider))
	require.NoError(t, err)
	require.Equal(t, uint64(1), failures)

	var (
		foundEvidence bool
		proofCount    int
	)
	err = f.keeper.Proofs.Walk(ctxExpired, nil, func(_ uint64, proof types.Proof) (bool, error) {
		proofCount++
		if strings.Contains(proof.Commitment, "evidence:retrieval_non_response") {
			foundEvidence = true
			require.False(t, proof.Valid)
			require.Equal(t, assignedProvider, proof.Creator)
		}
		return false, nil
	})
	require.NoError(t, err)
	require.True(t, foundEvidence)
	require.Equal(t, 1, proofCount)

	// Idempotent: cancel again should not record a second evidence entry.
	_, err = msgServer.CancelRetrievalSession(ctxExpired, &types.MsgCancelRetrievalSession{
		Creator:   owner,
		SessionId: openRes.SessionId,
	})
	require.NoError(t, err)

	proofCount = 0
	err = f.keeper.Proofs.Walk(ctxExpired, nil, func(_ uint64, _ types.Proof) (bool, error) {
		proofCount++
		return false, nil
	})
	require.NoError(t, err)
	require.Equal(t, 1, proofCount)
}
