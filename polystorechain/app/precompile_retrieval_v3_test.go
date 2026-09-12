package app

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	sdkmath "cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	polystoreprecompile "polystorechain/precompiles/polystore"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

const openRetrievalSessionV3ABI = `[{"type":"function","name":"openRetrievalSessionV3","stateMutability":"nonpayable","inputs":[{"name":"dealId","type":"uint64"},{"name":"generation","type":"uint64"},{"name":"range","type":"tuple","components":[{"name":"fileRecordIndex","type":"uint32"},{"name":"fileStartOffset","type":"uint64"},{"name":"fileLength","type":"uint64"},{"name":"rangeStart","type":"uint64"},{"name":"rangeLength","type":"uint64"}]},{"name":"nonce","type":"uint64"},{"name":"deadlineHeight","type":"uint64"}],"outputs":[{"name":"sessionId","type":"bytes32"},{"name":"logicalRequestedBytes","type":"uint64"},{"name":"billedEncodedBytes","type":"uint64"},{"name":"sampleCount","type":"uint64"}]},{"type":"event","name":"RetrievalSessionV3Opened","inputs":[{"name":"dealId","type":"uint64","indexed":true},{"name":"requester","type":"address","indexed":true},{"name":"sessionId","type":"bytes32","indexed":false}]}]`

const sponsoredRetrievalSessionV3ABI = `[
{"type":"function","name":"openRetrievalSessionV3Sponsored","stateMutability":"nonpayable","inputs":[{"name":"dealId","type":"uint64"},{"name":"generation","type":"uint64"},{"name":"range","type":"tuple","components":[{"name":"fileRecordIndex","type":"uint32"},{"name":"fileStartOffset","type":"uint64"},{"name":"fileLength","type":"uint64"},{"name":"rangeStart","type":"uint64"},{"name":"rangeLength","type":"uint64"}]},{"name":"nonce","type":"uint64"},{"name":"deadlineHeight","type":"uint64"},{"name":"maxTotalFee","type":"uint256"},{"name":"authType","type":"uint8"},{"name":"allowlistLeafIndex","type":"uint32"},{"name":"allowlistMerklePath","type":"bytes32[]"},{"name":"voucherRedeemer","type":"string"},{"name":"voucherManifestRoot","type":"bytes"},{"name":"voucherProvider","type":"string"},{"name":"voucherStartMduIndex","type":"uint64"},{"name":"voucherStartBlobIndex","type":"uint32"},{"name":"voucherBlobCount","type":"uint64"},{"name":"voucherExpiresAt","type":"uint64"},{"name":"voucherNonce","type":"uint64"},{"name":"voucherSignature","type":"bytes"}],"outputs":[{"name":"sessionId","type":"bytes32"},{"name":"logicalRequestedBytes","type":"uint64"},{"name":"billedEncodedBytes","type":"uint64"},{"name":"sampleCount","type":"uint64"}]},
{"type":"function","name":"acknowledgeRetrievalObligationV3","stateMutability":"nonpayable","inputs":[{"name":"sessionId","type":"bytes32"},{"name":"slot","type":"uint32"},{"name":"ackDigest","type":"bytes"}],"outputs":[{"name":"settled","type":"bool"}]},
{"type":"function","name":"refundRetrievalSessionV3","stateMutability":"nonpayable","inputs":[{"name":"sessionId","type":"bytes32"}],"outputs":[{"name":"refunded","type":"bool"}]}
]`

type evmRetrievalRangeV3 struct {
	FileRecordIndex uint32
	FileStartOffset uint64
	FileLength      uint64
	RangeStart      uint64
	RangeLength     uint64
}

type evmChainedProofV3 struct {
	MduIndex              uint64
	MduRootFr             []byte
	ManifestOpening       []byte
	RootTableDuCommitment []byte
	RootTableDuMerklePath [][]byte
	BlobCommitment        []byte
	MerklePath            [][]byte
	BlobIndex             uint32
	ZValue                []byte
	YValue                []byte
	KzgOpeningProof       []byte
}

type evmSampleProofV3 struct {
	Ordinal uint64
	Proof   evmChainedProofV3
}

