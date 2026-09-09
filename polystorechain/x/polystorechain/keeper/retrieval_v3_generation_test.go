package keeper_test

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	"cosmossdk.io/math"
	"cosmossdk.io/store"
	"cosmossdk.io/store/metrics"
	storetypes "cosmossdk.io/store/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

type generationV3Fixture struct {
	fixture   *fixture
	bank      *trackingBankKeeper
	ctx       sdk.Context
	server    types.MsgServer
	owner     string
	providers []string
	deal      types.Deal
}

func setupGenerationV3(t *testing.T) generationV3Fixture {
	t.Helper()
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)
	ownerBytes := bytes.Repeat([]byte{0x11}, 20)
	owner, err := f.addressCodec.BytesToString(ownerBytes)
	require.NoError(t, err)
	providers := make([]string, 12)
	slots := make([]*types.DealSlot, 12)
	for i := range providers {
		providerBytes := bytes.Repeat([]byte{byte(0x20 + i)}, 20)
		providers[i], err = f.addressCodec.BytesToString(providerBytes)
		require.NoError(t, err)
		require.NoError(t, f.keeper.Providers.Set(ctx, providers[i], types.Provider{
			Address: providers[i], Status: "Active", TotalStorage: types.MAX_DEAL_BYTES,
			Bond: sdk.NewInt64Coin(sdk.DefaultBondDenom, 0), BondSlashed: sdk.NewInt64Coin(sdk.DefaultBondDenom, 0),
		}))
		slots[i] = &types.DealSlot{Slot: uint32(i), Provider: providers[i], Status: types.SlotStatus_SLOT_STATUS_ACTIVE}
	}
	deal := types.Deal{
		Id: 7, Owner: owner, ManifestRoot: bytes.Repeat([]byte{0x31}, 32), Size_: 100,
		EscrowBalance: math.ZeroInt(), StartBlock: 1, EndBlock: 100, CurrentGen: 4,
		TotalMdus: 3, WitnessMdus: 1, RedundancyMode: 2,
		Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, Mode2Slots: slots,
		MaxMonthlySpend: math.ZeroInt(), SpendWindowSpent: math.ZeroInt(),
	}
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
	return generationV3Fixture{f, bank, ctx, keeper.NewMsgServerImpl(f.keeper), owner, providers, deal}
}

func generationProposal(g generationV3Fixture, fill byte) *types.MsgProposeDealGenerationV3 {
	return &types.MsgProposeDealGenerationV3{
		Creator: g.owner, DealId: g.deal.Id, ExpectedCurrentGeneration: g.deal.CurrentGen,
		PreviousPolyfsRoot: append([]byte(nil), g.deal.ManifestRoot...), PolyfsRoot: bytes.Repeat([]byte{fill}, 32),
		IntegrityRoot: bytes.Repeat([]byte{fill + 1}, 32), Size_: 200, TotalMdus: 4, WitnessMdus: 2,
		IntegrityLeafCount: 96,
	}
}

func activateGenerationV3(t *testing.T, g generationV3Fixture) {
	t.Helper()
	require.NoError(t, g.fixture.keeper.RetrievalV2ActivatedHeight.Set(g.ctx, 1))
	require.NoError(t, g.fixture.keeper.RetrievalV3ActivatedHeight.Set(g.ctx, 1))
}

func TestGenerationV3RejectsNon20ByteProvider(t *testing.T) {
	for _, size := range []int{19, 21} {
		t.Run(fmt.Sprintf("%d_bytes", size), func(t *testing.T) {
			g := setupGenerationV3(t)
			activateGenerationV3(t, g)
			provider, err := g.fixture.addressCodec.BytesToString(bytes.Repeat([]byte{0x7a}, size))
			require.NoError(t, err)
			g.deal.Mode2Slots[0].Provider = provider
			require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
			_, err = g.server.ProposeDealGenerationV3(g.ctx, generationProposal(g, 0x51))
			require.ErrorContains(t, err, "must decode to 20 bytes")
		})
	}
}

