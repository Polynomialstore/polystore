package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log"
	sdkmath "cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	minttypes "github.com/cosmos/cosmos-sdk/x/mint/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

const retrievalNativeTxFee = int64(10000)

// A committed IAVL database image gives each comparison the identical funded,
// confirmed sessions and account sequences. Reload does not rerun EVM genesis,
// which seals process-global coin configuration in the pinned dependency.
type retrievalNativeFixture struct {
	database    map[string][]byte
	key         *secp256k1.PrivKey
	proofs      []*types.MsgSubmitRetrievalSessionProof
	stakeSupply sdk.Coin
}

func retrievalNativeApp(tb testing.TB, db dbm.DB) *App {
	tb.Helper()
	return New(log.NewNopLogger(), db, nil, true, simtestutil.AppOptionsMap{
		"home": tb.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID,
	}, baseapp.SetChainID(SimAppChainID))
}

func retrievalNativeQuery(tb testing.TB, a *App) sdk.Context {
	tb.Helper()
	ctx, err := a.CreateQueryContextWithCheckHeader(0, false, false)
	require.NoError(tb, err)
	return ctx
}

func retrievalNativeFinalize(tb testing.TB, a *App, height int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
	tb.Helper()
	response, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height,
		Hash: bytes.Repeat([]byte{byte(height)}, 32), Time: time.Unix(height, 0), Txs: txs})
	require.NoError(tb, err)
	var gas uint64
	for _, result := range response.TxResults {
		require.GreaterOrEqual(tb, result.GasUsed, int64(0))
		gas += uint64(result.GasUsed)
	}
	require.LessOrEqual(tb, gas, uint64(types.MaxRetrievalV2BlockGas))
	require.Equal(tb, gas, a.GetContextForFinalizeBlock(nil).BlockGasMeter().GasConsumed())
	_, err = a.Commit()
	require.NoError(tb, err)
	return response
}

func retrievalNativeSign(tb testing.TB, a *App, key *secp256k1.PrivKey, sequence uint64, msgs ...sdk.Msg) []byte {
	tb.Helper()
	account := a.AuthKeeper.GetAccount(retrievalNativeQuery(tb, a), sdk.AccAddress(key.PubKey().Address()))
	// Cover deterministic ante/message overhead as well as the prepaid crypto.
	gas := uint64(len(msgs)) * (keeper.ProofCryptoGas + 200_000)
	require.LessOrEqual(tb, gas, uint64(types.MaxRetrievalV2BlockGas))
	config := a.TxConfig()
	builder := config.NewTxBuilder()
	require.NoError(tb, builder.SetMsgs(msgs...))
	builder.SetMemo("")
	builder.SetFeeAmount(sdk.NewCoins(sdk.NewInt64Coin("aatom", retrievalNativeTxFee)))
	builder.SetGasLimit(gas)
	mode, err := authsigning.APISignModeToInternal(config.SignModeHandler().DefaultMode())
	require.NoError(tb, err)
	require.NoError(tb, builder.SetSignatures(signing.SignatureV2{PubKey: key.PubKey(), Data: &signing.SingleSignatureData{SignMode: mode}, Sequence: sequence}))
	data := authsigning.SignerData{Address: sdk.AccAddress(key.PubKey().Address()).String(), ChainID: SimAppChainID, AccountNumber: account.GetAccountNumber(), Sequence: sequence, PubKey: key.PubKey()}
	signature, err := clienttx.SignWithPrivKey(context.Background(), mode, data, builder, key, config, sequence)
	require.NoError(tb, err)
	require.NoError(tb, builder.SetSignatures(signature))
	transaction := builder.GetTx()
	require.Empty(tb, transaction.GetMemo())
	signatures, err := transaction.GetSignaturesV2()
	require.NoError(tb, err)
	require.Len(tb, signatures, 1)
	raw, err := a.TxConfig().TxEncoder()(transaction)
	require.NoError(tb, err)
	require.LessOrEqual(tb, len(raw), types.MaxTransactionBytes)
	return raw
}

