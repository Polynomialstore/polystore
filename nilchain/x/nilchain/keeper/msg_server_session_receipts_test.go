package keeper_test

import (
	"crypto/ecdsa"
	"encoding/hex"
	"math/big"
	"os"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func signRetrievalReceiptV3(t *testing.T, receipt *types.RetrievalReceipt, chainID uint64, privKey *ecdsa.PrivateKey) []byte {
	t.Helper()
	structHash, err := types.HashRetrievalReceiptV3(receipt)
	require.NoError(t, err)
	domainSep := types.HashDomainSeparator(new(big.Int).SetUint64(chainID))
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	sig, err := gethCrypto.Sign(digest, privKey)
	require.NoError(t, err)
	return sig
}

func signDownloadSessionReceipt(t *testing.T, receipt *types.DownloadSessionReceipt, chainID uint64, privKey *ecdsa.PrivateKey) []byte {
	t.Helper()
	structHash, err := types.HashDownloadSessionReceipt(receipt)
	require.NoError(t, err)
	domainSep := types.HashDomainSeparator(new(big.Int).SetUint64(chainID))
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	sig, err := gethCrypto.Sign(digest, privKey)
	require.NoError(t, err)
	return sig
}

func TestProveLiveness_UserReceiptBatch_NonceIsScopedToDealAndFilePath(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping receipt batch test")
	}

	// Register enough providers for placement.
	for i := 0; i < 20; i++ {
		addrBz := []byte("batch_provider_____" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	// Create a deal whose owner is the EVM address derived from privKey.
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

	// Commit Content (valid ManifestRoot) so chained proof verification can succeed.
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

	assignedProvider := resDeal.AssignedProviders[0]
	proofDetails := types.ChainedProof{
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

	receiptA := types.RetrievalReceipt{
		DealId:       resDeal.DealId,
		EpochId:      1,
		Provider:     assignedProvider,
		FilePath:     "a.txt",
		RangeStart:   0,
		RangeLen:     1024,
		BytesServed:  1024,
		ProofDetails: proofDetails,
		Nonce:        1,
		ExpiresAt:    0,
	}
	receiptA.UserSignature = signRetrievalReceiptV3(t, &receiptA, 31337, privKey)

	receiptB := types.RetrievalReceipt{
		DealId:       resDeal.DealId,
		EpochId:      1,
		Provider:     assignedProvider,
		FilePath:     "b.txt",
		RangeStart:   0,
		RangeLen:     1024,
		BytesServed:  1024,
		ProofDetails: proofDetails,
		Nonce:        1,
		ExpiresAt:    0,
	}
	receiptB.UserSignature = signRetrievalReceiptV3(t, &receiptB, 31337, privKey)

	_, err = msgServer.ProveLiveness(f.ctx, &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_UserReceiptBatch{
			UserReceiptBatch: &types.RetrievalReceiptBatch{
				Receipts: []types.RetrievalReceipt{receiptA, receiptB},
			},
		},
	})
	require.NoError(t, err)

	nonceA, err := f.keeper.ReceiptNoncesByDealFile.Get(f.ctx, collections.Join(resDeal.DealId, "a.txt"))
	require.NoError(t, err)
	require.Equal(t, uint64(1), nonceA)

	nonceB, err := f.keeper.ReceiptNoncesByDealFile.Get(f.ctx, collections.Join(resDeal.DealId, "b.txt"))
	require.NoError(t, err)
	require.Equal(t, uint64(1), nonceB)

	heat, err := f.keeper.DealHeatStates.Get(f.ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(2), heat.SuccessfulRetrievalsTotal)
	require.Equal(t, uint64(2048), heat.BytesServedTotal)
}

func TestProveLiveness_SessionProof_Valid_UsesParamChainID(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping session proof test")
	}

	// Override the module param so this test fails if the chain is hardcoded to 31337.
	p := types.DefaultParams()
	p.Eip712ChainId = 31338
	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	// Register enough providers for placement.
	for i := 0; i < 20; i++ {
		addrBz := []byte("sess_provider______" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	// Create a deal whose owner is the EVM address derived from privKey.
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

	// Commit Content (valid ManifestRoot) so chained proof verification can succeed.
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

	assignedProvider := resDeal.AssignedProviders[0]
	proofDetails := types.ChainedProof{
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
	proofHash, err := types.HashChainedProof(&proofDetails)
	require.NoError(t, err)

	leaf0 := types.HashSessionLeaf(0, 1024, proofHash)
	leaf1 := types.HashSessionLeaf(1024, 1024, proofHash)
	rootHash := gethCrypto.Keccak256Hash(leaf0.Bytes(), leaf1.Bytes())

	sessionReceipt := types.DownloadSessionReceipt{
		DealId:        resDeal.DealId,
		EpochId:       1,
		Provider:      assignedProvider,
		FilePath:      "file.txt",
		TotalBytes:    2048,
		ChunkCount:    2,
		ChunkLeafRoot: mustDecodeHexBytes(t, "0x"+hex.EncodeToString(rootHash.Bytes())),
		Nonce:         1,
		ExpiresAt:     0,
		UserSignature: nil,
	}
	sessionReceipt.UserSignature = signDownloadSessionReceipt(t, &sessionReceipt, 31338, privKey)

	sessionProof := &types.RetrievalSessionProof{
		SessionReceipt: sessionReceipt,
		Chunks: []types.SessionChunkProof{
			{
				RangeStart:   0,
				RangeLen:     1024,
				ProofDetails: proofDetails,
				LeafIndex:    0,
				MerklePath:   [][]byte{leaf1.Bytes()},
			},
			{
				RangeStart:   1024,
				RangeLen:     1024,
				ProofDetails: proofDetails,
				LeafIndex:    1,
				MerklePath:   [][]byte{leaf0.Bytes()},
			},
		},
	}

	_, err = msgServer.ProveLiveness(f.ctx, &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SessionProof{
			SessionProof: sessionProof,
		},
	})
	require.NoError(t, err)

	nonce, err := f.keeper.ReceiptNoncesByDealFile.Get(f.ctx, collections.Join(resDeal.DealId, "file.txt"))
	require.NoError(t, err)
	require.Equal(t, uint64(1), nonce)

	heat, err := f.keeper.DealHeatStates.Get(f.ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(2), heat.SuccessfulRetrievalsTotal)
	require.Equal(t, uint64(2048), heat.BytesServedTotal)
}
