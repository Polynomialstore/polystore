package app

import (
	"bytes"
	"fmt"
	"testing"
	"time"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	"github.com/cosmos/cosmos-sdk/runtime"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	auth "github.com/cosmos/cosmos-sdk/x/auth"
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	bank "github.com/cosmos/cosmos-sdk/x/bank"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
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
	// Populate old protobuf records directly before activation: no v2 context,
	// no accepted-provider pins, and the original stored funding/payer/nonce.
	provider := sdk.AccAddress(bytes.Repeat([]byte{0x83}, 20)).String()
	var legacyRecords []types.RetrievalSession
	for _, status := range []types.RetrievalSessionStatus{
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED,
	} {
		for _, funding := range []types.RetrievalSessionFunding{
			types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_UNSPECIFIED,
			types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW,
			types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER,
			types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL,
		} {
			for _, fee := range []int64{0, 17} {
				id := byte(len(legacyRecords) + 1)
				owner := sdk.AccAddress(bytes.Repeat([]byte{id}, 20)).String()
				payer := ""
				if funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER {
					payer = owner
				}
				if funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL {
					payer = authtypes.NewModuleAddress(types.ProtocolBudgetModuleName).String()
				}
				// A historical completion has already settled its lock. Preserve it as
				// terminal even if this was originally a paid session.
				if status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
					fee = 0
				}
				legacyRecords = append(legacyRecords, types.RetrievalSession{
					SessionId: bytes.Repeat([]byte{id}, 32), Owner: owner, Provider: provider,
					DealId: uint64(id), ExpiresAt: 20, BlobCount: 1, LockedFee: math.NewInt(fee),
					Status: status, Funding: funding, Payer: payer,
				})
			}
		}
	}
	nonceKey := func(s types.RetrievalSession) collections.Pair[collections.Pair[string, uint64], string] {
		return collections.Join(collections.Join(s.Owner, s.DealId), s.Provider)
	}
	var bankK bankkeeper.BaseKeeper
	var blockAction func(sdk.Context)
	build := func() (*baseapp.BaseApp, keeper.Keeper) {
		cfg := moduletestutil.MakeTestEncodingConfig(auth.AppModuleBasic{}, bank.AppModuleBasic{}, module.AppModule{})
		app := baseapp.NewBaseApp("challenge-header-test", log.NewNopLogger(), db, nil, baseapp.SetChainID("challenge-header-test"))
		key := storetypes.NewKVStoreKey(types.StoreKey)
		consensusKey := storetypes.NewKVStoreKey("consensus")
		authKey, bankKey := storetypes.NewKVStoreKey(authtypes.StoreKey), storetypes.NewKVStoreKey("bank")
		app.MountKVStores(map[string]*storetypes.KVStoreKey{types.StoreKey: key, "consensus": consensusKey, authtypes.StoreKey: authKey, "bank": bankKey})
		authority := authtypes.NewModuleAddress(types.GovModuleName)
		ak := authkeeper.NewAccountKeeper(cfg.Codec, runtime.NewKVStoreService(authKey), authtypes.ProtoBaseAccount,
			map[string][]string{types.ModuleName: {authtypes.Minter, authtypes.Burner}, types.ProtocolBudgetModuleName: {authtypes.Minter}},
			addresscodec.NewBech32Codec(sdk.GetConfig().GetBech32AccountAddrPrefix()), sdk.GetConfig().GetBech32AccountAddrPrefix(), authority.String())
		bankK = bankkeeper.NewBaseKeeper(cfg.Codec, runtime.NewKVStoreService(bankKey), ak, nil, authority.String(), log.NewNopLogger())
		k := keeper.NewKeeper(runtime.NewKVStoreService(key), cfg.Codec, addresscodec.NewBech32Codec(sdk.GetConfig().GetBech32AccountAddrPrefix()), authority, bankK, ak)
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
			for _, name := range []string{types.ModuleName, types.ProtocolBudgetModuleName} {
				ak.GetModuleAccount(ctx, name)
			}
			require.NoError(t, bankK.MintCoins(ctx, types.ProtocolBudgetModuleName, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 13))))
			require.NoError(t, k.Providers.Set(ctx, provider, types.Provider{Address: provider, Status: "Active"}))
			for _, legacy := range legacyRecords {
				require.NoError(t, k.RetrievalSessions.Set(ctx, legacy.SessionId, legacy))
				require.NoError(t, k.RetrievalSessionNonces.Set(ctx, nonceKey(legacy), 7))
				require.NoError(t, k.Deals.Set(ctx, legacy.DealId, types.Deal{Id: legacy.DealId, Owner: legacy.Owner, EndBlock: 20, EscrowBalance: math.NewInt(100)}))
				require.NoError(t, bankK.MintCoins(ctx, types.ModuleName, sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(107).Add(legacy.LockedFee)))))
				require.NoError(t, bankK.SendCoinsFromModuleToAccount(ctx, types.ModuleName, sdk.MustAccAddressFromBech32(legacy.Owner), sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 7))))
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
			if err := k.BeginBlock(ctx); err != nil {
				return sdk.BeginBlock{}, err
			}
			if blockAction != nil {
				blockAction(ctx)
			}
			return sdk.BeginBlock{}, nil
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
	for _, legacy := range legacyRecords {
		t.Run(fmt.Sprintf("restored/%s/%s/%s/%x", legacy.Status, legacy.Funding, legacy.LockedFee, legacy.SessionId[:1]), func(t *testing.T) {
			ctx := committed().WithBlockHeight(2).WithGasMeter(storetypes.NewGasMeter(499999))
			restored, err := k.RetrievalSessions.Get(ctx, legacy.SessionId)
			require.NoError(t, err)
			require.Equal(t, legacy, restored)
			nonce, err := k.RetrievalSessionNonces.Get(ctx, nonceKey(legacy))
			require.NoError(t, err)
			require.Equal(t, uint64(7), nonce)
			server := keeper.NewMsgServerImpl(k)
			_, confirmErr := server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: legacy.Owner, SessionId: legacy.SessionId})
			_, proofErr := server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: provider, SessionId: legacy.SessionId, Proofs: []types.ChainedProof{{}}})
			if legacy.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
				require.NoError(t, confirmErr)
				require.NoError(t, proofErr)
			} else {
				require.ErrorContains(t, confirmErr, "refund-only")
				require.ErrorContains(t, proofErr, "refund-only")
				_, err = server.CancelRetrievalSession(ctx, &types.MsgCancelRetrievalSession{Creator: legacy.Owner, SessionId: legacy.SessionId})
				require.ErrorContains(t, err, "not expired")
			}
			unchanged, err := k.RetrievalSessions.Get(ctx, legacy.SessionId)
			require.NoError(t, err)
			require.Equal(t, legacy, unchanged)
			hasPin, err := k.RetrievalSessionProofProvider.Has(ctx, legacy.SessionId)
			require.NoError(t, err)
			require.False(t, hasPin)
			require.Empty(t, ctx.EventManager().Events())
		})
	}

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
	// Refund inside FinalizeBlock and commit it, then reload once more. This
	// exercises real bank/auth/IAVL state rather than a map-backed bank double.
	initialSupply := bankK.GetSupply(committed(), sdk.DefaultBondDenom)
	initialModule := bankK.GetBalance(committed(), authtypes.NewModuleAddress(types.ModuleName), sdk.DefaultBondDenom).Amount
	moduleRefund, protocolRefund := math.ZeroInt(), math.ZeroInt()
	for _, legacy := range legacyRecords {
		if legacy.Funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER || legacy.Funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL {
			moduleRefund = moduleRefund.Add(legacy.LockedFee)
		}
		if legacy.Funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL {
			protocolRefund = protocolRefund.Add(legacy.LockedFee)
		}
	}
	blockAction = func(ctx sdk.Context) {
		if ctx.BlockHeight() != 20 && ctx.BlockHeight() != 21 {
			return
		}
		server := keeper.NewMsgServerImpl(k)
		for _, legacy := range legacyRecords {
			msg := &types.MsgCancelRetrievalSession{Creator: legacy.Owner, SessionId: legacy.SessionId}
			_, err := server.CancelRetrievalSession(ctx, msg)
			if ctx.BlockHeight() == 20 && legacy.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
				require.ErrorContains(t, err, "not expired", "expiry is inclusive")
				continue
			}
			require.NoError(t, err)
			_, err = server.CancelRetrievalSession(ctx, msg)
			require.NoError(t, err, "repeat cancellation cannot refund twice")
		}
	}
	for height := int64(5); height <= 21; height++ {
		finalize(height, bytes.Repeat([]byte{byte(height)}, 32))
		_, err = app.Commit()
		require.NoError(t, err)
	}
	blockAction = nil
	app, k = build()
	ctx := committed()
	require.Equal(t, initialSupply, bankK.GetSupply(ctx, sdk.DefaultBondDenom), "refunds neither mint nor burn")
	require.Equal(t, initialModule.Sub(moduleRefund), bankK.GetBalance(ctx, authtypes.NewModuleAddress(types.ModuleName), sdk.DefaultBondDenom).Amount)
	require.Equal(t, math.NewInt(13).Add(protocolRefund), bankK.GetBalance(ctx, authtypes.NewModuleAddress(types.ProtocolBudgetModuleName), sdk.DefaultBondDenom).Amount)
	require.True(t, bankK.GetBalance(ctx, sdk.MustAccAddressFromBech32(provider), sdk.DefaultBondDenom).IsZero(), "missing pins never authorize provider payout")
	for _, legacy := range legacyRecords {
		restored, err := k.RetrievalSessions.Get(ctx, legacy.SessionId)
		require.NoError(t, err)
		expected := legacy
		if legacy.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
			expected.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED
			expected.LockedFee = math.ZeroInt()
			expected.UpdatedHeight = 21
		}
		require.Equal(t, expected, restored)
		escrow, requester := math.NewInt(100), math.NewInt(7)
		switch legacy.Funding {
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_UNSPECIFIED, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW:
			escrow = escrow.Add(legacy.LockedFee)
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER:
			requester = requester.Add(legacy.LockedFee)
		}
		deal, err := k.Deals.Get(ctx, legacy.DealId)
		require.NoError(t, err)
		require.Equal(t, escrow, deal.EscrowBalance)
		require.Equal(t, requester, bankK.GetBalance(ctx, sdk.MustAccAddressFromBech32(legacy.Owner), sdk.DefaultBondDenom).Amount)
		nonce, err := k.RetrievalSessionNonces.Get(ctx, nonceKey(legacy))
		require.NoError(t, err)
		require.Equal(t, uint64(7), nonce)
		hasPin, err := k.RetrievalSessionProofProvider.Has(ctx, legacy.SessionId)
		require.NoError(t, err)
		require.False(t, hasPin)
		hasActivity, err := k.DealActivityStates.Has(ctx, legacy.DealId)
		require.NoError(t, err)
		require.False(t, hasActivity)
	}

}
