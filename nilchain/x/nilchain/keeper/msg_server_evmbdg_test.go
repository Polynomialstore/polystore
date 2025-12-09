package keeper_test

import (
	"encoding/hex"
	"strings"
	"testing"

	"cosmossdk.io/math"
	"github.com/ethereum/go-ethereum/accounts"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

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
		SizeTier:        1, // DEAL_SIZE_4GIB
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   initialEscrow,
		MaxMonthlySpend: maxMonthly,
		Nonce:           1,
		ChainId:         chainID,
	}

	msgText, err := types.BuildEvmCreateDealMessage(intent)
	require.NoError(t, err)

	hash := accounts.TextHash([]byte(msgText))
	sig, err := gethCrypto.Sign(hash, privKey)
	require.NoError(t, err)

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
		SizeTier:        1, // 4 GiB
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   initialEscrow,
		MaxMonthlySpend: maxMonthly,
		Nonce:           1,
		ChainId:         chainID,
	}
	createMsgText, err := types.BuildEvmCreateDealMessage(createIntent)
	require.NoError(t, err)
	createHash := accounts.TextHash([]byte(createMsgText))
	createSig, err := gethCrypto.Sign(createHash, privKey)
	require.NoError(t, err)

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
		Cid:        "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // 48-byte hex
		SizeBytes:  1024 * 1024 * 100,                                                     // 100 MB
		Nonce:      2,
		ChainId:    chainID,
	}
	updateMsgText, err := types.BuildEvmUpdateContentMessage(updateIntent)
	require.NoError(t, err)
	updateHash := accounts.TextHash([]byte(updateMsgText))
	updateSig, err := gethCrypto.Sign(updateHash, privKey)
	require.NoError(t, err)

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
		SizeTier:        1, // 4 GiB
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         chainID,
	}
	createMsgText, err := types.BuildEvmCreateDealMessage(createIntent)
	require.NoError(t, err)
	createHash := accounts.TextHash([]byte(createMsgText))
	createSig, err := gethCrypto.Sign(createHash, alicePrivKey)
	require.NoError(t, err)

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
		Cid:        "0xbbbbbb0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		SizeBytes:  100,
		Nonce:      1,
		ChainId:    chainID,
	}
	updateMsgText, err := types.BuildEvmUpdateContentMessage(updateIntent)
	require.NoError(t, err)
	updateHash := accounts.TextHash([]byte(updateMsgText))
	updateSig, err := gethCrypto.Sign(updateHash, bobPrivKey)
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContentFromEvm(f.ctx, &types.MsgUpdateDealContentFromEvm{
		Sender:       sender,
		Intent:       updateIntent,
		EvmSignature: updateSig,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unauthorized")
}

func TestUpdateDealContentFromEvm_CapacityExceeded(t *testing.T) {
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

	// 1. Create a 4 GiB Deal
	createIntent := &types.EvmCreateDealIntent{
		CreatorEvm:      evmAddr.Hex(),
		SizeTier:        1, // 4 GiB
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         chainID,
	}
	createMsgText, err := types.BuildEvmCreateDealMessage(createIntent)
	require.NoError(t, err)
	createHash := accounts.TextHash([]byte(createMsgText))
	createSig, err := gethCrypto.Sign(createHash, privKey)
	require.NoError(t, err)

	createRes, err := msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       createIntent,
		EvmSignature: createSig,
	})
	require.NoError(t, err)

	// 2. Try to commit 5 GiB content
	updateIntent := &types.EvmUpdateContentIntent{
		CreatorEvm: evmAddr.Hex(),
		DealId:     createRes.DealId,
		Cid:        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		SizeBytes:  5 * 1024 * 1024 * 1024, // 5 GiB
		Nonce:      2,
		ChainId:    chainID,
	}
	updateMsgText, err := types.BuildEvmUpdateContentMessage(updateIntent)
	require.NoError(t, err)
	updateHash := accounts.TextHash([]byte(updateMsgText))
	updateSig, err := gethCrypto.Sign(updateHash, privKey)
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContentFromEvm(f.ctx, &types.MsgUpdateDealContentFromEvm{
		Sender:       sender,
		Intent:       updateIntent,
		EvmSignature: updateSig,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "exceeds tier capacity")
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
		SizeTier:        1, // DEAL_SIZE_4GIB
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         sdk.UnwrapSDKContext(f.ctx).ChainID(),
	}

	msgText, err := types.BuildEvmCreateDealMessage(intent)
	require.NoError(t, err)

	hash := accounts.TextHash([]byte(msgText))
	sig, err := gethCrypto.Sign(hash, privKey)
	require.NoError(t, err)

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
			SizeTier:        1, // DEAL_SIZE_4GIB
			DurationBlocks:  100,
			ServiceHint:     "General",
			InitialEscrow:   math.NewInt(1000000),
			MaxMonthlySpend: math.NewInt(500000),
			Nonce:           nonce,
			ChainId:         chainID,
		}
		msgText, err := types.BuildEvmCreateDealMessage(intent)
		require.NoError(t, err)
		hash := accounts.TextHash([]byte(msgText))
		sig, err := gethCrypto.Sign(hash, privKey)
		require.NoError(t, err)

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
		SizeTier:        1, // DEAL_SIZE_4GIB
		DurationBlocks:  100,
		ServiceHint:     "General",
		InitialEscrow:   math.NewInt(1000000),
		MaxMonthlySpend: math.NewInt(500000),
		Nonce:           1,
		ChainId:         "wrong-chain",
	}

	msgText, err := types.BuildEvmCreateDealMessage(intent)
	require.NoError(t, err)
	hash := accounts.TextHash([]byte(msgText))
	sig, err := gethCrypto.Sign(hash, privKey)
	require.NoError(t, err)

	senderBz := []byte("relayer_chain_____")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	_, err = msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender:       sender,
		Intent:       intent,
		EvmSignature: sig,
	})
	require.Error(t, err)
}