func newRetrievalNativeFixture(tb testing.TB, count int) *retrievalNativeFixture {
	tb.Helper()
	require.Contains(tb, []int{1, 8, 32, 64}, count)
	require.NoError(tb, crypto_ffi.Init("../trusted_setup.txt"))
	data, err := os.ReadFile("../x/polystorechain/keeper/testdata/proof_admission_k8.json")
	require.NoError(tb, err)
	var structure struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(tb, json.Unmarshal(data, &structure))
	// Reconstruct only leaf zero of the existing nonconstant 8 MiB fixture.
	// Its commitment check pins this small reconstruction to that maintained file.
	blob := make([]byte, types.BLOB_SIZE)
	for i := 31; i < len(blob); i += 32 {
		blob[i] = byte(1 + (i/32)%251)
	}
	commitment, err := crypto_ffi.CommitReceivedBlob(blob)
	require.NoError(tb, err)
	require.Equal(tb, structure.Proofs[0].BlobCommitment, commitment)

	f := &retrievalNativeFixture{key: secp256k1.GenPrivKeyFromSecret([]byte("retrieval multi-session submitter"))}
	signer := sdk.AccAddress(f.key.PubKey().Address())
	module := authtypes.NewModuleAddress(types.ModuleName)
	owners := make([]*secp256k1.PrivKey, count)
	accounts := []authtypes.GenesisAccount{authtypes.NewBaseAccount(signer, f.key.PubKey(), 0, 0)}
	balances := []banktypes.Balance{
		{Address: signer.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("aatom", 100000000))},
		{Address: module.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("stake", int64(count)*100))},
	}
	for i := range owners {
		owners[i] = secp256k1.GenPrivKeyFromSecret([]byte(fmt.Sprintf("retrieval multi-session owner %d", i)))
		address := sdk.AccAddress(owners[i].PubKey().Address())
		accounts = append(accounts, authtypes.NewBaseAccount(address, owners[i].PubKey(), uint64(i+1), 0))
		balances = append(balances, banktypes.Balance{Address: address.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("aatom", 1000000))})
	}
	db := dbm.NewMemDB()
	a := retrievalNativeApp(tb, db)
	defer func() { require.NoError(tb, a.Close()) }()
	valSet, err := simtestutil.CreateRandomValidatorSet()
	require.NoError(tb, err)
	genesis, err := simtestutil.GenesisStateWithValSet(a.AppCodec(), a.DefaultGenesis(), valSet, accounts, balances...)
	require.NoError(tb, err)
	var bank banktypes.GenesisState
	a.AppCodec().MustUnmarshalJSON(genesis[banktypes.ModuleName], &bank)
	bank.DenomMetadata = append(bank.DenomMetadata, banktypes.Metadata{Base: "aatom", Display: "atom", Name: "Atom", Symbol: "ATOM",
		DenomUnits: []*banktypes.DenomUnit{{Denom: "aatom", Exponent: 0, Aliases: []string{"uatom"}}, {Denom: "atom", Exponent: 18}}})
	genesis[banktypes.ModuleName] = a.AppCodec().MustMarshalJSON(&bank)
	params := types.DefaultParams()
	params.RetrievalV2ActivationHeight = 1
	params.BaseRetrievalFee = sdk.NewInt64Coin("stake", 3)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin("stake", 17)
	params.RetrievalBurnBps = 3333 // ceil(17 * 3333 / 10000) = 6, independently per session.
	genesis[types.ModuleName] = a.AppCodec().MustMarshalJSON(&types.GenesisState{Params: params})
	mint := minttypes.DefaultGenesisState()
	mint.Minter.Inflation = sdkmath.LegacyZeroDec()
	mint.Params.InflationRateChange, mint.Params.InflationMin, mint.Params.InflationMax = sdkmath.LegacyZeroDec(), sdkmath.LegacyZeroDec(), sdkmath.LegacyZeroDec()
	genesis[minttypes.ModuleName] = a.AppCodec().MustMarshalJSON(mint)
	rawGenesis, err := json.Marshal(genesis)
	require.NoError(tb, err)
	_, err = a.InitChain(&abci.RequestInitChain{ChainId: SimAppChainID, AppStateBytes: rawGenesis,
		ConsensusParams: &cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}}})
	require.NoError(tb, err)
	require.Equal(tb, storetypes.StoreTypeIAVL, a.CommitMultiStore().GetCommitKVStore(a.GetKey(types.StoreKey)).GetStoreType())
	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	require.NoError(tb, a.PolyStoreChainKeeper.Providers.Set(setup, signer.String(), types.Provider{Address: signer.String(), Status: "Active"}))
	for i, owner := range owners {
		deal := types.Deal{Id: uint64(i + 1), Owner: sdk.AccAddress(owner.PubKey().Address()).String(), Providers: []string{signer.String()},
			ManifestRoot: structure.Root, TotalMdus: 3, WitnessMdus: 1, Size_: 1 << 20, RedundancyMode: 2,
			Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4},
			Mode2Slots:   []*types.DealSlot{{Slot: 0, Provider: signer.String(), Status: types.SlotStatus_SLOT_STATUS_ACTIVE}}, EscrowBalance: sdkmath.NewInt(100), EndBlock: 100,
			MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt()}
		require.NoError(tb, a.PolyStoreChainKeeper.Deals.Set(setup, deal.Id, deal))
	}
	retrievalNativeFinalize(tb, a, 1)
	// Owners really sign their opens and confirmations; only the proof transaction
	// shares one submitter. Opening, challenge generation and ACK are untimed.
	var opens [][]byte
	for i, owner := range owners {
		opens = append(opens, retrievalNativeSign(tb, a, owner, 0, &types.MsgOpenRetrievalSession{
			Creator: sdk.AccAddress(owner.PubKey().Address()).String(), DealId: uint64(i + 1), Provider: signer.String(),
			ManifestRoot: structure.Root, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20, ChallengeVersion: 2,
		}))
	}
	for _, result := range retrievalNativeFinalize(tb, a, 2, opens...).TxResults {
		require.Zero(tb, result.Code, result.Log)
	}
	var sessions []types.RetrievalSession
	require.NoError(tb, a.PolyStoreChainKeeper.RetrievalSessions.Walk(retrievalNativeQuery(tb, a), nil, func(_ []byte, s types.RetrievalSession) (bool, error) {
		sessions = append(sessions, s)
		return false, nil
	}))
	require.Len(tb, sessions, count)
	var confirmations [][]byte
	for _, session := range sessions {
		owner := owners[session.DealId-1]
		confirmations = append(confirmations, retrievalNativeSign(tb, a, owner, 1, &types.MsgConfirmRetrievalSession{Creator: session.Owner, SessionId: session.SessionId}))
	}
	for _, result := range retrievalNativeFinalize(tb, a, 3, confirmations...).TxResults {
		require.Zero(tb, result.Code, result.Log)
	}
	ctx := retrievalNativeQuery(tb, a)
	f.stakeSupply = a.BankKeeper.GetSupply(ctx, "stake")
	for _, session := range sessions {
		confirmed, err := a.PolyStoreChainKeeper.RetrievalSessions.Get(ctx, session.SessionId)
		require.NoError(tb, err)
		require.Equal(tb, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED, confirmed.Status)
		challenge, err := types.RetrievalChallengeContext(session)
		require.NoError(tb, err)
		anchor, err := a.PolyStoreChainKeeper.ChallengeAnchors.Get(ctx, challenge.Window.Anchor)
		require.NoError(tb, err)
		require.Equal(tb, bytes.Repeat([]byte{3}, 32), anchor.Seed, "seed must be the actual committed H+1 ABCI hash")
		points, err := challenge.Challenges(anchor.Seed)
		require.NoError(tb, err)
		require.Len(tb, points, 1)
		require.Equal(tb, uint32(0), points[0].LeafIndex)
		proof := structure.Proofs[0]
		proof.ZValue = bytes.Clone(points[0].Z[:])
		proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(blob, proof.ZValue)
		require.NoError(tb, err)
		f.proofs = append(f.proofs, &types.MsgSubmitRetrievalSessionProof{Creator: signer.String(), SessionId: session.SessionId, Proofs: []types.ChainedProof{proof}})
	}
	f.database = make(map[string][]byte)
	iterator, err := db.Iterator(nil, nil)
	require.NoError(tb, err)
	defer iterator.Close()
	for ; iterator.Valid(); iterator.Next() {
		f.database[string(iterator.Key())] = bytes.Clone(iterator.Value())
	}
	require.NoError(tb, iterator.Error())
	return f
}