func TestGenerationV3ActivationBoundary(t *testing.T) {
	bounded := cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{
		MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes,
	}}

	t.Run("scheduled boundary latches irreversibly", func(t *testing.T) {
		g := setupGenerationV3(t)
		ctx := g.ctx.WithBlockHeight(2).WithConsensusParams(bounded)
		params := g.fixture.keeper.GetParams(ctx)
		params.RetrievalV2ActivationHeight = 101
		params.RetrievalV3ActivationHeight = 101
		require.NoError(t, g.fixture.keeper.SetParams(ctx, params))
		require.NoError(t, g.fixture.keeper.BeginBlock(ctx.WithBlockHeight(101)))
		active, err := g.fixture.keeper.RetrievalV3Active(ctx.WithBlockHeight(101))
		require.NoError(t, err)
		require.True(t, active)
		latched, err := g.fixture.keeper.RetrievalV3ActivatedHeight.Get(ctx)
		require.NoError(t, err)
		require.Equal(t, uint64(101), latched)
		params.RetrievalV3ActivationHeight = 0
		require.ErrorContains(t, g.fixture.keeper.SetParams(ctx.WithBlockHeight(102), params), "irreversible")
	})

	t.Run("absent v2 fails closed", func(t *testing.T) {
		g := setupGenerationV3(t)
		require.NoError(t, g.fixture.keeper.RetrievalV3ActivatedHeight.Set(g.ctx, 101))
		active, err := g.fixture.keeper.RetrievalV3Active(g.ctx)
		require.NoError(t, err)
		require.False(t, active)
	})

	t.Run("missed boundary and invalid caps fail closed", func(t *testing.T) {
		for _, tc := range []struct {
			name   string
			height int64
			limits cmtproto.ConsensusParams
			want   string
		}{
			{name: "missed", height: 102, limits: bounded, want: "missed retrieval v3 activation boundary"},
			{name: "invalid caps", height: 101, limits: cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas + 1, MaxBytes: types.MaxRetrievalV2BlockBytes}}, want: "requires bounded consensus gas and bytes"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				g := setupGenerationV3(t)
				params := g.fixture.keeper.GetParams(g.ctx)
				params.RetrievalV2ActivationHeight = 1
				params.RetrievalV3ActivationHeight = 101
				require.NoError(t, g.fixture.keeper.Params.Set(g.ctx, params))
				require.NoError(t, g.fixture.keeper.RetrievalV2ActivatedHeight.Set(g.ctx, 1))
				ctx := g.ctx.WithBlockHeight(tc.height).WithConsensusParams(tc.limits)
				require.ErrorContains(t, g.fixture.keeper.BeginBlock(ctx), tc.want)
				_, err := g.fixture.keeper.RetrievalV3ActivatedHeight.Get(ctx)
				require.ErrorIs(t, err, collections.ErrNotFound)
			})
		}
	})
}

func acceptanceDigest(t *testing.T, g generationV3Fixture, candidate types.DealGenerationAdmissionV3, slot uint32) []byte {
	t.Helper()
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	providerAddr, err := sdk.AccAddressFromBech32(candidate.Providers[slot])
	require.NoError(t, err)
	var setupDigest, root, integrity [32]byte
	var provider [20]byte
	copy(setupDigest[:], setup)
	copy(root[:], candidate.PolyfsRoot)
	copy(integrity[:], candidate.IntegrityRoot)
	copy(provider[:], providerAddr)
	digest, err := (retrievalchallenge.GenerationAcceptanceV3{
		ChainID: candidate.ChainId, SetupDigest: setupDigest, DealID: candidate.DealId,
		Generation: candidate.Generation, PolyFSRoot: root, IntegrityRoot: integrity,
		MetadataMDUs: candidate.MetadataMdus, UserMDUs: candidate.UserMdus,
		Slot: slot, Provider: provider,
	}).Hash()
	require.NoError(t, err)
	return digest[:]
}

func acceptAllGenerationV3(t *testing.T, g generationV3Fixture) types.DealGenerationAdmissionV3 {
	t.Helper()
	for slot := uint32(0); slot < 12; slot++ {
		candidate, err := g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
		require.NoError(t, err)
		_, err = g.server.AcceptDealGenerationV3(g.ctx, &types.MsgAcceptDealGenerationV3{
			Creator: g.providers[slot], DealId: g.deal.Id, Slot: slot,
			AcceptanceDigest: acceptanceDigest(t, g, candidate, slot),
		})
		require.NoError(t, err)
	}
	candidate, err := g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	return candidate
}

