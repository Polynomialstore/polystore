package keeper_test

import (
	"crypto/ecdsa"
	"math/big"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCommon "github.com/ethereum/go-ethereum/common"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func signVoucher(t *testing.T, voucher *types.VoucherAuth, chainID uint64, privKey *ecdsa.PrivateKey) []byte {
	t.Helper()
	structHash, err := types.HashRetrievalVoucher(voucher)
	require.NoError(t, err)
	domainSep := types.HashDomainSeparator(new(big.Int).SetUint64(chainID))
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	sig, err := gethCrypto.Sign(digest, privKey)
	require.NoError(t, err)
	return sig
}

func keccakMerkleProofDuplicateLast(leaves []gethCommon.Hash, leafIndex uint32) (gethCommon.Hash, [][]byte) {
	if len(leaves) == 0 {
		return gethCommon.Hash{}, nil
	}

	layer := make([]gethCommon.Hash, len(leaves))
	copy(layer, leaves)
	idx := int(leafIndex)
	path := make([][]byte, 0)

	for len(layer) > 1 {
		sibIdx := idx ^ 1
		sibling := layer[idx]
		if sibIdx < len(layer) {
			sibling = layer[sibIdx]
		}
		path = append(path, sibling.Bytes())

		next := make([]gethCommon.Hash, 0, (len(layer)+1)/2)
		for i := 0; i < len(layer); i += 2 {
			left := layer[i]
			right := layer[i]
			if i+1 < len(layer) {
				right = layer[i+1]
			}
			next = append(next, gethCrypto.Keccak256Hash(left.Bytes(), right.Bytes()))
		}
		layer = next
		idx /= 2
	}

	return layer[0], path
}

func TestSponsoredOpen_Public_DoesNotTouchDealEscrow(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	p := types.DefaultParams()
	p.StoragePrice = math.LegacyNewDec(0)
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	require.NoError(t, f.keeper.Params.Set(ctx, p))

	// Register minimal providers for Mode 2 (rs=2+1).
	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte("provider_public_v1_"))
		providerBz[19] = byte('0' + i)
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_public_v1____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2,
		WitnessMdus: 0,
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealRetrievalPolicy(ctx, &types.MsgUpdateDealRetrievalPolicy{
		Creator: owner,
		DealId:  resDeal.DealId,
		Policy: types.RetrievalPolicy{
			Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC,
		},
	})
	require.NoError(t, err)

	before, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(0), before.EscrowBalance)

	sponsorBz := make([]byte, 20)
	copy(sponsorBz, []byte("sponsor_public_v1__"))
	sponsor, _ := f.addressCodec.BytesToString(sponsorBz)
	sponsorAddr, err := sdk.AccAddressFromBech32(sponsor)
	require.NoError(t, err)
	bank.setAccountBalance(sponsorAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	_, err = msgServer.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
		Creator:        sponsor,
		DealId:         resDeal.DealId,
		Provider:       resDeal.AssignedProviders[0],
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
		MaxTotalFee:    math.NewInt(0),
	})
	require.NoError(t, err)

	after, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, before.EscrowBalance, after.EscrowBalance)
}