func setupNativeV3Open(t *testing.T, owner common.Address) (*App, sdk.Context, abi.ABI, types.Deal) {
	t.Helper()
	a, ctx := nativePrecompileApp(t)
	ctx = ctx.WithGasMeter(storetypes.NewInfiniteGasMeter())
	params := types.DefaultParams()
	params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 3)
	require.NoError(t, a.PolyStoreChainKeeper.Params.Set(ctx, params))
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalV2ActivatedHeight.Set(ctx, 1))
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalV3ActivatedHeight.Set(ctx, 1))
	require.NoError(t, a.PolyStoreChainKeeper.StorageAuditEpochLength.Set(ctx, params.EpochLenBlocks))

	providers := make([]string, 12)
	slots := make([]*types.DealSlot, 12)
	for i := range providers {
		address := sdk.AccAddress(bytes.Repeat([]byte{byte(0x40 + i)}, 20)).String()
		providers[i] = address
		slots[i] = &types.DealSlot{Slot: uint32(i), Provider: address, Status: types.SlotStatus_SLOT_STATUS_ACTIVE}
		require.NoError(t, a.PolyStoreChainKeeper.Providers.Set(ctx, address, types.Provider{Address: address, Status: "Active"}))
	}
	root := bytes.Repeat([]byte{0x61}, 32)
	deal := types.Deal{Id: 19, Owner: sdk.AccAddress(owner.Bytes()).String(), ManifestRoot: root, Size_: 64 * 126976,
		EscrowBalance: sdkmath.NewInt(100), StartBlock: 1, EndBlock: 100, CurrentGen: 1,
		TotalMdus: 3, WitnessMdus: 1, RedundancyMode: 2,
		Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, Mode2Slots: slots,
		MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt()}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(ctx, deal.Id, deal))
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	require.NoError(t, a.PolyStoreChainKeeper.AdmittedDealGenerationsV3.Set(ctx, deal.Id, types.DealGenerationAdmissionV3{
		DealId: deal.Id, Owner: deal.Owner, Generation: deal.CurrentGen,
		PreviousPolyfsRoot: bytes.Repeat([]byte{0x60}, 32), PolyfsRoot: root, IntegrityRoot: bytes.Repeat([]byte{0x62}, 32),
		Size_: deal.Size_, TotalMdus: deal.TotalMdus, WitnessMdus: deal.WitnessMdus, MetadataMdus: 2, UserMdus: 1,
		IntegrityLeafCount: 96, SetupDigest: setup, Providers: providers, AcceptedSlotsMask: (1 << 12) - 1, ChainId: ctx.ChainID(),
	}))
	require.NoError(t, a.BankKeeper.MintCoins(ctx, types.ModuleName, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100))))
	api, err := abi.JSON(strings.NewReader(openRetrievalSessionV3ABI))
	require.NoError(t, err)
	return a, ctx, api, deal
}

func packNativeV3Open(t *testing.T, api abi.ABI, deal types.Deal, nonce uint64) []byte {
	t.Helper()
	input, err := api.Pack("openRetrievalSessionV3", deal.Id, deal.CurrentGen,
		evmRetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024}, nonce, uint64(30))
	require.NoError(t, err)
	return input
}