func (f *retrievalNativeFixture) restore(tb testing.TB) *App {
	tb.Helper()
	db := dbm.NewMemDB()
	for key, value := range f.database {
		require.NoError(tb, db.Set([]byte(key), bytes.Clone(value)))
	}
	a := retrievalNativeApp(tb, db)
	require.Equal(tb, int64(3), a.LastBlockHeight())
	return a
}

func retrievalNativeStore(tb testing.TB, a *App, ctx sdk.Context, name string, omitFeeDenom bool) map[string][]byte {
	tb.Helper()
	iterator := ctx.KVStore(a.GetKey(name)).Iterator(nil, nil)
	defer iterator.Close()
	out := make(map[string][]byte)
	for ; iterator.Valid(); iterator.Next() {
		// Bank balance, supply and reverse-index keys all include the denom.
		// aatom is used only by normal ante/distribution, never session funding.
		if omitFeeDenom && bytes.Contains(iterator.Key(), []byte("aatom")) {
			continue
		}
		out[string(iterator.Key())] = bytes.Clone(iterator.Value())
	}
	return out
}

func TestRetrievalMultiSessionSignedProofRollback(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
	}
	f := newRetrievalNativeFixture(t, 8)
	a := f.restore(t)
	defer a.Close()
	ctx := retrievalNativeQuery(t, a)
	moduleBefore := retrievalNativeStore(t, a, ctx, types.StoreKey, false)
	bankBefore := retrievalNativeStore(t, a, ctx, banktypes.StoreKey, true)
	signer := sdk.AccAddress(f.key.PubKey().Address())
	feeBefore := a.BankKeeper.GetBalance(ctx, signer, "aatom")
	sequence := a.AuthKeeper.GetAccount(ctx, signer).GetSequence()
	good := f.proofs[0]
	bad := *f.proofs[1]
	bad.Proofs = append([]types.ChainedProof(nil), bad.Proofs...)
	bad.Proofs[0].YValue = bytes.Clone(bad.Proofs[0].YValue)
	bad.Proofs[0].YValue[31] ^= 1 // canonical scalar; real crypto, not shape admission, must fail.
	encoded := retrievalNativeSign(t, a, f.key, sequence, good, &bad)
	callsBefore := runtime.NumCgoCall()
	failed := retrievalNativeFinalize(t, a, 4, encoded).TxResults[0]
	calls := runtime.NumCgoCall() - callsBefore
	require.NotZero(t, failed.Code, failed.Log)
	require.Contains(t, failed.Log, "message index: 1", "must execute the valid first message")
	require.Contains(t, failed.Log, "invalid retrieval proof")
	require.Equal(t, int64(2), calls, "both sessions reached their actual native batch verifier")
	require.GreaterOrEqual(t, failed.GasUsed, int64(2*keeper.ProofCryptoGas))
	ctx = retrievalNativeQuery(t, a)
	require.Equal(t, moduleBefore, retrievalNativeStore(t, a, ctx, types.StoreKey, false), "all session, payee pin, retention, credit and activity bytes roll back")
	require.Equal(t, bankBefore, retrievalNativeStore(t, a, ctx, banktypes.StoreKey, true), "application bank balances, supply and indexes roll back")
	require.Equal(t, feeBefore.Sub(sdk.NewInt64Coin("aatom", retrievalNativeTxFee)), a.BankKeeper.GetBalance(ctx, signer, "aatom"))
	require.Equal(t, sequence+1, a.AuthKeeper.GetAccount(ctx, signer).GetSequence())
	for _, event := range failed.Events {
		require.NotEqual(t, "burn", event.Type)
		for _, attribute := range event.Attributes {
			require.NotContains(t, attribute.Value, "stake", "application bank events must not escape")
			require.False(t, strings.Contains(attribute.Value, sdk.MsgTypeURL(good)))
		}
	}
	// Exact same valid first proof remains usable after rollback, paired with the
	// corrected second proof. Each independently burns 6 and pays 11 stake.
	beforeSupply := a.BankKeeper.GetSupply(ctx, "stake")
	accepted := retrievalNativeFinalize(t, a, 5, retrievalNativeSign(t, a, f.key, sequence+1, good, f.proofs[1])).TxResults[0]
	require.Zero(t, accepted.Code, accepted.Log)
	ctx = retrievalNativeQuery(t, a)
	require.Equal(t, sdk.NewInt64Coin("stake", 22), a.BankKeeper.GetBalance(ctx, signer, "stake"))
	require.Equal(t, beforeSupply.Sub(sdk.NewInt64Coin("stake", 12)), a.BankKeeper.GetSupply(ctx, "stake"))
	for _, msg := range []*types.MsgSubmitRetrievalSessionProof{good, f.proofs[1]} {
		session, err := a.PolyStoreChainKeeper.RetrievalSessions.Get(ctx, msg.SessionId)
		require.NoError(t, err)
		require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, session.Status)
		require.True(t, session.LockedFee.IsZero())
	}
}

