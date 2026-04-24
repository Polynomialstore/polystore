package keeper_test

import (
	"os"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func commitValidMode2ContentAndProof(
	t *testing.T,
	f *fixture,
	ctx sdk.Context,
	msgServer types.MsgServer,
	owner string,
	dealID uint64,
) (string, types.ChainedProof) {
	t.Helper()

	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping retrieval proof test")
	}
	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))

	mduData := make([]byte, 8*1024*1024)
	dealAfterCreate, err := f.keeper.Deals.Get(ctx, dealID)
	require.NoError(t, err)
	require.NotNil(t, dealAfterCreate.Mode2Profile)
	rsK := uint64(dealAfterCreate.Mode2Profile.K)
	rsM := uint64(dealAfterCreate.Mode2Profile.M)

	witnessFlat, shards, err := crypto_ffi.ExpandMduRs(mduData, rsK, rsM)
	require.NoError(t, err)
	root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
	require.NoError(t, err)
	manifestCid, manifestBlob := mustComputeManifestCid(t, [][]byte{root, make([]byte, 32)})
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, 0)
	require.NoError(t, err)

	const leafIndex = uint64(0)
	root2, commitment, merklePath, z, y, kzgProof := buildMode2LeafProof(t, mduData, rsK, rsM, witnessFlat, shards, leafIndex, 0)
	require.Equal(t, root, root2)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      dealID,
		Cid:         manifestCid,
		Size_:       8 * 1024 * 1024,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	return manifestCid, types.ChainedProof{
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
}