func TestNativeEVMV3OpenReceiptReplayAndRollback(t *testing.T) {
	t.Run("receipt_and_replay", func(t *testing.T) {
		owner := common.HexToAddress("0xd001")
		a, ctx, api, deal := setupNativeV3Open(t, owner)
		input := packNativeV3Open(t, api, deal, 1)
		var sessionID [32]byte
		var charged sdkmath.Int
		for attempt := 0; attempt < 2; attempt++ {
			evm, state := nativeEVM(t, a, ctx)
			output, _, err := evm.Call(owner, polystoreprecompile.Address, input, 8_000_000, uint256.NewInt(0))
			require.NoError(t, err)
			decoded, err := api.Methods["openRetrievalSessionV3"].Outputs.Unpack(output)
			require.NoError(t, err)
			gotID := decoded[0].([32]byte)
			if attempt == 0 {
				sessionID = gotID
			} else {
				require.Equal(t, sessionID, gotID)
			}
			require.Len(t, state.Logs(), 1)
			log := state.Logs()[0]
			require.Equal(t, polystoreprecompile.Address, log.Address)
			require.Equal(t, []common.Hash{api.Events["RetrievalSessionV3Opened"].ID, common.BigToHash(sdkmath.NewIntFromUint64(deal.Id).BigInt()), common.BytesToHash(owner.Bytes())}, log.Topics)
			data, err := api.Events["RetrievalSessionV3Opened"].Inputs.NonIndexed().Unpack(log.Data)
			require.NoError(t, err)
			require.Equal(t, sessionID, data[0])
			require.NoError(t, state.Commit())
			storedDeal, err := a.PolyStoreChainKeeper.Deals.Get(ctx, deal.Id)
			require.NoError(t, err)
			if attempt == 0 {
				charged = storedDeal.EscrowBalance
			} else {
				require.Equal(t, charged, storedDeal.EscrowBalance, "exact retry must not charge twice")
			}
		}
	})

	// Measure the complete native call once, then fail the identical call on its
	// final unit of gas. This reaches the session and retention writes before
	// EVM rollback instead of exhausting only the ABI/admission charge.
	calibrationOwner := common.HexToAddress("0xd021")
	calibrationApp, calibrationCtx, calibrationAPI, calibrationDeal := setupNativeV3Open(t, calibrationOwner)
	calibrationInput := packNativeV3Open(t, calibrationAPI, calibrationDeal, 1)
	calibrationEVM, _ := nativeEVM(t, calibrationApp, calibrationCtx)
	const calibrationLimit = uint64(8_000_000)
	_, calibrationLeft, err := calibrationEVM.Call(calibrationOwner, polystoreprecompile.Address, calibrationInput, calibrationLimit, uint256.NewInt(0))
	require.NoError(t, err)
	lateOOGGas := calibrationLimit - calibrationLeft - 1
	require.LessOrEqual(t, lateOOGGas, uint64(^uint32(0)))

	for _, tc := range []struct {
		name   string
		gas    uint32
		revert bool
		result byte
	}{{"caught_revert", 8_000_000, true, 0}, {"caught_out_of_gas_after_writes", uint32(lateOOGGas), false, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			child := common.HexToAddress("0xd011")
			a, ctx, api, deal := setupNativeV3Open(t, child)
			input := packNativeV3Open(t, api, deal, 1)
			beforeEvents := append(sdk.Events(nil), ctx.EventManager().Events()...)
			evm, state := nativeEVM(t, a, ctx)
			outer := common.HexToAddress("0xd012")
			state.SetCode(outer, callAndReturn(child, 10_000_000, false))
			state.SetCode(child, callAndReturn(polystoreprecompile.Address, tc.gas, tc.revert))
			result, _, err := evm.Call(common.HexToAddress("0xd013"), outer, input, 14_000_000, uint256.NewInt(0))
			require.NoError(t, err)
			require.Equal(t, tc.result, result[31])
			require.Empty(t, state.Logs())
			require.NoError(t, state.Commit())
			storedDeal, err := a.PolyStoreChainKeeper.Deals.Get(ctx, deal.Id)
			require.NoError(t, err)
			require.Equal(t, deal.EscrowBalance, storedDeal.EscrowBalance)
			noncePresent, err := a.PolyStoreChainKeeper.RetrievalSessionV3NonceIDs.Has(ctx,
				collections.Join(collections.Join(deal.Owner, deal.Id), uint64(1)))
			require.NoError(t, err)
			require.False(t, noncePresent)
			_, err = a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(ctx)
			require.ErrorIs(t, err, collections.ErrNotFound)
			_, err = a.PolyStoreChainKeeper.RetrievalSessionGenerationCount.Get(ctx)
			require.ErrorIs(t, err, collections.ErrNotFound)
			count := 0
			require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessionsV3.Walk(ctx, nil, func(_ []byte, _ types.RetrievalSessionV3) (bool, error) {
				count++
				return false, nil
			}))
			require.Zero(t, count)
			require.Equal(t, beforeEvents, ctx.EventManager().Events())
			if tc.gas == uint32(lateOOGGas) {
				require.Greater(t, uint64(tc.gas), uint64(220_000))
				t.Logf("v3 open late OOG gas=%d calibrated successful gas=%d", tc.gas, lateOOGGas+1)
			}
		})
	}
}

