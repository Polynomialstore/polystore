package keeper_test

import (
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
		Cid:             "bafybridgedcid",
		SizeBytes:       8 * 1024 * 1024,
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

	// Nonce should be stored.
	storedNonce, err := f.keeper.EvmNonces.Get(f.ctx, strings.ToLower(evmAddr.Hex()))
	require.NoError(t, err)
	require.Equal(t, intent.Nonce, storedNonce)
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
		Cid:             "bafybadcid",
		SizeBytes:       8 * 1024 * 1024,
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
			Cid:             "bafyreplaycid",
			SizeBytes:       8 * 1024 * 1024,
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
		Cid:             "bafywrongchain",
		SizeBytes:       8 * 1024 * 1024,
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
