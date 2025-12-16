package keeper_test

import (
	"os"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
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
	root, err := crypto_ffi.ComputeMduMerkleRoot(mduData)
	require.NoError(t, err)
	manifestCid, manifestBlob := mustComputeManifestCid(t, [][]byte{root})
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, 0)
	require.NoError(t, err)

	chunkIdx := uint32(0)
	commitment, merkleProof, z, y, kzgProof, err := crypto_ffi.ComputeMduProofTest(mduData, chunkIdx)
	require.NoError(t, err)
	merklePath := make([][]byte, 0)
	for i := 0; i < len(merkleProof); i += 32 {
		merklePath = append(merklePath, merkleProof[i:i+32])
	}

	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: owner, DealId: resDeal.DealId, Cid: manifestCid, Size_: 8 * 1024 * 1024,
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
		BlobIndex:       chunkIdx,
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

	session, err := f.keeper.RetrievalSessions.Get(sdk.UnwrapSDKContext(f.ctx), openRes.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, session.Status)

	heat, err := f.keeper.DealHeatStates.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(128*1024), heat.BytesServedTotal)
	require.Equal(t, uint64(1), heat.SuccessfulRetrievalsTotal)
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
		Creator: owner, DealId: resDeal.DealId, Cid: "0x" + hexEncode(manifestRoot), Size_: 8 * 1024 * 1024,
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