// The operation is one committed block in both modes, containing either N
// independently signed transactions or one transaction with the same N messages.
// It measures local completion, without network propagation or block waiting.
type retrievalNativeResult struct {
	txs        [][]byte
	response   *abci.ResponseFinalizeBlock
	ffiCalls   int64
	elapsed    time.Duration
	signEncode time.Duration
}

func (f *retrievalNativeFixture) submit(tb testing.TB, a *App, count int, batched bool) retrievalNativeResult {
	tb.Helper()
	out := retrievalNativeResult{}
	start := time.Now()
	if batched {
		msgs := make([]sdk.Msg, count)
		for i := range msgs {
			msgs[i] = f.proofs[i]
		}
		out.txs = [][]byte{retrievalNativeSign(tb, a, f.key, 0, msgs...)}
	} else {
		for i := 0; i < count; i++ {
			out.txs = append(out.txs, retrievalNativeSign(tb, a, f.key, uint64(i), f.proofs[i]))
		}
	}
	out.signEncode = time.Since(start)
	before := runtime.NumCgoCall()
	out.response = retrievalNativeFinalize(tb, a, 4, out.txs...)
	out.ffiCalls = runtime.NumCgoCall() - before
	out.elapsed = time.Since(start)
	return out
}

func (f *retrievalNativeFixture) assertCompleted(tb testing.TB, a *App, count int, result retrievalNativeResult) uint64 {
	tb.Helper()
	var gas uint64
	for _, tx := range result.response.TxResults {
		require.Zero(tb, tx.Code, tx.Log)
		gas += uint64(tx.GasUsed)
	}
	require.Equal(tb, int64(count), result.ffiCalls, "one native PSB1 call per one-proof session; no cross-session aggregation")
	ctx := retrievalNativeQuery(tb, a)
	signer := sdk.AccAddress(f.key.PubKey().Address())
	require.Equal(tb, uint64(len(result.txs)), a.AuthKeeper.GetAccount(ctx, signer).GetSequence())
	require.Equal(tb, sdk.NewInt64Coin("aatom", 100000000-int64(len(result.txs))*retrievalNativeTxFee), a.BankKeeper.GetBalance(ctx, signer, "aatom"))
	require.Equal(tb, sdk.NewInt64Coin("stake", int64(count)*11), a.BankKeeper.GetBalance(ctx, signer, "stake"))
	require.Equal(tb, f.stakeSupply.Sub(sdk.NewInt64Coin("stake", int64(count)*6)), a.BankKeeper.GetSupply(ctx, "stake"))
	module := authtypes.NewModuleAddress(types.ModuleName)
	require.Equal(tb, sdk.NewInt64Coin("stake", int64(len(f.proofs))*97-int64(count)*17), a.BankKeeper.GetBalance(ctx, module, "stake"))
	for _, msg := range f.proofs[:count] {
		session, err := a.PolyStoreChainKeeper.RetrievalSessions.Get(ctx, msg.SessionId)
		require.NoError(tb, err)
		require.Equal(tb, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, session.Status)
		require.True(tb, session.LockedFee.IsZero())
		pinned, err := a.PolyStoreChainKeeper.RetrievalSessionProofProvider.Has(ctx, msg.SessionId)
		require.NoError(tb, err)
		require.False(tb, pinned, "settlement releases the accepted-proof payee pin")
		activity, err := a.PolyStoreChainKeeper.DealActivityStates.Get(ctx, session.DealId)
		require.NoError(tb, err)
		require.Equal(tb, uint64(1), activity.SuccessfulRetrievalsTotal)
	}
	return gas
}