func TestSponsoredOpen_Public_RefundsLockedFeeToPayerOnCancel(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx5 := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	p := types.DefaultParams()
	p.StoragePrice = math.LegacyNewDec(0)
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	require.NoError(t, f.keeper.Params.Set(ctx5, p))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte("provider_refund_v1"))
		providerBz[19] = byte('0' + i)
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx5, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_refund_v1___"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx5, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx5, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2,
		WitnessMdus: 0,
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealRetrievalPolicy(ctx5, &types.MsgUpdateDealRetrievalPolicy{
		Creator: owner,
		DealId:  resDeal.DealId,
		Policy: types.RetrievalPolicy{
			Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC,
		},
	})
	require.NoError(t, err)

	sponsorBz := make([]byte, 20)
	copy(sponsorBz, []byte("sponsor_refund_v1"))
	sponsor, _ := f.addressCodec.BytesToString(sponsorBz)
	sponsorAddr, err := sdk.AccAddressFromBech32(sponsor)
	require.NoError(t, err)
	bank.setAccountBalance(sponsorAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	resOpen, err := msgServer.OpenRetrievalSessionSponsored(ctx5, &types.MsgOpenRetrievalSessionSponsored{
		Creator:        sponsor,
		DealId:         resDeal.DealId,
		Provider:       resDeal.AssignedProviders[0],
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          123,
		ExpiresAt:      5,
		MaxTotalFee:    math.NewInt(0),
	})
	require.NoError(t, err)

	// Sponsor pays base+variable: 1 + (2*1) = 3.
	require.Equal(t, "97stake", bank.accountBalances[sponsorAddr.String()].String())

	// Cancel at height=6 (expiry condition is height > expires_at).
	ctx6 := ctx5.WithBlockHeight(6)
	_, err = msgServer.CancelRetrievalSession(ctx6, &types.MsgCancelRetrievalSession{
		Creator:   sponsor,
		SessionId: resOpen.SessionId,
	})
	require.NoError(t, err)

	// Sponsor receives locked fee refund (variable fee = 2); net cost is base fee burned (1).
	require.Equal(t, "99stake", bank.accountBalances[sponsorAddr.String()].String())
}

func TestSponsoredOpen_Voucher_ReplayRejected(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	p := types.DefaultParams()
	p.StoragePrice = math.LegacyNewDec(0)
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.VoucherMaxTtlBlocks = 1000
	require.NoError(t, f.keeper.Params.Set(ctx, p))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte("provider_voucher_v1"))
		providerBz[19] = byte('0' + i)
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerPriv, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	ownerEvm := gethCrypto.PubkeyToAddress(ownerPriv.PublicKey)
	owner := sdk.AccAddress(ownerEvm.Bytes()).String()

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2,
		WitnessMdus: 0,
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealRetrievalPolicy(ctx, &types.MsgUpdateDealRetrievalPolicy{
		Creator: owner,
		DealId:  resDeal.DealId,
		Policy: types.RetrievalPolicy{
			Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER,
		},
	})
	require.NoError(t, err)

	redeemerBz := make([]byte, 20)
	copy(redeemerBz, []byte("redeemer_voucher_v"))
	redeemer, _ := f.addressCodec.BytesToString(redeemerBz)
	redeemerAddr, err := sdk.AccAddressFromBech32(redeemer)
	require.NoError(t, err)
	bank.setAccountBalance(redeemerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	voucher := &types.VoucherAuth{
		DealId:         resDeal.DealId,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		Provider:       "", // any assigned provider
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		ExpiresAt:      20,
		Nonce:          777,
		Redeemer:       redeemer,
	}
	voucher.Signature = signVoucher(t, voucher, p.Eip712ChainId, ownerPriv)

	open := func(sessionNonce uint64) error {
		_, err := msgServer.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
			Creator:        redeemer,
			DealId:         resDeal.DealId,
			Provider:       resDeal.AssignedProviders[0],
			ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
			StartMduIndex:  1,
			StartBlobIndex: 0,
			BlobCount:      1,
			Nonce:          sessionNonce,
			ExpiresAt:      20,
			MaxTotalFee:    math.NewInt(0),
			Auth: &types.MsgOpenRetrievalSessionSponsored_Voucher{
				Voucher: voucher,
			},
		})
		return err
	}

	require.NoError(t, open(1))
	require.Error(t, open(2))
	require.Contains(t, open(2).Error(), "voucher nonce replay rejected")
}