func TestNativeEVMV3SponsoredOpenChargesOnceAndRefundsFrozenPayer(t *testing.T) {
	owner := common.HexToAddress("0xd031")
	requester := common.HexToAddress("0xd032")
	wrongCaller := common.HexToAddress("0xd033")
	a, ctx, _, deal := setupNativeV3Open(t, owner)
	deal.RetrievalPolicy = types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(ctx, deal.Id, deal))
	requesterNative := sdk.AccAddress(requester.Bytes())
	initialFunds := sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 10))
	require.NoError(t, a.BankKeeper.MintCoins(ctx, types.ModuleName, initialFunds))
	require.NoError(t, a.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, requesterNative, initialFunds))
	module := authtypes.NewModuleAddress(types.ModuleName)
	initialModuleBalance := a.BankKeeper.GetBalance(ctx, module, sdk.DefaultBondDenom).Amount
	api, err := abi.JSON(strings.NewReader(sponsoredRetrievalSessionV3ABI))
	require.NoError(t, err)
	packOpen := func(maxFee int64) []byte {
		input, err := api.Pack("openRetrievalSessionV3Sponsored", deal.Id, deal.CurrentGen,
			evmRetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024},
			uint64(1), uint64(30), big.NewInt(maxFee), uint8(0), uint32(0), []common.Hash{},
			"", []byte{}, "", uint64(0), uint32(0), uint64(0), uint64(0), uint64(0), []byte{})
		require.NoError(t, err)
		return input
	}
	call := func(callCtx sdk.Context, caller common.Address, input []byte) ([]byte, error) {
		evm, state := nativeEVM(t, a, callCtx)
		output, _, err := evm.Call(caller, polystoreprecompile.Address, input, 8_000_000, uint256.NewInt(0))
		require.NoError(t, state.Commit())
		return output, err
	}
	balance := func(callCtx sdk.Context) sdkmath.Int {
		return a.BankKeeper.GetBalance(callCtx, requesterNative, sdk.DefaultBondDenom).Amount
	}
	sessionCount := func(callCtx sdk.Context) int {
		count := 0
		require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessionsV3.Walk(callCtx, nil, func(_ []byte, _ types.RetrievalSessionV3) (bool, error) {
			count++
			return false, nil
		}))
		return count
	}
	revertReason := func(output []byte) string {
		reason, err := abi.UnpackRevert(output)
		require.NoError(t, err)
		return reason
	}

	rejected, err := call(ctx, requester, packOpen(4))
	require.Error(t, err)
	require.Contains(t, revertReason(rejected), "total fee exceeds max_total_fee")
	require.Equal(t, sdkmath.NewInt(10), balance(ctx))
	require.Zero(t, sessionCount(ctx))

	openInput := packOpen(5)
	opened, err := call(ctx, requester, openInput)
	require.NoError(t, err)
	decoded, err := api.Methods["openRetrievalSessionV3Sponsored"].Outputs.Unpack(opened)
	require.NoError(t, err)
	sessionID := decoded[0].([32]byte)
	require.Equal(t, sdkmath.NewInt(5), balance(ctx), "base fee plus one blob fee must be debited")
	require.Equal(t, initialModuleBalance.AddRaw(3), a.BankKeeper.GetBalance(ctx, module, sdk.DefaultBondDenom).Amount)
	stored, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, sessionID[:])
	require.NoError(t, err)
	require.Equal(t, requesterNative.String(), stored.Owner)
	require.Equal(t, requesterNative.String(), stored.Payer)
	require.Equal(t, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER, stored.Funding)
	require.Equal(t, sdkmath.NewInt(3), stored.LockedFee)

	retried, err := call(ctx, requester, openInput)
	require.NoError(t, err)
	retryDecoded, err := api.Methods["openRetrievalSessionV3Sponsored"].Outputs.Unpack(retried)
	require.NoError(t, err)
	require.Equal(t, sessionID, retryDecoded[0].([32]byte))
	require.Equal(t, sdkmath.NewInt(5), balance(ctx), "exact nonce retry must not charge twice")
	require.Equal(t, initialModuleBalance.AddRaw(3), a.BankKeeper.GetBalance(ctx, module, sdk.DefaultBondDenom).Amount)
	require.Equal(t, 1, sessionCount(ctx))

	ackInput, err := api.Pack("acknowledgeRetrievalObligationV3", sessionID, stored.Obligations[0].Slot, bytes.Repeat([]byte{0x11}, 32))
	require.NoError(t, err)
	rejected, err = call(ctx, wrongCaller, ackInput)
	require.Error(t, err)
	require.Contains(t, revertReason(rejected), "only the frozen session owner may acknowledge")
	refundInput, err := api.Pack("refundRetrievalSessionV3", sessionID)
	require.NoError(t, err)
	rejected, err = call(ctx.WithBlockHeight(31), wrongCaller, refundInput)
	require.Error(t, err)
	require.Contains(t, revertReason(rejected), "only the frozen session owner may refund")
	require.Equal(t, sdkmath.NewInt(5), balance(ctx))

	refunded, err := call(ctx.WithBlockHeight(31), requester, refundInput)
	require.NoError(t, err)
	refundDecoded, err := api.Methods["refundRetrievalSessionV3"].Outputs.Unpack(refunded)
	require.NoError(t, err)
	require.True(t, refundDecoded[0].(bool))
	require.Equal(t, sdkmath.NewInt(8), balance(ctx), "three locked stake refund leaves the two stake base fee burned")
	require.Equal(t, initialModuleBalance, a.BankKeeper.GetBalance(ctx, module, sdk.DefaultBondDenom).Amount)
	stored, err = a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, sessionID[:])
	require.NoError(t, err)
	require.True(t, stored.Expired)
	require.True(t, stored.LockedFee.IsZero())
	require.Zero(t, stored.AckedSlotsMask)
	require.NotZero(t, stored.RefundedSlotsMask)
}

const submitRetrievalSessionProofV3ABI = `[{"type":"function","name":"submitRetrievalSessionProofV3","stateMutability":"nonpayable","inputs":[{"name":"sessionId","type":"bytes32"},{"name":"slot","type":"uint32"},{"name":"proofs","type":"tuple[]","components":[{"name":"ordinal","type":"uint64"},{"name":"proof","type":"tuple","components":[{"name":"mduIndex","type":"uint64"},{"name":"mduRootFr","type":"bytes"},{"name":"manifestOpening","type":"bytes"},{"name":"rootTableDuCommitment","type":"bytes"},{"name":"rootTableDuMerklePath","type":"bytes[]"},{"name":"blobCommitment","type":"bytes"},{"name":"merklePath","type":"bytes[]"},{"name":"blobIndex","type":"uint32"},{"name":"zValue","type":"bytes"},{"name":"yValue","type":"bytes"},{"name":"kzgOpeningProof","type":"bytes"}]}]}],"outputs":[{"name":"newlyAccepted","type":"uint32"},{"name":"settled","type":"bool"}]}]`

