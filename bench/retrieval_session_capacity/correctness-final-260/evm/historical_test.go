package app
import (
 "math/big"
 "encoding/json"
 "os"
 sdkmath "cosmossdk.io/math"
 "cosmossdk.io/collections"
 "polystorechain/x/crypto_ffi"
 "strings"
 "testing"
 "cosmossdk.io/log"
 storetypes "cosmossdk.io/store/types"
 cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
 dbm "github.com/cosmos/cosmos-db"
 "github.com/cosmos/cosmos-sdk/baseapp"
 simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
 sdk "github.com/cosmos/cosmos-sdk/types"
 "github.com/cosmos/evm/x/vm/statedb"
 evmtypes "github.com/cosmos/evm/x/vm/types"
 "github.com/ethereum/go-ethereum/accounts/abi"
 "github.com/ethereum/go-ethereum/common"
 "github.com/ethereum/go-ethereum/core"
 "github.com/ethereum/go-ethereum/core/vm"
 "github.com/ethereum/go-ethereum/params"
 "github.com/holiman/uint256"
 "github.com/stretchr/testify/require"
 polystoreprecompile "polystorechain/precompiles/polystore"
 types "polystorechain/x/polystorechain/types"
)
func historicalCallAndReturn(target common.Address, gas uint32, revert bool) []byte {
	code := []byte{0x36, 0x60, 0, 0x60, 0, 0x37, 0x60, 0, 0x60, 0, 0x36, 0x60, 0, 0x60, 0, 0x73}
	code = append(code, target.Bytes()...)
	code = append(code, 0x62, byte(gas>>16), byte(gas>>8), byte(gas), 0xf1)
	if revert {
		return append(code, 0x50, 0x60, 0, 0x60, 0, 0xfd)
	}
	return append(code, 0x60, 0, 0x52, 0x60, 32, 0x60, 0, 0xf3)
}
func historicalNativePrecompileApp(t *testing.T) (*App, sdk.Context) {
	t.Helper()
	a := New(log.NewNopLogger(), dbm.NewMemDB(), nil, true, simtestutil.AppOptionsMap{"home": t.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID}, baseapp.SetChainID(SimAppChainID))
	ctx := a.NewContextLegacy(true, cmtproto.Header{Height: 10, ChainID: SimAppChainID}).WithGasMeter(storetypes.NewInfiniteGasMeter()).WithKVGasConfig(storetypes.GasConfig{}).WithTransientKVGasConfig(storetypes.GasConfig{})
	evmParams := evmtypes.DefaultParams()
	evmParams.ActiveStaticPrecompiles = append(evmParams.ActiveStaticPrecompiles, polystoreprecompile.AddressHex)
	require.NoError(t, a.EVMKeeper.SetParams(ctx, evmParams))

	return a, ctx
}
func historicalNativeEVM(t *testing.T, a *App, ctx sdk.Context) (*vm.EVM, *statedb.StateDB) {
	t.Helper()
	state := statedb.New(ctx, a.EVMKeeper, statedb.NewEmptyTxConfig())
	config := *params.AllEthashProtocolChanges
	config.ChainID = big.NewInt(31337)
	evm := vm.NewEVM(vm.BlockContext{CanTransfer: core.CanTransfer, Transfer: core.Transfer, BlockNumber: big.NewInt(10), GasLimit: 28000000}, state, &config, vm.Config{})
	contracts, found, err := a.EVMKeeper.GetPrecompileInstance(ctx, polystoreprecompile.Address)
	require.NoError(t, err)
	require.True(t, found)
	evm.SetPrecompiles(contracts.Map)
	return evm, state
}
func TestHistoricalCaughtChildRollback(t *testing.T) {
 a, ctx := historicalNativePrecompileApp(t)
 require.NoError(t, a.PolyStoreChainKeeper.Params.Set(ctx, types.DefaultParams()))
 evm, state := historicalNativeEVM(t, a, ctx)
 caller, outer, child := common.HexToAddress("0xaa01"), common.HexToAddress("0xaa02"), common.HexToAddress("0xaa03")
 state.SetCode(outer, historicalCallAndReturn(child, 8000000, false))
 state.SetCode(child, historicalCallAndReturn(polystoreprecompile.Address, 5000000, true))
 api, err := abi.JSON(strings.NewReader(`[{"name":"requestProviderLink","type":"function","inputs":[{"name":"operator","type":"string"}],"outputs":[{"name":"ok","type":"bool"}]}]`))
 require.NoError(t, err)
 input, err := api.Pack("requestProviderLink", sdk.AccAddress(caller.Bytes()).String())
 require.NoError(t, err)
 result, _, err := evm.Call(caller, outer, input, 12000000, uint256.NewInt(0))
 require.NoError(t, err, "parent succeeds")
 require.Len(t, result, 32)
 require.Zero(t, result[31], "child reverted")
 require.NoError(t, state.Commit())
 present, err := a.PolyStoreChainKeeper.PendingProviderLinks.Has(ctx, sdk.AccAddress(child.Bytes()).String())
 require.NoError(t, err)
 require.False(t, present, "caught child revert must discard native state")
}

