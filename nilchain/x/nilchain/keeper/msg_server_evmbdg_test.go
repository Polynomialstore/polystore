package keeper_test

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"cosmossdk.io/math"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

var eip712DevChainID = big.NewInt(31337)

func makeManifestRootHex(fill byte) string {
	return "0x" + hex.EncodeToString(bytes.Repeat([]byte{fill}, 48))
}

func signCreateIntentEIP712(t *testing.T, intent *types.EvmCreateDealIntent, privKey *ecdsa.PrivateKey) []byte {
	t.Helper()
	structHash, err := types.HashCreateDeal(intent)
	require.NoError(t, err)
	domainSep := types.HashDomainSeparator(eip712DevChainID)
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	sig, err := gethCrypto.Sign(digest, privKey)
	require.NoError(t, err)
	return sig
}

func signUpdateIntentEIP712(t *testing.T, intent *types.EvmUpdateContentIntent, privKey *ecdsa.PrivateKey) []byte {
	t.Helper()
	structHash, err := types.HashUpdateContent(intent)
	require.NoError(t, err)
	domainSep := types.HashDomainSeparator(eip712DevChainID)
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	sig, err := gethCrypto.Sign(digest, privKey)
	require.NoError(t, err)
	return sig
}

func TestCreateDealFromEvm_ValidSignature(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register enough providers for placement.
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_provider______" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	// EVM key and intent.
	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)

	initialEscrow := math.NewInt(1000000)
	maxMonthly := math.NewInt(500000)

	chainID := sdk.UnwrapSDKContext(f.ctx).ChainID()

	intent := &types.EvmCreateDealIntent{
		CreatorEvm:      evmAddr.Hex(),
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   initialEscrow,
		MaxMonthlySpend: maxMonthly,
		Nonce:           1,
		ChainId:         chainID,
	}

	sig := signCreateIntentEIP712(t, intent, privKey)

	// Sender is the fee payer / relayer.
	senderBz := []byte("relayer____________")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	res, err := msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       intent,
		EvmSignature: sig,
	})
	require.NoError(t, err)
	require.NotNil(t, res)
	require.GreaterOrEqual(t, res.DealId, uint64(0))

	// Deal should exist with owner mapped from the EVM address.
	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)

	expectedOwner := sdk.AccAddress(evmAddr.Bytes()).String()
	require.Equal(t, expectedOwner, deal.Owner)
	require.Equal(t, initialEscrow, deal.EscrowBalance)
	require.Nil(t, deal.ManifestRoot)
	require.Equal(t, uint64(0), deal.Size_)

	// Nonce should be stored.
	storedNonce, err := f.keeper.EvmNonces.Get(f.ctx, strings.ToLower(evmAddr.Hex()))
	require.NoError(t, err)
	require.Equal(t, intent.Nonce, storedNonce)
}

func TestUpdateDealContentFromEvm_Valid(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register enough providers for placement.
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_updprov_______" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)

	initialEscrow := math.NewInt(1000000)
	maxMonthly := math.NewInt(500000)
	chainID := sdk.UnwrapSDKContext(f.ctx).ChainID()

	// 1. Create Deal (capacity only)
	createIntent := &types.EvmCreateDealIntent{
		CreatorEvm:      evmAddr.Hex(),
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   initialEscrow,
		MaxMonthlySpend: maxMonthly,
		Nonce:           1,
		ChainId:         chainID,
	}
	createSig := signCreateIntentEIP712(t, createIntent, privKey)

	senderBz := []byte("relayer_create____")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	createRes, err := msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       createIntent,
		EvmSignature: createSig,
	})
	require.NoError(t, err)
	require.NotNil(t, createRes)

	// 2. Update Deal Content
	updateIntent := &types.EvmUpdateContentIntent{
		CreatorEvm: evmAddr.Hex(),
		DealId:     createRes.DealId,
		Cid:        makeManifestRootHex(0xab), // 48-byte hex
		SizeBytes:  1024 * 1024 * 100,                                                     // 100 MB
		Nonce:      2,
		ChainId:    chainID,
	}
	updateSig := signUpdateIntentEIP712(t, updateIntent, privKey)

	updateRes, err := msgServer.UpdateDealContentFromEvm(f.ctx, &types.MsgUpdateDealContentFromEvm{
		Sender:       sender,
		Intent:       updateIntent,
		EvmSignature: updateSig,
	})
	require.NoError(t, err)
	require.True(t, updateRes.Success)

	// 3. Verify Deal State
	deal, err := f.keeper.Deals.Get(f.ctx, createRes.DealId)
	require.NoError(t, err)
	expectedManifestRoot, _ := hex.DecodeString(strings.TrimPrefix(updateIntent.Cid, "0x"))
	require.Equal(t, expectedManifestRoot, deal.ManifestRoot)
	require.Equal(t, updateIntent.SizeBytes, deal.Size_)

	// 4. Verify Nonce
	storedNonce, err := f.keeper.EvmNonces.Get(f.ctx, strings.ToLower(evmAddr.Hex()))
	require.NoError(t, err)
	require.Equal(t, updateIntent.Nonce, storedNonce)
}

