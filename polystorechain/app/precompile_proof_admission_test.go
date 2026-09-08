package app

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"cosmossdk.io/collections"
	sdkmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"

	polystoreprecompile "polystorechain/precompiles/polystore"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestNativeEVMProofAdmissionGas(t *testing.T) {
	a, base := nativePrecompileApp(t)
	require.NoError(t, a.PolyStoreChainKeeper.Params.Set(base, types.DefaultParams()))
	require.NoError(t, crypto_ffi.Init("../trusted_setup.txt"))
	fixtureBytes, err := os.ReadFile("../x/polystorechain/keeper/testdata/proof_admission_k8.json")
	require.NoError(t, err)
	var fixture struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(t, json.Unmarshal(fixtureBytes, &fixture))
	caller := common.HexToAddress("0xaabb01")
	provider := sdk.AccAddress(common.HexToAddress("0xaabb02").Bytes()).String()
	deal := types.Deal{Id: 1, Owner: sdk.AccAddress(caller.Bytes()).String(), Providers: []string{provider}, ManifestRoot: fixture.Root, TotalMdus: 3, WitnessMdus: 1, Size_: 1 << 20, RedundancyMode: 2, Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, EscrowBalance: sdkmath.NewInt(100), EndBlock: 100}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(base, deal.Id, deal))
	activityBefore := types.DealActivityState{BytesServedTotal: 4096, SuccessfulRetrievalsTotal: 7, FailedChallengesTotal: 2, LastUpdateHeight: base.BlockHeight() - 1}
	require.NoError(t, a.PolyStoreChainKeeper.DealActivityStates.Set(base, deal.Id, activityBefore))
	method := legacyProofBatchMethod(t)
	type chunk struct {
		RangeStart, RangeLen uint64
		Proof                types.ChainedProof
	}
	var invalidGas, validGas uint64
	for _, invalid := range []int{-1, -2, -3, 0, 1, 2, 3} {
		t.Run(fmt.Sprintf("invalid_%d", invalid), func(t *testing.T) {
			ctx, _ := base.CacheContext()
			chunks := make([]chunk, 3)
			for i, p := range fixture.Proofs {
				if i == invalid || (invalid == 3 && i == 0) {
					p.YValue = append([]byte{}, p.YValue...)
					p.YValue[31] ^= 1
				}
				chunks[i] = chunk{RangeStart: 0, RangeLen: 1024, Proof: p}
			}
			packed, err := method.Inputs.Pack(deal.Id, provider, "file", uint64(1), chunks)
			require.NoError(t, err)
			input := append(append([]byte{}, method.ID...), packed...)
			precompile, err := polystoreprecompile.New(&a.PolyStoreChainKeeper)
			require.NoError(t, err)
			static := precompile.RequiredGas(input)
			gas := uint64(4_000_000)
			if invalid == 3 {
				gas = static + 3*keeper.ProofCryptoGas - 1
			}
			if invalid == -2 {
				gas = validGas
			}
			if invalid == -3 {
				gas = validGas - 1
			}
			success := invalid < 0 && invalid != -3
			outOfGas := invalid == 3 || invalid == -3
			evm, state := nativeEVM(t, a, ctx)
			_, left, err := evm.Call(caller, polystoreprecompile.Address, input, gas, uint256.NewInt(0))
			if success {
				require.NoError(t, err)
				validGas = gas - left
			} else if outOfGas {
				require.ErrorIs(t, err, vm.ErrOutOfGas)
				require.Zero(t, left)
			} else {
				require.ErrorIs(t, err, vm.ErrExecutionReverted)
				if invalidGas == 0 {
					invalidGas = gas - left
				}
				require.Equal(t, invalidGas, gas-left, "invalid-first/middle/last pay the same crypto and read costs")
			}
			require.GreaterOrEqual(t, gas-left, static+3*keeper.ProofCryptoGas-1)
			t.Logf("static=%d charged=%d", static, gas-left)
			require.NoError(t, state.Commit())
			updated, err := a.PolyStoreChainKeeper.Deals.Get(ctx, deal.Id)
			require.NoError(t, err)
			nonce, err := a.PolyStoreChainKeeper.ReceiptNoncesByDealFile.Get(ctx, collections.Join(deal.Id, "file"))
			if success {
				require.NoError(t, err)
				require.Equal(t, uint64(1), nonce)
				require.Equal(t, sdkmath.NewInt(97), updated.EscrowBalance)
				rewards, err := a.PolyStoreChainKeeper.ProviderRewards.Get(ctx, provider)
				require.NoError(t, err)
				require.Equal(t, sdkmath.NewInt(3), rewards)
				require.Len(t, state.Logs(), 1)
			} else {
				require.ErrorIs(t, err, collections.ErrNotFound)
				require.Equal(t, deal.EscrowBalance, updated.EscrowBalance)
				require.Empty(t, state.Logs())
				require.Empty(t, ctx.EventManager().Events())
			}
			activity, err := a.PolyStoreChainKeeper.DealActivityStates.Get(ctx, deal.Id)
			require.NoError(t, err)
			expectedActivity := activityBefore
			if success {
				expectedActivity.BytesServedTotal += 3 * 1024
				expectedActivity.SuccessfulRetrievalsTotal += 3
				expectedActivity.LastUpdateHeight = ctx.BlockHeight()
			}
			require.Equal(t, expectedActivity, activity, "each accepted chunk counts once; failed batches preserve all activity")
		})
	}
}

func legacyProofBatchMethod(t *testing.T) abi.Method {
	t.Helper()
	fields := []abi.ArgumentMarshaling{}
	for _, f := range []struct{ name, typ string }{{"mduIndex", "uint64"}, {"mduRootFr", "bytes"}, {"manifestOpening", "bytes"}, {"rootTableDuCommitment", "bytes"}, {"rootTableDuMerklePath", "bytes[]"}, {"blobCommitment", "bytes"}, {"merklePath", "bytes[]"}, {"blobIndex", "uint32"}, {"zValue", "bytes"}, {"yValue", "bytes"}, {"kzgOpeningProof", "bytes"}} {
		fields = append(fields, abi.ArgumentMarshaling{Name: f.name, Type: f.typ})
	}
	tuple, err := abi.NewType("tuple[]", "", []abi.ArgumentMarshaling{{Name: "rangeStart", Type: "uint64"}, {Name: "rangeLen", Type: "uint64"}, {Name: "proof", Type: "tuple", Components: fields}})
	require.NoError(t, err)
	u64, err := abi.NewType("uint64", "", nil)
	require.NoError(t, err)
	str, err := abi.NewType("string", "", nil)
	require.NoError(t, err)
	boolean, err := abi.NewType("bool", "", nil)
	require.NoError(t, err)
	return abi.NewMethod("proveRetrievalBatch", "proveRetrievalBatch", abi.Function, "nonpayable", false, false, abi.Arguments{{Name: "dealId", Type: u64}, {Name: "provider", Type: str}, {Name: "filePath", Type: str}, {Name: "nonce", Type: u64}, {Name: "chunks", Type: tuple}}, abi.Arguments{{Name: "ok", Type: boolean}})
}