func historicalLegacyProofBatchMethod(t *testing.T) abi.Method {
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

func TestHistoricalChildCryptoGas(t *testing.T) {
 for _, enough := range []bool{false,true} {
 t.Run(map[bool]string{false:"insufficient",true:"sufficient"}[enough],func(t *testing.T) {
 a, ctx := historicalNativePrecompileApp(t)
 require.NoError(t, a.PolyStoreChainKeeper.Params.Set(ctx, types.DefaultParams()))
 require.NoError(t, crypto_ffi.Init("../trusted_setup.txt"))
 raw, err := os.ReadFile("/tmp/polystore-254-execution/260-historical-evm-counterexamples/proof_admission_k8.json")
 require.NoError(t, err)
 var fixture struct { Root []byte `json:"root"`; Proofs []types.ChainedProof `json:"proofs"` }
 require.NoError(t, json.Unmarshal(raw, &fixture))
 require.Len(t, fixture.Proofs, 3)
 caller, outer := common.HexToAddress("0xaabb01"), common.HexToAddress("0xaabb03")
 provider := sdk.AccAddress(common.HexToAddress("0xaabb02").Bytes()).String()
 deal := types.Deal{Id: 1, Owner: sdk.AccAddress(outer.Bytes()).String(), Providers: []string{provider}, ManifestRoot: fixture.Root, TotalMdus: 3, WitnessMdus: 1, Size_: 1 << 20, RedundancyMode: 2, Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, EscrowBalance: sdkmath.NewInt(100), EndBlock: 100}
 require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(ctx, deal.Id, deal))
 type chunk struct { RangeStart, RangeLen uint64; Proof types.ChainedProof }
 chunks := make([]chunk, 3)
 for i, proof := range fixture.Proofs { chunks[i] = chunk{0,1024,proof} }
 method := historicalLegacyProofBatchMethod(t)
 packed, err := method.Inputs.Pack(deal.Id, provider, "file", uint64(1), chunks)
 require.NoError(t, err)
 input := append(append([]byte{},method.ID...),packed...)
 precompile, err := polystoreprecompile.New(&a.PolyStoreChainKeeper)
 require.NoError(t, err)
 gas := precompile.RequiredGas(input) + 3*500000 - 1
 if enough { gas = 4000000 }
 evm, state := historicalNativeEVM(t,a,ctx)
 state.SetCode(outer,historicalCallAndReturn(polystoreprecompile.Address,uint32(gas),false))
 result, _, err := evm.Call(caller,outer,input,12000000,uint256.NewInt(0))
 require.NoError(t,err,"outer call catches child outcome")
 require.Len(t,result,32)
 t.Logf("child gas=%d success=%d",gas,result[31])
 if enough { require.Equal(t,byte(1),result[31],"valid control succeeds with sufficient gas") } else { require.Zero(t,result[31],"child without the full cryptographic budget must fail") }
 require.NoError(t,state.Commit())
 updated,err := a.PolyStoreChainKeeper.Deals.Get(ctx,deal.Id)
 require.NoError(t,err)
 if enough { require.Equal(t,sdkmath.NewInt(97),updated.EscrowBalance) } else { require.Equal(t,deal.EscrowBalance,updated.EscrowBalance) }
 present,err := a.PolyStoreChainKeeper.ReceiptNoncesByDealFile.Has(ctx,collections.Join(deal.Id,"file"))
 require.NoError(t,err)
 require.Equal(t,enough,present)
 })
 }
}