func TestRetrievalMultiSessionTransactionMatrix(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
	}
	// Sixty-four independent messages exceed the canonical 64M block after SDK overhead.
	// The PSB2 64-proof message bound is covered by the keeper suite.
	f := newRetrievalNativeFixture(t, 32)
	for _, count := range []int{1, 8, 32} {
		t.Run(fmt.Sprintf("sessions%d", count), func(t *testing.T) {
			var moduleState, bankState map[string][]byte
			for _, batched := range []bool{false, true} {
				a := f.restore(t)
				result := f.submit(t, a, count, batched)
				f.assertCompleted(t, a, count, result)
				wantTransactions := count
				if batched {
					wantTransactions = 1
				}
				require.Len(t, result.txs, wantTransactions)
				ctx := retrievalNativeQuery(t, a)
				module := retrievalNativeStore(t, a, ctx, types.StoreKey, false)
				bank := retrievalNativeStore(t, a, ctx, banktypes.StoreKey, true)
				if !batched {
					moduleState, bankState = module, bank
				} else {
					require.Equal(t, moduleState, module, "transaction batching preserves all per-session accounting and indexes")
					require.Equal(t, bankState, bank, "fees round and settle independently for every session")
				}
				require.NoError(t, a.Close())
			}
		})
	}
}
