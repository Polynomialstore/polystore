package app

import (
	"bytes"
	"testing"
	"time"

	"cosmossdk.io/log"
	storetypes "cosmossdk.io/store/types"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	"github.com/cosmos/cosmos-sdk/runtime"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	consensuskeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

// This runs the pinned BaseApp FinalizeBlock header construction, its real IAVL
// commit caches and keeper BeginBlock. Supplying a handcrafted SDK header would
// miss ABCI2's absent LastBlockId and would not establish seed durability.
func TestRetrievalChallengeABCIAnchorCommitAndRestart(t *testing.T) {
	db := dbm.NewMemDB()
	build := func() (*baseapp.BaseApp, keeper.Keeper) {
		cfg := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
		app := baseapp.NewBaseApp("challenge-header-test", log.NewNopLogger(), db, nil, baseapp.SetChainID("challenge-header-test"))
		key := storetypes.NewKVStoreKey(types.StoreKey)
		consensusKey := storetypes.NewKVStoreKey("consensus")
		app.MountKVStores(map[string]*storetypes.KVStoreKey{types.StoreKey: key, "consensus": consensusKey})
		k := keeper.NewKeeper(runtime.NewKVStoreService(key), cfg.Codec, addresscodec.NewBech32Codec("cosmos"), bytes.Repeat([]byte{1}, 20), nil, nil)
		cp := consensuskeeper.NewKeeper(cfg.Codec, runtime.NewKVStoreService(consensusKey), "test", nil)
		app.SetParamStore(cp.ParamsStore)
		app.SetInitChainer(func(ctx sdk.Context, _ *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
			params := types.DefaultParams()
			params.RetrievalV2ActivationHeight = 1
			params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
			params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
			if err := k.Params.Set(ctx, params); err != nil {
				return nil, err
			}
			for _, height := range []uint64{2, 3} {
				if err := k.ChallengeAnchors.Set(ctx, height, types.ChallengeAnchor{SessionReferences: 1}); err != nil {
					return nil, err
				}
				if err := k.ChallengePendingAnchors.Set(ctx, height, true); err != nil {
					return nil, err
				}
			}
			return &abci.ResponseInitChain{}, nil
		})
		app.SetBeginBlocker(func(ctx sdk.Context) (sdk.BeginBlock, error) {
			require.Empty(t, ctx.BlockHeader().LastBlockId.Hash, "the test must use ABCI2's actual incomplete header")
			return sdk.BeginBlock{}, k.BeginBlock(ctx)
		})
		require.NoError(t, app.LoadLatestVersion())
		return app, k
	}
	app, k := build()
	_, err := app.InitChain(&abci.RequestInitChain{ChainId: "challenge-header-test", ConsensusParams: &cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}}})
	require.NoError(t, err)
	finalize := func(height int64, hash []byte) {
		_, err := app.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height, Hash: hash, Time: time.Unix(height, 0)})
		require.NoError(t, err)
	}
	committed := func() sdk.Context {
		ctx, err := app.CreateQueryContextWithCheckHeader(0, false, false)
		require.NoError(t, err)
		return ctx
	}
	finalize(1, bytes.Repeat([]byte{0x11}, 32))
	_, err = app.Commit()
	require.NoError(t, err)
	finalize(2, bytes.Repeat([]byte{0x22}, 32))
	before, err := k.ChallengeAnchors.Get(committed(), 2)
	require.NoError(t, err)
	require.Empty(t, before.Seed, "uncommitted anchor must not escape the block cache")
	_, err = app.Commit()
	require.NoError(t, err)
	after, err := k.ChallengeAnchors.Get(committed(), 2)
	require.NoError(t, err)
	require.Equal(t, bytes.Repeat([]byte{0x22}, 32), after.Seed)
	// Reload from the actual store, not module genesis export (which is unsupported).
	app, k = build()
	after, err = k.ChallengeAnchors.Get(committed(), 2)
	require.NoError(t, err)
	require.Equal(t, bytes.Repeat([]byte{0x22}, 32), after.Seed)
	active, err := k.RetrievalV2Active(committed())
	require.NoError(t, err)
	require.True(t, active)
	finalize(3, nil)
	_, err = app.Commit()
	require.NoError(t, err)
	finalize(4, bytes.Repeat([]byte{0x44}, 32))
	_, err = app.Commit()
	require.NoError(t, err)
	unavailable, err := k.ChallengeAnchors.Get(committed(), 3)
	require.NoError(t, err)
	require.Empty(t, unavailable.Seed, "missing fixed anchor must never use a later hash")
	pending, err := k.ChallengePendingAnchors.Has(committed(), 3)
	require.NoError(t, err)
	require.False(t, pending)
}
