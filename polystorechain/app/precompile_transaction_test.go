package app

import (
	"bytes"
	"encoding/json"
	"math/big"
	"os"
	"testing"
	"time"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	sdkmath "cosmossdk.io/math"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
	polystoreprecompile "polystorechain/precompiles/polystore"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

// A signed Ethereum transaction goes through production ante validation,
// ApplyTransaction, the native-action journal and FinalizeBlock's gas meter.
// The legacy route is deliberately tested before v2 activation: it exercises
// the same shared verifier and gas boundary with a fixed nonconstant fixture.
func TestSignedEVMProofReceiptAndBlockGas(t *testing.T) {
	a := New(log.NewNopLogger(), dbm.NewMemDB(), nil, true, simtestutil.AppOptionsMap{"home": t.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID}, baseapp.SetChainID(SimAppChainID))
	key, err := crypto.HexToECDSA("0123456789012345678901234567890123456789012345678901234567890123")
	require.NoError(t, err)
	caller := crypto.PubkeyToAddress(key.PublicKey)
	owner := sdk.AccAddress(caller.Bytes())
	provider := sdk.AccAddress(common.HexToAddress("0xaabb02").Bytes()).String()
	valSet, err := simtestutil.CreateRandomValidatorSet()
	require.NoError(t, err)
	funds := sdkmath.NewInt(1000000000).Mul(sdkmath.NewInt(1000000000))
	genesis, err := simtestutil.GenesisStateWithValSet(a.AppCodec(), a.DefaultGenesis(), valSet,
		[]authtypes.GenesisAccount{authtypes.NewBaseAccount(owner, nil, 0, 0)},
		banktypes.Balance{Address: owner.String(), Coins: sdk.NewCoins(sdk.NewCoin("aatom", funds))})
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
		ConsensusParams: &cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: 64000000, MaxBytes: 2097152}}})
	require.NoError(t, err)
	require.NoError(t, crypto_ffi.Init("../trusted_setup.txt"))
	rawFixture, err := os.ReadFile("../x/polystorechain/keeper/testdata/proof_admission_k8.json")
	require.NoError(t, err)
	var fixture struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(t, json.Unmarshal(rawFixture, &fixture))
	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	deal := types.Deal{Id: 1, Owner: owner.String(), Providers: []string{provider}, ManifestRoot: fixture.Root,
		TotalMdus: 3, WitnessMdus: 1, Size_: 1 << 20, RedundancyMode: 2,
		Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, EscrowBalance: sdkmath.NewInt(100), EndBlock: 100,
		MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt()}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(setup, 1, deal))
	finalize := func(height int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
		response, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height, Hash: bytes.Repeat([]byte{byte(height)}, 32), Time: time.Unix(height, 0), ProposerAddress: valSet.Validators[0].Address, Txs: txs})
		require.NoError(t, err)
		var used uint64
		for _, tx := range response.TxResults {
			used += uint64(tx.GasUsed)
		}
		require.Equal(t, used, a.GetContextForFinalizeBlock(nil).BlockGasMeter().GasConsumed(), "block includes actual transaction gas")
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
	method := legacyProofBatchMethod(t)
	type chunk struct {
		RangeStart, RangeLen uint64
		Proof                types.ChainedProof
	}
	chunks := make([]chunk, len(fixture.Proofs))
	for i, proof := range fixture.Proofs {
		chunks[i] = chunk{RangeLen: 1024, Proof: proof}
	}
	packed, err := method.Inputs.Pack(deal.Id, provider, "file", uint64(1), chunks)
	require.NoError(t, err)
	input := append(append([]byte{}, method.ID...), packed...)
	precompile, err := polystoreprecompile.New(&a.PolyStoreChainKeeper)
	require.NoError(t, err)
	static := precompile.RequiredGas(input)
	price := big.NewInt(1000000000)
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
		return raw
	}
	// Enough gas for the static precompile work, but not its full crypto reserve.
	gas := uint64(4000000)
	lowGas := static + 3*keeper.ProofCryptoGas - 1
	for i, limit := range []uint64{lowGas, gas} {
		before := a.BankKeeper.GetBalance(query(), owner, "aatom").Amount
		result := finalize(int64(i+2), sign(uint64(i), limit)).TxResults[0]
		require.Zero(t, result.Code, result.Log)
		receipt, err := evmtypes.DecodeTxResponse(result.Data)
		require.NoError(t, err)
		require.Equal(t, receipt.GasUsed, uint64(result.GasUsed), "ABCI receipt includes native-action gas")
		require.GreaterOrEqual(t, receipt.GasUsed, static+3*keeper.ProofCryptoGas-1)
		after := a.BankKeeper.GetBalance(query(), owner, "aatom").Amount
		require.Equal(t, sdkmath.NewIntFromUint64(receipt.GasUsed).Mul(sdkmath.NewIntFromBigInt(price)), before.Sub(after), "charged EVM fee uses reconciled native gas")
		require.Equal(t, uint64(i+1), a.AuthKeeper.GetAccount(query(), owner).GetSequence())
		nonce, nonceErr := a.PolyStoreChainKeeper.ReceiptNoncesByDealFile.Get(query(), collections.Join(uint64(1), "file"))
		if i == 0 {
			require.Equal(t, "out of gas", receipt.VmError)
			require.Equal(t, limit, receipt.GasUsed)
			require.ErrorIs(t, nonceErr, collections.ErrNotFound)
			require.Empty(t, receipt.Logs)
		} else {
			require.Empty(t, receipt.VmError)
			require.NoError(t, nonceErr)
			require.Equal(t, uint64(1), nonce)
			require.Len(t, receipt.Logs, 1)
			require.Less(t, receipt.GasUsed, limit)
		}
		t.Logf("limit=%d static=%d crypto=%d receipt=%d block=%d", limit, static, 3*keeper.ProofCryptoGas, receipt.GasUsed, result.GasUsed)
	}
}