func TestUpdateDealContentFromEvm_Unauthorized(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_unauthprov____" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	alicePrivKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	aliceEvmAddr := gethCrypto.PubkeyToAddress(alicePrivKey.PublicKey)

	bobPrivKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	bobEvmAddr := gethCrypto.PubkeyToAddress(bobPrivKey.PublicKey)

	chainID := sdk.UnwrapSDKContext(f.ctx).ChainID()
	senderBz := []byte("relayer_unauth____")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	// 1. Alice creates Deal
	createIntent := &types.EvmCreateDealIntent{
		CreatorEvm:      aliceEvmAddr.Hex(),
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         chainID,
	}
	createSig := signCreateIntentEIP712(t, createIntent, alicePrivKey)

	createRes, err := msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       createIntent,
		EvmSignature: createSig,
	})
	require.NoError(t, err)

	// 2. Bob tries to update Alice's deal
	updateIntent := &types.EvmUpdateContentIntent{
		CreatorEvm: bobEvmAddr.Hex(),
		DealId:     createRes.DealId,
		Cid:        makeManifestRootHex(0xbb),
		SizeBytes:  100,
		Nonce:      1,
		ChainId:    chainID,
	}
	updateSig := signUpdateIntentEIP712(t, updateIntent, bobPrivKey)

	_, err = msgServer.UpdateDealContentFromEvm(f.ctx, &types.MsgUpdateDealContentFromEvm{
		Sender:       sender,
		Intent:       updateIntent,
		EvmSignature: updateSig,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unauthorized")
}

func TestUpdateDealContentFromEvm_AllowsLargeContent(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_caprov________" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)

	chainID := sdk.UnwrapSDKContext(f.ctx).ChainID()
	senderBz := []byte("relayer_cap_______")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	// 1. Create a Deal (thin-provisioned container).
	createIntent := &types.EvmCreateDealIntent{
		CreatorEvm:      evmAddr.Hex(),
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         chainID,
	}
	createSig := signCreateIntentEIP712(t, createIntent, privKey)

	createRes, err := msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       createIntent,
		EvmSignature: createSig,
	})
	require.NoError(t, err)

	// 2. Commit 5 GiB content; dynamic sizing should allow this.
	updateIntent := &types.EvmUpdateContentIntent{
		CreatorEvm: evmAddr.Hex(),
		DealId:     createRes.DealId,
		Cid:        makeManifestRootHex(0xcc),
		SizeBytes:  5 * 1024 * 1024 * 1024, // 5 GiB
		Nonce:      2,
		ChainId:    chainID,
	}
	updateSig := signUpdateIntentEIP712(t, updateIntent, privKey)

	updateRes, err := msgServer.UpdateDealContentFromEvm(f.ctx, &types.MsgUpdateDealContentFromEvm{
		Sender:       sender,
		Intent:       updateIntent,
		EvmSignature: updateSig,
	})
	require.NoError(t, err)
	require.True(t, updateRes.Success)

	deal, err := f.keeper.Deals.Get(f.ctx, createRes.DealId)
	require.NoError(t, err)
	require.Equal(t, updateIntent.SizeBytes, deal.Size_)
}

func TestCreateDealFromEvm_InvalidSignature(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register a minimal provider set.
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_badprov_______" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)

	intent := &types.EvmCreateDealIntent{
		CreatorEvm:      evmAddr.Hex(),
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         sdk.UnwrapSDKContext(f.ctx).ChainID(),
	}

	sig := signCreateIntentEIP712(t, intent, privKey)

	// Corrupt the signature.
	sig[0] ^= 0xFF

	senderBz := []byte("relayer_bad________")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	_, err = msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       intent,
		EvmSignature: sig,
	})
	require.Error(t, err)
}

func TestCreateDealFromEvm_ReplayNonce(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Providers for placement.
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_replayprov____" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)

	chainID := sdk.UnwrapSDKContext(f.ctx).ChainID()

	makeMsg := func(nonce uint64) *types.MsgCreateDealFromEvm {
		intent := &types.EvmCreateDealIntent{
			CreatorEvm:      evmAddr.Hex(),
			DurationBlocks:  100,
			ServiceHint:     "General",
			InitialEscrow:   math.NewInt(1000000),
			MaxMonthlySpend: math.NewInt(500000),
			Nonce:           nonce,
			ChainId:         chainID,
		}
		sig := signCreateIntentEIP712(t, intent, privKey)

		senderBz := []byte("relayer_replay____")
		sender, _ := f.addressCodec.BytesToString(senderBz)

		return &types.MsgCreateDealFromEvm{
			Sender:       sender,
			Intent:       intent,
			EvmSignature: sig,
		}
	}

	firstMsg := makeMsg(1)
	_, err = msgServer.CreateDealFromEvm(f.ctx, firstMsg)
	require.NoError(t, err)

	// Reuse the same nonce; should be rejected.
	secondMsg := makeMsg(1)
	_, err = msgServer.CreateDealFromEvm(f.ctx, secondMsg)
	require.Error(t, err)
}

func TestCreateDealFromEvm_WrongChainID(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte("evm_chainprov_____" + string(rune('A'+i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	privKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	evmAddr := gethCrypto.PubkeyToAddress(privKey.PublicKey)

	intent := &types.EvmCreateDealIntent{
		CreatorEvm:      evmAddr.Hex(),
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         "wrong-chain",
	}

	sig := signCreateIntentEIP712(t, intent, privKey)

	senderBz := []byte("relayer_chain_____")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	_, err = msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       intent,
		EvmSignature: sig,
	})
	require.Error(t, err)
}