func TestSponsoredOpen_Allowlist_ProofVerification(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	p := types.DefaultParams()
	p.StoragePrice = math.LegacyNewDec(0)
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	require.NoError(t, f.keeper.Params.Set(ctx, p))

	// Register minimal providers for Mode 2 (rs=2+1).
	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte("provider_allow_v1___"))
		providerBz[19] = byte('0' + i)
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_allow_v1_____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2,
		WitnessMdus: 0,
	})
	require.NoError(t, err)

	sponsorBz := make([]byte, 20)
	copy(sponsorBz, []byte("sponsor_allow_v1__"))
	sponsor, _ := f.addressCodec.BytesToString(sponsorBz)
	sponsorAddr, err := sdk.AccAddressFromBech32(sponsor)
	require.NoError(t, err)
	bank.setAccountBalance(sponsorAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	otherA := make([]byte, 20)
	copy(otherA, []byte("allow_a_v1________"))
	otherAAddr, _ := f.addressCodec.BytesToString(otherA)
	otherB := make([]byte, 20)
	copy(otherB, []byte("allow_b_v1________"))
	otherBAddr, _ := f.addressCodec.BytesToString(otherB)
	otherC := make([]byte, 20)
	copy(otherC, []byte("allow_c_v1________"))
	otherCAddr, _ := f.addressCodec.BytesToString(otherC)

	allowAddrs := []string{otherAAddr, sponsor, otherBAddr, otherCAddr}
	leaves := make([]gethCommon.Hash, 0, len(allowAddrs))
	for _, a := range allowAddrs {
		addr, err := sdk.AccAddressFromBech32(a)
		require.NoError(t, err)
		leaves = append(leaves, gethCrypto.Keccak256Hash(addr.Bytes()))
	}
	root, merklePath := keccakMerkleProofDuplicateLast(leaves, 1)

	_, err = msgServer.UpdateDealRetrievalPolicy(ctx, &types.MsgUpdateDealRetrievalPolicy{
		Creator: owner,
		DealId:  resDeal.DealId,
		Policy: types.RetrievalPolicy{
			Mode:          types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST,
			AllowlistRoot: root.Bytes(),
		},
	})
	require.NoError(t, err)

	baseMsg := &types.MsgOpenRetrievalSessionSponsored{
		Creator:        sponsor,
		DealId:         resDeal.DealId,
		Provider:       resDeal.AssignedProviders[0],
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      20,
		MaxTotalFee:    math.NewInt(0),
	}

	t.Run("missing proof rejected", func(t *testing.T) {
		_, err := msgServer.OpenRetrievalSessionSponsored(ctx, baseMsg)
		require.Error(t, err)
		require.Contains(t, err.Error(), "allowlist proof is required")
	})

	t.Run("invalid proof rejected", func(t *testing.T) {
		badPath := make([][]byte, len(merklePath))
		for i := range merklePath {
			badPath[i] = append([]byte(nil), merklePath[i]...)
		}
		badPath[0][0] ^= 0x01

		_, err := msgServer.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
			Auth: &types.MsgOpenRetrievalSessionSponsored_AllowlistProof{
				AllowlistProof: &types.AllowlistProof{
					LeafIndex:  1,
					MerklePath: badPath,
				},
			},
			Creator:        baseMsg.Creator,
			DealId:         baseMsg.DealId,
			Provider:       baseMsg.Provider,
			ManifestRoot:   baseMsg.ManifestRoot,
			StartMduIndex:  baseMsg.StartMduIndex,
			StartBlobIndex: baseMsg.StartBlobIndex,
			BlobCount:      baseMsg.BlobCount,
			Nonce:          2,
			ExpiresAt:      baseMsg.ExpiresAt,
			MaxTotalFee:    baseMsg.MaxTotalFee,
		})
		require.Error(t, err)
		require.Contains(t, err.Error(), "invalid allowlist proof")
	})

	t.Run("valid proof accepted", func(t *testing.T) {
		_, err := msgServer.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
			Auth: &types.MsgOpenRetrievalSessionSponsored_AllowlistProof{
				AllowlistProof: &types.AllowlistProof{
					LeafIndex:  1,
					MerklePath: merklePath,
				},
			},
			Creator:        baseMsg.Creator,
			DealId:         baseMsg.DealId,
			Provider:       baseMsg.Provider,
			ManifestRoot:   baseMsg.ManifestRoot,
			StartMduIndex:  baseMsg.StartMduIndex,
			StartBlobIndex: baseMsg.StartBlobIndex,
			BlobCount:      baseMsg.BlobCount,
			Nonce:          3,
			ExpiresAt:      baseMsg.ExpiresAt,
			MaxTotalFee:    baseMsg.MaxTotalFee,
		})
		require.NoError(t, err)
	})
}