func appChallengeContextV3(t *testing.T, s types.RetrievalSessionV3) retrievalchallenge.ContextV3 {
	t.Helper()
	var setup, id, root, integrity, plan [32]byte
	copy(setup[:], s.SetupDigest)
	copy(id[:], s.SessionId)
	copy(root[:], s.PolyfsRoot)
	copy(integrity[:], s.IntegrityRoot)
	copy(plan[:], s.PlanHash)
	owner, err := sdk.AccAddressFromBech32(s.Owner)
	require.NoError(t, err)
	payer, err := sdk.AccAddressFromBech32(s.Payer)
	require.NoError(t, err)
	var owner20, payer20 [20]byte
	copy(owner20[:], owner)
	copy(payer20[:], payer)
	c := retrievalchallenge.ContextV3{
		ChainID: s.ChainId, SetupDigest: setup, SessionID: id, SessionOwner: owner20,
		DealID: s.DealId, Generation: s.Generation, PolyFSRoot: root, IntegrityRoot: integrity,
		FileRecordIndex: s.FileRecordIndex, FileStartOffset: s.FileStartOffset, FileLength: s.FileLength,
		RangeStart: s.RangeStart, RangeLength: s.RangeLength, MetadataMDUs: s.MetadataMdus, UserMDUs: s.UserMdus,
		PlanHash: plan, Population: s.Population, SampleCount: s.SampleCount, Nonce: s.Nonce,
		PriceDenom: s.PriceDenom, PricePerBlob: s.PricePerBlob.String(), BaseFee: s.BaseFee.String(),
		CompletionBurnBPS: s.CompletionBurnBps, FundingKind: uint8(s.Funding), FundingPayer: payer20,
		Window:  retrievalchallenge.Window{Snapshot: s.SnapshotHeight, Anchor: s.AnchorHeight, First: s.FirstResponseHeight, Deadline: s.DeadlineHeight},
		DealEnd: s.DealEndHeight,
	}
	h, err := c.Hash()
	require.NoError(t, err)
	require.Equal(t, s.ContextHash, h[:])
	return c
}

