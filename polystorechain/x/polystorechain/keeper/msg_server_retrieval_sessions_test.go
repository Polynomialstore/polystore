package keeper_test

import (
	"os"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalSession_Lifecycle_ConfirmThenProof(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping retrieval session test")
	}

	// Register enough providers for placement.
	for i := 0; i < 10; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte("session_provider_"))
		addrBz[16] = byte('A' + i)
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)
	owner := sdk.AccAddress(evmAddr.Bytes()).String()

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(100000000),
		MaxMonthlySpend:     math.NewInt(10000000),
	})
	require.NoError(t, err)
	require.NotEmpty(t, resDeal.AssignedProviders)
	assignedProvider := resDeal.AssignedProviders[0]

	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))
	mduData := make([]byte, 8*1024*1024)
	// Build a Mode 2 proof for leafIndex=0 within the committed manifest.
	dealAfterCreate, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)
	require.NotNil(t, dealAfterCreate.Mode2Profile)
	k := uint64(dealAfterCreate.Mode2Profile.K)
	m := uint64(dealAfterCreate.Mode2Profile.M)

	witnessFlat, shards, err := crypto_ffi.ExpandMduRs(mduData, k, m)
	require.NoError(t, err)
	root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
	require.NoError(t, err)

	// Commit a minimal (but valid) manifest: include root at index 0 so proofs can target mdu_index=0.
	manifestCid, manifestBlob := mustComputeManifestCid(t, [][]byte{root, make([]byte, 32)})
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, 0)
	require.NoError(t, err)

	const leafIndex = uint64(0)
	root2, commitment, merklePath, z, y, kzgProof := buildMode2LeafProof(t, mduData, k, m, witnessFlat, shards, leafIndex, 0)
	require.Equal(t, root, root2)

	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         manifestCid,
		Size_:       8 * 1024 * 1024,
		TotalMdus:   3,
		WitnessMdus: 1,
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
		ExpiresAt:      0,
	})
	require.NoError(t, err)
	require.Len(t, openRes.SessionId, 32)

	_, err = msgServer.ConfirmRetrievalSession(f.ctx, &types.MsgConfirmRetrievalSession{
		Creator:   owner,
		SessionId: openRes.SessionId,
	})
	require.NoError(t, err)

	proof := types.ChainedProof{
		MduIndex:        0,
		MduRootFr:       root,
		ManifestOpening: manifestProof,
		BlobCommitment:  commitment,
		MerklePath:      merklePath,
		BlobIndex:       uint32(leafIndex),
		ZValue:          z,
		YValue:          y,
		KzgOpeningProof: kzgProof,
	}

	_, err = msgServer.SubmitRetrievalSessionProof(f.ctx, &types.MsgSubmitRetrievalSessionProof{
		Creator:   assignedProvider,
		SessionId: openRes.SessionId,
		Proofs:    []types.ChainedProof{proof},
	})
	require.NoError(t, err)

	// Retrieval proofs count as Mode2 liveness credits for the serving slot.
	rows := uint64(64) / k
	slot := uint32(uint64(proof.BlobIndex) / rows)
	creditsKey := collections.Join(collections.Join(resDeal.DealId, slot), uint64(1))
	credits, err := f.keeper.Mode2EpochCredits.Get(sdk.UnwrapSDKContext(f.ctx), creditsKey)
	require.NoError(t, err)
	require.Equal(t, uint64(1), credits)

	session, err := f.keeper.RetrievalSessions.Get(sdk.UnwrapSDKContext(f.ctx), openRes.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, session.Status)

	activity, err := f.keeper.DealActivityStates.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(128*1024), activity.BytesServedTotal)
	require.Equal(t, uint64(1), activity.SuccessfulRetrievalsTotal)
}

func TestRetrievalSession_OpenRejectsNonceReplay(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register enough providers for placement.
	for i := 0; i < 5; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte("nonce_provider_____"))
		addrBz[15] = byte('A' + i)
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)
	owner := sdk.AccAddress(evmAddr.Bytes()).String()

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(100000000),
		MaxMonthlySpend:     math.NewInt(10000000),
	})
	require.NoError(t, err)
	assignedProvider := resDeal.AssignedProviders[0]

	// Commit any 48-byte manifest_root (no need for KZG verification in this test).
	manifestRoot := make([]byte, 48)
	for i := range manifestRoot {
		manifestRoot[i] = byte(i + 1)
	}
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         "0x" + hexEncode(manifestRoot),
		Size_:       8 * 1024 * 1024,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)
	deal, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)

	_, err = msgServer.OpenRetrievalSession(f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        owner,
		DealId:         resDeal.DealId,
		Provider:       assignedProvider,
		ManifestRoot:   deal.ManifestRoot,
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
	})
	require.NoError(t, err)

	_, err = msgServer.OpenRetrievalSession(f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        owner,
		DealId:         resDeal.DealId,
		Provider:       assignedProvider,
		ManifestRoot:   deal.ManifestRoot,
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
	})
	require.Error(t, err)
}

func hexEncode(bz []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(bz)*2)
	for i, b := range bz {
		out[i*2] = hexdigits[b>>4]
		out[i*2+1] = hexdigits[b&0x0f]
	}
	return string(out)
}
