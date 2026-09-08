package app

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"testing"
	"time"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	sdkmath "cosmossdk.io/math"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	minttypes "github.com/cosmos/cosmos-sdk/x/mint/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

// Exercise the production decoder, signature ante handler, message router, bank
// keeper and FinalizeBlock commit. A later message fails after the v2 open has
// burned its base fee and written its session, nonce and retention indexes.
func TestRetrievalSessionSignedTransactionRollback(t *testing.T) {
	a := New(log.NewNopLogger(), dbm.NewMemDB(), nil, true, simtestutil.AppOptionsMap{"home": t.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID}, baseapp.SetChainID(SimAppChainID))
	key := secp256k1.GenPrivKeyFromSecret([]byte("retrieval transaction rollback owner"))
	owner := sdk.AccAddress(key.PubKey().Address())
	provider := sdk.AccAddress(bytes.Repeat([]byte{0x23}, 20))
	module := authtypes.NewModuleAddress(types.ModuleName)
	valSet, err := simtestutil.CreateRandomValidatorSet()
	require.NoError(t, err)
	genesis, err := simtestutil.GenesisStateWithValSet(a.AppCodec(), a.DefaultGenesis(), valSet,
		[]authtypes.GenesisAccount{authtypes.NewBaseAccount(owner, key.PubKey(), 0, 0)},
		banktypes.Balance{Address: owner.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("stake", 1000000), sdk.NewInt64Coin("aatom", 10000000))},
		banktypes.Balance{Address: module.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("stake", 100))})
	require.NoError(t, err)
	var bank banktypes.GenesisState
	a.AppCodec().MustUnmarshalJSON(genesis[banktypes.ModuleName], &bank)
	bank.DenomMetadata = append(bank.DenomMetadata, banktypes.Metadata{
		Description: "EVM fee token metadata", Base: "aatom", Display: "atom", Name: "Atom", Symbol: "ATOM",
		DenomUnits: []*banktypes.DenomUnit{{Denom: "aatom", Exponent: 0, Aliases: []string{"uatom"}}, {Denom: "atom", Exponent: 18}},
	})
	genesis[banktypes.ModuleName] = a.AppCodec().MustMarshalJSON(&bank)
	params := types.DefaultParams()
	params.RetrievalV2ActivationHeight = 1
	params.BaseRetrievalFee = sdk.NewInt64Coin("stake", 3)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin("stake", 7)
	genesis[types.ModuleName] = a.AppCodec().MustMarshalJSON(&types.GenesisState{Params: params})
	mint := minttypes.DefaultGenesisState()
	mint.Minter.Inflation = sdkmath.LegacyZeroDec()
	mint.Params.InflationRateChange = sdkmath.LegacyZeroDec()
	mint.Params.InflationMin = sdkmath.LegacyZeroDec()
	mint.Params.InflationMax = sdkmath.LegacyZeroDec()
	genesis[minttypes.ModuleName] = a.AppCodec().MustMarshalJSON(mint)
	rawGenesis, err := json.Marshal(genesis)
	require.NoError(t, err)
	_, err = a.InitChain(&abci.RequestInitChain{ChainId: SimAppChainID, AppStateBytes: rawGenesis,
		ConsensusParams: &cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}}})
	require.NoError(t, err)
	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	deal := types.Deal{Id: 1, Owner: owner.String(), Providers: []string{provider.String()}, ManifestRoot: bytes.Repeat([]byte{1}, 32),
		TotalMdus: 3, WitnessMdus: 1, Size_: 1024, RedundancyMode: 1, EscrowBalance: sdkmath.NewInt(100), StartBlock: 1, EndBlock: 100,
		MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt()}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(setup, 1, deal))
	require.NoError(t, a.PolyStoreChainKeeper.Providers.Set(setup, provider.String(), types.Provider{Address: provider.String(), Status: "Active"}))
	finalize := func(height int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
		response, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height, Hash: bytes.Repeat([]byte{byte(height)}, 32), Time: time.Unix(height, 0), Txs: txs})
		require.NoError(t, err)
		_, err = a.Commit()
		require.NoError(t, err)
		return response
	}
	query := func() sdk.Context {
		ctx, err := a.CreateQueryContextWithCheckHeader(0, false, false)
		require.NoError(t, err)
		return ctx
	}
	finalize(1)
	baselineSupply := a.BankKeeper.GetSupply(query(), "stake")
	sign := func(sequence uint64, msgs ...sdk.Msg) []byte {
		account := a.AuthKeeper.GetAccount(query(), owner)
		tx, err := simtestutil.GenSignedMockTx(rand.New(rand.NewSource(1)), a.TxConfig(), msgs, sdk.NewCoins(sdk.NewInt64Coin("aatom", 10000)), 3000000,
			SimAppChainID, []uint64{account.GetAccountNumber()}, []uint64{sequence}, key)
		require.NoError(t, err)
		raw, err := a.TxConfig().TxEncoder()(tx)
		require.NoError(t, err)
		return raw
	}
	open := &types.MsgOpenRetrievalSession{Creator: owner.String(), DealId: 1, Provider: provider.String(), ManifestRoot: deal.ManifestRoot,
		StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20, ChallengeVersion: 2}
	laterFailure := &banktypes.MsgSend{FromAddress: owner.String(), ToAddress: provider.String(), Amount: sdk.NewCoins(sdk.NewInt64Coin("stake", 2000000))}
	failed := finalize(2, sign(0, open, laterFailure)).TxResults[0]
	require.NotZero(t, failed.Code, failed.Log)
	require.Contains(t, failed.Log, "insufficient funds", "must reach the later bank message")
	require.Greater(t, failed.GasUsed, int64(100000), "actual receipt includes retention work despite rollback")
	ctx := query()
	updated, err := a.PolyStoreChainKeeper.Deals.Get(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, deal.EscrowBalance, updated.EscrowBalance)
	require.Equal(t, sdk.NewInt64Coin("stake", 100), a.BankKeeper.GetBalance(ctx, module, "stake"))
	require.Equal(t, baselineSupply, a.BankKeeper.GetSupply(ctx, "stake"), "failed open's burn rolls back")
	require.Equal(t, sdk.NewInt64Coin("stake", 1000000), a.BankKeeper.GetBalance(ctx, owner, "stake"))
	require.Equal(t, sdk.NewInt64Coin("aatom", 10000000-10000), a.BankKeeper.GetBalance(ctx, owner, "aatom"), "ante fee remains")
	require.Equal(t, uint64(1), a.AuthKeeper.GetAccount(ctx, owner).GetSequence(), "ante sequence remains")
	nonceKey := collections.Join(collections.Join(owner.String(), uint64(1)), provider.String())
	present, err := a.PolyStoreChainKeeper.RetrievalSessionNonces.Has(ctx, nonceKey)
	require.NoError(t, err)
	require.False(t, present)
	count := 0
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessions.Walk(ctx, nil, func(_ []byte, _ types.RetrievalSession) (bool, error) { count++; return false, nil }))
	require.Zero(t, count)
	live, err := a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(ctx)
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.Zero(t, live)
	for _, event := range failed.Events {
		require.NotEqual(t, "burn", event.Type, "rolled-back message events must not escape")
	}
	// The same session nonce succeeds with the next account sequence. This also
	// proves the failed transaction did not leave capacity/index reservations.
	accepted := finalize(3, sign(1, open)).TxResults[0]
	require.Zero(t, accepted.Code, accepted.Log)
	ctx = query()
	require.Equal(t, baselineSupply.Sub(sdk.NewInt64Coin("stake", 3)), a.BankKeeper.GetSupply(ctx, "stake"))
	require.Equal(t, sdk.NewInt64Coin("stake", 97), a.BankKeeper.GetBalance(ctx, module, "stake"))
	updated, err = a.PolyStoreChainKeeper.Deals.Get(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, sdkmath.NewInt(90), updated.EscrowBalance)
	live, err = a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(1), live)
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessions.Walk(ctx, nil, func(_ []byte, session types.RetrievalSession) (bool, error) {
		require.Equal(t, sdkmath.NewInt(7), session.LockedFee)
		require.Equal(t, int64(3), session.OpenedHeight)
		return false, nil
	}))
}