func TestSignedEVMV3ProofUsesProductionGasAndRollsBackOutOfGas(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
	}
	key, err := crypto.HexToECDSA("1123456789012345678901234567890123456789012345678901234567890123")
	require.NoError(t, err)
	caller := crypto.PubkeyToAddress(key.PublicKey)
	owner := sdk.AccAddress(caller.Bytes())
	a := New(log.NewNopLogger(), dbm.NewMemDB(), nil, true,
		simtestutil.AppOptionsMap{"home": t.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID},
		baseapp.SetChainID(SimAppChainID))
	defer func() { require.NoError(t, a.Close()) }()
	valSet, err := simtestutil.CreateRandomValidatorSet()
	require.NoError(t, err)
	funds := sdkmath.NewInt(1_000_000_000).MulRaw(1_000_000_000)
	module := authtypes.NewModuleAddress(types.ModuleName)
	genesis, err := simtestutil.GenesisStateWithValSet(a.AppCodec(), a.DefaultGenesis(), valSet,
		[]authtypes.GenesisAccount{authtypes.NewBaseAccount(owner, nil, 0, 0)},
		banktypes.Balance{Address: owner.String(), Coins: sdk.NewCoins(sdk.NewCoin("aatom", funds))},
		banktypes.Balance{Address: module.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("stake", 100))})
	require.NoError(t, err)
	var bank banktypes.GenesisState
	a.AppCodec().MustUnmarshalJSON(genesis[banktypes.ModuleName], &bank)
	bank.DenomMetadata = append(bank.DenomMetadata, banktypes.Metadata{
		Description: "EVM fee token metadata", Base: "aatom", Display: "atom", Name: "Atom", Symbol: "ATOM",
		DenomUnits: []*banktypes.DenomUnit{{Denom: "aatom", Exponent: 0, Aliases: []string{"uatom"}}, {Denom: "atom", Exponent: 18}},
	})
	genesis[banktypes.ModuleName] = a.AppCodec().MustMarshalJSON(&bank)
	evmGenesis := evmtypes.DefaultGenesisState()
	evmGenesis.Params.ActiveStaticPrecompiles = append(evmGenesis.Params.ActiveStaticPrecompiles, polystoreprecompile.AddressHex)
	genesis[evmtypes.ModuleName] = a.AppCodec().MustMarshalJSON(evmGenesis)
	rawGenesis, err := json.Marshal(genesis)
	require.NoError(t, err)
	_, err = a.InitChain(&abci.RequestInitChain{ChainId: SimAppChainID, AppStateBytes: rawGenesis,
		ConsensusParams: &cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: 64_000_000, MaxBytes: 2_097_152}}})
	require.NoError(t, err)
	finalize := func(height int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
		response, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height, Hash: bytes.Repeat([]byte{byte(height)}, 32),
			Time: time.Unix(height, 0), ProposerAddress: valSet.Validators[0].Address, Txs: txs})
		require.NoError(t, err)
		_, err = a.Commit()
		require.NoError(t, err)
		return response
	}
	require.NoError(t, crypto_ffi.Init("../trusted_setup.txt"))
	rawFixture, err := os.ReadFile("../x/polystorechain/keeper/testdata/proof_admission_k8.json")
	require.NoError(t, err)
	var fixture struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(t, json.Unmarshal(rawFixture, &fixture))
	require.NotEmpty(t, fixture.Proofs)

	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	params := types.DefaultParams()
	params.BaseRetrievalFee = sdk.NewInt64Coin("stake", 2)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin("stake", 3)
	require.NoError(t, a.PolyStoreChainKeeper.Params.Set(setup, params))
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalV2ActivatedHeight.Set(setup, 1))
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalV3ActivatedHeight.Set(setup, 1))
	require.NoError(t, a.PolyStoreChainKeeper.StorageAuditEpochLength.Set(setup, params.EpochLenBlocks))
	providers := make([]string, 12)
	slots := make([]*types.DealSlot, 12)
	for i := range providers {
		address := sdk.AccAddress(bytes.Repeat([]byte{byte(0x70 + i)}, 20)).String()
		if i == 0 {
			address = owner.String()
		}
		providers[i] = address
		slots[i] = &types.DealSlot{Slot: uint32(i), Provider: address, Status: types.SlotStatus_SLOT_STATUS_ACTIVE}
		require.NoError(t, a.PolyStoreChainKeeper.Providers.Set(setup, address, types.Provider{Address: address, Status: "Active"}))
	}
	deal := types.Deal{Id: 27, Owner: owner.String(), ManifestRoot: fixture.Root, Size_: 64 * retrievalchallenge.DataBlobPayloadBytes,
		EscrowBalance: sdkmath.NewInt(100), StartBlock: 1, EndBlock: 100, CurrentGen: 1,
		TotalMdus: 3, WitnessMdus: 1, RedundancyMode: 2, Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, Mode2Slots: slots,
		MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt()}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(setup, deal.Id, deal))
	setupDigest, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	require.NoError(t, a.PolyStoreChainKeeper.AdmittedDealGenerationsV3.Set(setup, deal.Id, types.DealGenerationAdmissionV3{
		DealId: deal.Id, Owner: deal.Owner, Generation: deal.CurrentGen, PreviousPolyfsRoot: bytes.Repeat([]byte{0x60}, 32),
		PolyfsRoot: fixture.Root, IntegrityRoot: bytes.Repeat([]byte{0x62}, 32), Size_: deal.Size_, TotalMdus: deal.TotalMdus,
		WitnessMdus: 1, MetadataMdus: 2, UserMdus: 1, IntegrityLeafCount: 96, SetupDigest: setupDigest,
		Providers: providers, AcceptedSlotsMask: (1 << 12) - 1, ChainId: SimAppChainID,
	}))
	opened, err := keeper.NewMsgServerImpl(a.PolyStoreChainKeeper).OpenRetrievalSessionV3(setup, &types.MsgOpenRetrievalSessionV3{
		Creator: owner.String(), DealId: deal.Id, Generation: deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024}, Nonce: 1, DeadlineHeight: 20,
	})
	require.NoError(t, err)
	finalize(1)
	finalize(2)
	query := retrievalNativeQuery(t, a)
	session, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(query, opened.SessionId)
	require.NoError(t, err)
	anchor, err := a.PolyStoreChainKeeper.ChallengeAnchors.Get(query, session.AnchorHeight)
	require.NoError(t, err)
	challengeContext := appChallengeContextV3(t, session)
	seed, err := challengeContext.Seed(anchor.Seed)
	require.NoError(t, err)
	challenges, err := challengeContext.Challenges(seed[:])
	require.NoError(t, err)
	require.Len(t, challenges, 1)
	require.Equal(t, uint32(0), challenges[0].Slot)
	require.Equal(t, uint32(0), challenges[0].LeafIndex)
	blob := make([]byte, types.BLOB_SIZE)
	for i := 31; i < len(blob); i += 32 {
		blob[i] = byte(1 + (i/32)%251)
	}
	commitment, err := crypto_ffi.CommitReceivedBlob(blob)
	require.NoError(t, err)
	proof := fixture.Proofs[0]
	require.Equal(t, commitment, proof.BlobCommitment)
	proof.ZValue = bytes.Clone(challenges[0].Z[:])
	proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(blob, proof.ZValue)
	require.NoError(t, err)

	api, err := abi.JSON(strings.NewReader(submitRetrievalSessionProofV3ABI))
	require.NoError(t, err)
	var sessionID [32]byte
	copy(sessionID[:], session.SessionId)
	wire := evmChainedProofV3{MduIndex: proof.MduIndex, MduRootFr: proof.MduRootFr, ManifestOpening: proof.ManifestOpening,
		RootTableDuCommitment: proof.RootTableDuCommitment, RootTableDuMerklePath: proof.RootTableDuMerklePath,
		BlobCommitment: proof.BlobCommitment, MerklePath: proof.MerklePath, BlobIndex: proof.BlobIndex,
		ZValue: proof.ZValue, YValue: proof.YValue, KzgOpeningProof: proof.KzgOpeningProof}
	input, err := api.Pack("submitRetrievalSessionProofV3", sessionID, uint32(0), []evmSampleProofV3{{Ordinal: challenges[0].Ordinal, Proof: wire}})
	require.NoError(t, err)
	precompile, err := polystoreprecompile.New(&a.PolyStoreChainKeeper)
	require.NoError(t, err)
	static := precompile.RequiredGas(input)
	price := big.NewInt(1_000_000_000)
	sign := func(nonce, gas uint64) []byte {
		tx := ethtypes.NewTransaction(nonce, polystoreprecompile.Address, big.NewInt(0), gas, price, input)
		signer := ethtypes.LatestSignerForChainID(new(big.Int).SetUint64(evmtypes.DefaultEVMChainID))
		signed, err := ethtypes.SignTx(tx, signer, key)
		require.NoError(t, err)
		msg := &evmtypes.MsgEthereumTx{}
		require.NoError(t, msg.FromSignedEthereumTx(signed, signer))
		cosmosTx, err := msg.BuildTx(a.TxConfig().NewTxBuilder(), "aatom")
		require.NoError(t, err)
		raw, err := a.TxConfig().TxEncoder()(cosmosTx)
		require.NoError(t, err)
		require.LessOrEqual(t, len(raw), 2_097_152)
		return raw
	}
	for i, gas := range []uint64{static + keeper.ProofCryptoGas - 1, 20_000_000} {
		result := finalize(int64(i+3), sign(uint64(i), gas)).TxResults[0]
		require.Zero(t, result.Code, result.Log)
		receipt, err := evmtypes.DecodeTxResponse(result.Data)
		require.NoError(t, err)
		require.Equal(t, receipt.GasUsed, uint64(result.GasUsed))
		stored, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(retrievalNativeQuery(t, a), session.SessionId)
		require.NoError(t, err)
		if i == 0 {
			require.Equal(t, "out of gas", receipt.VmError)
			require.Equal(t, gas, receipt.GasUsed)
			require.Zero(t, stored.Obligations[0].SampleCount)
			require.Equal(t, make([]byte, len(stored.AcceptedSampleBitmap)), stored.AcceptedSampleBitmap)
			require.Zero(t, stored.SettledSlotsMask)
			require.Empty(t, receipt.Logs)
		} else {
			require.Empty(t, receipt.VmError)
			require.Equal(t, uint64(1), stored.Obligations[0].SampleCount)
			require.Equal(t, byte(1), stored.AcceptedSampleBitmap[0]&1)
			require.Zero(t, stored.SettledSlotsMask)
			require.Less(t, receipt.GasUsed, gas)
		}
		require.GreaterOrEqual(t, receipt.GasUsed, static+keeper.ProofCryptoGas-1)
		t.Logf("v3 proof gas limit=%d static=%d crypto=%d used=%d", gas, static, keeper.ProofCryptoGas, receipt.GasUsed)
	}

	// The real proof is now accepted. Exercise the terminal ACK with production
	// bank and transaction boundaries, including failures after reference writes.
	query = retrievalNativeQuery(t, a)
	beforeACK, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(query, session.SessionId)
	require.NoError(t, err)
	beforeModule := a.BankKeeper.GetBalance(query, module, "stake")
	beforeOwner := a.BankKeeper.GetBalance(query, owner, "stake")
	beforeSupply := a.BankKeeper.GetSupply(query, "stake")
	var contextHash [32]byte
	copy(contextHash[:], session.ContextHash)
	ackDigest, err := (retrievalchallenge.ObligationAckV3{
		ChainID: session.ChainId, SessionID: challengeContext.SessionID, ContextHash: contextHash,
		PlanHash: challengeContext.PlanHash, Slot: 0, Assigned: challengeContext.SessionOwner, Payee: challengeContext.SessionOwner,
		BlobCount: session.Obligations[0].BlobCount, BilledEncodedBytes: session.Obligations[0].BlobCount * retrievalchallenge.EncodedBlobBytes,
		IntegrityRoot: challengeContext.IntegrityRoot,
	}).Hash()
	require.NoError(t, err)
	assertUnreleased := func(ctx sdk.Context) {
		stored, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, session.SessionId)
		require.NoError(t, err)
		require.Equal(t, beforeACK, stored)
		live, err := a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(ctx)
		require.NoError(t, err)
		require.Equal(t, uint64(1), live)
		retainedAnchor, err := a.PolyStoreChainKeeper.ChallengeAnchors.Get(ctx, session.AnchorHeight)
		require.NoError(t, err)
		require.Equal(t, anchor, retainedAnchor)
		refs, err := a.PolyStoreChainKeeper.RetrievalSessionGenerationRefs.Get(ctx, collections.Join(session.DealId, session.Generation))
		require.NoError(t, err)
		require.Equal(t, uint64(1), refs)
		expiry, err := a.PolyStoreChainKeeper.RetrievalSessionExpiryRefs.Has(ctx, collections.Join(session.DeadlineHeight, session.SessionId))
		require.NoError(t, err)
		require.True(t, expiry)
		terminal, err := a.PolyStoreChainKeeper.RetrievalSessionV3TerminalAnchors.Has(ctx, session.SessionId)
		require.NoError(t, err)
		require.False(t, terminal)
		require.Equal(t, beforeModule, a.BankKeeper.GetBalance(ctx, module, "stake"))
		require.Equal(t, beforeOwner, a.BankKeeper.GetBalance(ctx, owner, "stake"))
		require.Equal(t, beforeSupply, a.BankKeeper.GetSupply(ctx, "stake"))
	}
	ackAPI, err := abi.JSON(strings.NewReader(sponsoredRetrievalSessionV3ABI))
	require.NoError(t, err)
	ackInput, err := ackAPI.Pack("acknowledgeRetrievalObligationV3", sessionID, uint32(0), ackDigest[:])
	require.NoError(t, err)
	calibrationCtx, _ := query.CacheContext()
	calibrationEVM, calibrationState := nativeEVM(t, a, calibrationCtx)
	const ackLimit = uint64(8_000_000)
	_, left, err := calibrationEVM.Call(caller, polystoreprecompile.Address, ackInput, ackLimit, uint256.NewInt(0))
	require.NoError(t, err)
	require.NoError(t, calibrationState.Commit())
	calibrationSeed, err := a.PolyStoreChainKeeper.RetrievalSessionV3TerminalAnchors.Get(calibrationCtx, session.SessionId)
	require.NoError(t, err, "gas calibration must actually reach terminal mutation")
	require.Equal(t, anchor.Seed, calibrationSeed)
	lateOOG := ackLimit - left - 1
	require.LessOrEqual(t, lateOOG, uint64(^uint32(0)))
	for _, tc := range []struct {
		name   string
		gas    uint32
		revert bool
	}{{"terminal_child_revert", uint32(ackLimit), true}, {"terminal_late_out_of_gas", uint32(lateOOG), false}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, _ := query.CacheContext()
			evm, state := nativeEVM(t, a, ctx)
			state.SetCode(caller, callAndReturn(polystoreprecompile.Address, tc.gas, tc.revert))
			_, _, callErr := evm.Call(common.HexToAddress("0xf0338"), caller, ackInput, 12_000_000, uint256.NewInt(0))
			if tc.revert {
				require.Error(t, callErr)
			} else {
				require.NoError(t, callErr)
			}
			require.Empty(t, state.Logs())
			require.NoError(t, state.Commit())
			assertUnreleased(ctx)
		})
	}
	completedCtx, _ := query.CacheContext()
	completedEVM, completedState := nativeEVM(t, a, completedCtx)
	output, _, err := completedEVM.Call(caller, polystoreprecompile.Address, ackInput, ackLimit, uint256.NewInt(0))
	require.NoError(t, err)
	decoded, err := ackAPI.Methods["acknowledgeRetrievalObligationV3"].Outputs.Unpack(output)
	require.NoError(t, err)
	require.Equal(t, true, decoded[0])
	require.NoError(t, completedState.Commit())
	live, err := a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(completedCtx)
	require.NoError(t, err)
	require.Zero(t, live)
	terminalSeed, err := a.PolyStoreChainKeeper.RetrievalSessionV3TerminalAnchors.Get(completedCtx, session.SessionId)
	require.NoError(t, err)
	require.Equal(t, anchor.Seed, terminalSeed)
	completed, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(completedCtx, session.SessionId)
	require.NoError(t, err)
	require.Equal(t, uint32(1), completed.SettledSlotsMask)
	expiry, err := a.PolyStoreChainKeeper.RetrievalSessionExpiryRefs.Has(completedCtx, collections.Join(session.DeadlineHeight, session.SessionId))
	require.NoError(t, err)
	require.False(t, expiry)
	_, err = a.PolyStoreChainKeeper.RetrievalSessionGenerationRefs.Get(completedCtx, collections.Join(session.DealId, session.Generation))
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = a.PolyStoreChainKeeper.ChallengeAnchors.Get(completedCtx, session.AnchorHeight)
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.True(t, a.BankKeeper.GetBalance(completedCtx, owner, "stake").Amount.GT(beforeOwner.Amount))
}