func TestGenerationV3AdmissionLifecycleAndRestart(t *testing.T) {
	g := setupGenerationV3(t)
	proposal := generationProposal(g, 0x41)
	beforeDisabled := sessionStoreSnapshot(t, g.ctx, g.fixture.storeService)
	_, err := g.server.ProposeDealGenerationV3(g.ctx, proposal)
	require.ErrorContains(t, err, "retrieval v3 is not active")
	require.Equal(t, beforeDisabled, sessionStoreSnapshot(t, g.ctx, g.fixture.storeService))

	activateGenerationV3(t, g)
	params := g.fixture.keeper.GetParams(g.ctx)
	params.StoragePrice = math.LegacyOneDec()
	require.NoError(t, g.fixture.keeper.Params.Set(g.ctx, params))
	ownerAddr, err := sdk.AccAddressFromBech32(g.owner)
	require.NoError(t, err)
	g.bank.setAccountBalance(ownerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 20_000)))
	badLeaves := *proposal
	badLeaves.IntegrityLeafCount++
	_, err = g.server.ProposeDealGenerationV3(g.ctx, &badLeaves)
	require.ErrorContains(t, err, "integrity leaf count")
	staleGeneration := *proposal
	staleGeneration.ExpectedCurrentGeneration--
	_, err = g.server.ProposeDealGenerationV3(g.ctx, &staleGeneration)
	require.ErrorContains(t, err, "stale")
	_, err = g.server.ProposeDealGenerationV3(g.ctx, proposal)
	require.NoError(t, err)
	candidate, err := g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)

	// The authenticated signer must be the frozen provider for the slot.
	_, err = g.server.AcceptDealGenerationV3(g.ctx, &types.MsgAcceptDealGenerationV3{
		Creator: g.providers[1], DealId: g.deal.Id, Slot: 0,
		AcceptanceDigest: acceptanceDigest(t, g, candidate, 0),
	})
	require.ErrorContains(t, err, "not the frozen provider")
	_, err = g.server.AcceptDealGenerationV3(g.ctx, &types.MsgAcceptDealGenerationV3{
		Creator: g.providers[0], DealId: g.deal.Id, Slot: 0,
		AcceptanceDigest: acceptanceDigest(t, g, candidate, 0),
	})
	require.NoError(t, err)

	// Exact proposal retry preserves consent; replacement clears it and rejects a delayed acceptance.
	_, err = g.server.ProposeDealGenerationV3(g.ctx, proposal)
	require.NoError(t, err)
	candidate, err = g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	require.Equal(t, uint32(1), candidate.AcceptedSlotsMask)
	oldDigest := acceptanceDigest(t, g, candidate, 1)
	replacement := generationProposal(g, 0x51)
	_, err = g.server.ProposeDealGenerationV3(g.ctx, replacement)
	require.NoError(t, err)
	candidate, err = g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	require.Zero(t, candidate.AcceptedSlotsMask)
	_, err = g.server.AcceptDealGenerationV3(g.ctx, &types.MsgAcceptDealGenerationV3{Creator: g.providers[1], DealId: g.deal.Id, Slot: 1, AcceptanceDigest: oldDigest})
	require.ErrorContains(t, err, "digest does not match")

	// Commit and reopen the backing IAVL store to prove the snapshot survives restart.
	g.fixture.cms.Commit()
	reopenedStore := store.NewCommitMultiStore(g.fixture.db, log.NewNopLogger(), metrics.NewNoOpMetrics())
	reopenedStore.MountStoreWithDB(g.fixture.storeKey, storetypes.StoreTypeIAVL, g.fixture.db)
	require.NoError(t, reopenedStore.LoadLatestVersion())
	reopenedCtx := g.ctx.WithMultiStore(reopenedStore)
	reopenedService := runtime.NewKVStoreService(g.fixture.storeKey)
	encCfg := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
	restarted := keeper.NewKeeper(reopenedService, encCfg.Codec, g.fixture.addressCodec, authtypes.NewModuleAddress(types.GovModuleName), g.bank, MockAccountKeeper{})
	restored, err := restarted.PendingDealGenerationsV3.Get(reopenedCtx, g.deal.Id)
	require.NoError(t, err)
	require.Equal(t, candidate.String(), restored.String())
	queryBefore := sessionStoreSnapshot(t, reopenedCtx, reopenedService)
	queryResponse, err := keeper.NewQueryServerImpl(restarted).GetDealGenerationV3(reopenedCtx, &types.QueryGetDealGenerationV3Request{DealId: g.deal.Id})
	require.NoError(t, err)
	require.NotNil(t, queryResponse.Pending)
	require.Nil(t, queryResponse.Admitted)
	require.Equal(t, queryBefore, sessionStoreSnapshot(t, reopenedCtx, reopenedService))

	for slot := uint32(0); slot < 11; slot++ {
		candidate, err = g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
		require.NoError(t, err)
		_, err = g.server.AcceptDealGenerationV3(g.ctx, &types.MsgAcceptDealGenerationV3{Creator: g.providers[slot], DealId: g.deal.Id, Slot: slot, AcceptanceDigest: acceptanceDigest(t, g, candidate, slot)})
		require.NoError(t, err)
	}
	candidate, err = g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	_, err = g.server.FinalizeDealGenerationV3(g.ctx, &types.MsgFinalizeDealGenerationV3{Creator: g.owner, DealId: g.deal.Id, Generation: candidate.Generation, PolyfsRoot: candidate.PolyfsRoot})
	require.ErrorContains(t, err, "all twelve")
	require.Empty(t, g.bank.transfers)
	candidate = acceptAllGenerationV3(t, g)
	oldGenerationKey := collections.Join(g.deal.Id, g.deal.CurrentGen)
	require.NoError(t, g.fixture.keeper.RetrievalSessionGenerationRefs.Set(g.ctx, oldGenerationKey, 2))
	require.NoError(t, g.fixture.keeper.RetrievalSessionGenerationCounts.Set(g.ctx, g.deal.Id, 1))
	require.NoError(t, g.fixture.keeper.RetrievalSessionGenerationCount.Set(g.ctx, 1))
	expired := g.ctx.WithBlockHeight(int64(g.deal.EndBlock))
	_, err = g.server.FinalizeDealGenerationV3(expired, &types.MsgFinalizeDealGenerationV3{Creator: g.owner, DealId: g.deal.Id, Generation: candidate.Generation, PolyfsRoot: candidate.PolyfsRoot})
	require.ErrorContains(t, err, "expired")
	require.Empty(t, g.bank.transfers)

	_, err = g.server.FinalizeDealGenerationV3(g.ctx, &types.MsgFinalizeDealGenerationV3{Creator: g.owner, DealId: g.deal.Id, Generation: candidate.Generation, PolyfsRoot: candidate.PolyfsRoot})
	require.NoError(t, err)
	updated, err := g.fixture.keeper.Deals.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	eligible, err := g.fixture.keeper.DealGenerationV3Eligible(g.ctx, updated)
	require.NoError(t, err)
	require.True(t, eligible)
	require.Len(t, g.bank.transfers, 1)
	require.Equal(t, math.NewInt(9_900), updated.EscrowBalance)
	require.Equal(t, "9900stake", g.bank.moduleBalances[types.ModuleName].String())
	require.Equal(t, "10100stake", g.bank.accountBalances[g.owner].String())
	oldRefs, err := g.fixture.keeper.RetrievalSessionGenerationRefs.Get(g.ctx, oldGenerationKey)
	require.NoError(t, err)
	require.Equal(t, uint64(2), oldRefs)
	generationCount, err := g.fixture.keeper.RetrievalSessionGenerationCount.Get(g.ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(1), generationCount)
	transfers := len(g.bank.transfers)
	_, err = g.server.FinalizeDealGenerationV3(g.ctx, &types.MsgFinalizeDealGenerationV3{Creator: g.owner, DealId: g.deal.Id, Generation: candidate.Generation, PolyfsRoot: candidate.PolyfsRoot})
	require.NoError(t, err)
	require.Len(t, g.bank.transfers, transfers)

	updated.Mode2Slots[0].Provider = g.providers[1]
	require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, updated.Id, updated))
	eligible, err = g.fixture.keeper.DealGenerationV3Eligible(g.ctx, updated)
	require.NoError(t, err)
	require.False(t, eligible)
}

func TestGenerationV3FinalizeBankFailureIsAtomic(t *testing.T) {
	g := setupGenerationV3(t)
	activateGenerationV3(t, g)
	params := g.fixture.keeper.GetParams(g.ctx)
	params.StoragePrice = math.LegacyOneDec()
	require.NoError(t, g.fixture.keeper.Params.Set(g.ctx, params))
	proposal := generationProposal(g, 0x61)
	_, err := g.server.ProposeDealGenerationV3(g.ctx, proposal)
	require.NoError(t, err)
	candidate := acceptAllGenerationV3(t, g)
	before := sessionStoreSnapshot(t, g.ctx, g.fixture.storeService)

	cached, _ := g.ctx.CacheContext()
	_, err = g.server.FinalizeDealGenerationV3(cached, &types.MsgFinalizeDealGenerationV3{
		Creator: g.owner, DealId: g.deal.Id, Generation: candidate.Generation, PolyfsRoot: candidate.PolyfsRoot,
	})
	require.ErrorContains(t, err, "failed to pay term deposit")
	require.Equal(t, before, sessionStoreSnapshot(t, g.ctx, g.fixture.storeService))
	_, err = g.fixture.keeper.PendingDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
}
