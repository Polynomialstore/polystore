package app

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"cosmossdk.io/math"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	minttypes "github.com/cosmos/cosmos-sdk/x/mint/types"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

const oneShotV3CohortLimit = 128

var oneShotV3Benchmark struct {
	sync.Once
	fixture *oneShotV3Fixture
	count   int
	maxGas  int64
}

// BenchmarkRetrievalV3OneShotPipeline is a native-envelope chain-control
// ceiling, not the public EVM or delivered-service result. Each timed block
// opens one cohort and settles an equally sized mature cohort in production
// ACK-before-proof order, then one final block captures the last cohort's
// anchors. Signing, FinalizeBlock and Commit are timed; fixture construction,
// anchor warm-up, proof generation, consensus, RPC and fsync are not. Cohorts
// never bypass the current 128-open block guard.
func BenchmarkRetrievalV3OneShotPipeline(b *testing.B) {
	count := oneShotV3EnvInt(b, "POLYSTORE_RETRIEVAL_BENCH_SESSIONS", 128)
	require.Contains(b, []int{1, 8, 32, 64, 128, 256, 512, 1024}, count)
	maxGas := int64(oneShotV3EnvInt(b, "POLYSTORE_RETRIEVAL_BENCH_MAX_GAS", int(types.MaxRetrievalV2BlockGas)))
	require.Contains(b, []int64{types.MaxRetrievalV2BlockGas, types.MaxRetrievalActivationBlockGas}, maxGas)
	defaultCohort := min(count, oneShotV3CohortLimit)
	if maxGas == types.MaxRetrievalV2BlockGas {
		defaultCohort = min(count, 64)
	}
	cohort := oneShotV3EnvInt(b, "POLYSTORE_RETRIEVAL_BENCH_COHORT", defaultCohort)
	require.Contains(b, []int{1, 8, 32, 64, 96, 128}, cohort)
	require.LessOrEqual(b, cohort, count)
	require.Zero(b, count%cohort)
	oneShotV3Benchmark.Do(func() {
		oneShotV3Benchmark.fixture = newOneShotV3Fixture(b, count, maxGas)
		oneShotV3Benchmark.count = count
		oneShotV3Benchmark.maxGas = maxGas
	})
	require.Equal(b, oneShotV3Benchmark.count, count, "select N in a fresh process")
	require.Equal(b, oneShotV3Benchmark.maxGas, maxGas, "select max gas in a fresh process")
	f := oneShotV3Benchmark.fixture

	b.ReportAllocs()
	b.ResetTimer()
	b.StopTimer()
	var elapsed, signEncode time.Duration
	var gas, txBytes uint64
	for i := 0; i < b.N; i++ {
		a := f.restore(b)
		b.StartTimer()
		result := f.submit(b, a, cohort, maxGas)
		b.StopTimer()
		f.assertState(b, a)
		elapsed += result.elapsed
		signEncode += result.signEncode
		gas += result.gas
		txBytes += result.txBytes
		require.NoError(b, a.Close())
	}
	sessions := float64(b.N * count)
	b.ReportMetric(sessions/elapsed.Seconds(), "settled-sessions/s")
	b.ReportMetric(float64(elapsed.Nanoseconds())/sessions, "ns/session")
	b.ReportMetric(float64(signEncode.Nanoseconds())/sessions, "sign-encode-ns/session")
	b.ReportMetric(float64(gas)/sessions, "gas/session")
	b.ReportMetric(float64(txBytes)/sessions, "tx-B/session")
	b.ReportMetric(3, "txs/session")
	b.ReportMetric(float64(cohort), "opens/block")
	b.ReportMetric(float64(count/cohort+1), "blocks/op")
	b.ReportMetric(0, "failures/op")
}

func TestRetrievalV3OneShotPipelineControl(t *testing.T) {
	if testing.Short() {
		t.Skip("native proof control")
	}
	if runGenesisTestInFreshProcess(t) {
		return
	}
	f := newOneShotV3Fixture(t, 8, types.MaxRetrievalV2BlockGas)
	a := f.restore(t)
	defer a.Close()
	result := f.submit(t, a, 8, types.MaxRetrievalV2BlockGas)
	require.Len(t, result.responses, 2)
	f.assertState(t, a)
}

type oneShotV3Fixture struct {
	database        map[string][]byte
	payer           *secp256k1.PrivKey
	provider        *secp256k1.PrivKey
	dealID          uint64
	count           int
	height          int64
	initialPayerSeq uint64
	proofs          []*types.MsgSubmitRetrievalSessionProofBatchV3
	acks            []*types.MsgAcknowledgeRetrievalObligationV3
	root            []byte
	payerStake      math.Int
	providerStake   math.Int
	moduleStake     math.Int
	stakeSupply     math.Int
}

type oneShotV3Result struct {
	responses  []*abci.ResponseFinalizeBlock
	elapsed    time.Duration
	signEncode time.Duration
	gas        uint64
	txBytes    uint64
}

func oneShotV3EnvInt(tb testing.TB, name string, fallback int) int {
	tb.Helper()
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	require.NoError(tb, err)
	require.Positive(tb, parsed)
	return parsed
}

func oneShotV3Finalize(tb testing.TB, a *App, height, maxGas int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
	tb.Helper()
	response, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height,
		Hash: bytes.Repeat([]byte{byte(height)}, 32), Time: time.Unix(height, 0), Txs: txs})
	require.NoError(tb, err)
	require.Len(tb, response.TxResults, len(txs))
	var gas int64
	for _, result := range response.TxResults {
		require.Zero(tb, result.Code, result.Log)
		gas += result.GasUsed
	}
	require.LessOrEqual(tb, gas, maxGas)
	require.Equal(tb, uint64(gas), a.GetContextForFinalizeBlock(nil).BlockGasMeter().GasConsumed())
	_, err = a.Commit()
	require.NoError(tb, err)
	return response
}

func newOneShotV3Fixture(tb testing.TB, count int, maxGas int64) *oneShotV3Fixture {
	tb.Helper()
	require.NoError(tb, crypto_ffi.Init("../trusted_setup.txt"))
	rawFixture, err := os.ReadFile("../x/polystorechain/keeper/testdata/proof_admission_k8.json")
	require.NoError(tb, err)
	var proofFixture struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(tb, json.Unmarshal(rawFixture, &proofFixture))
	require.NotEmpty(tb, proofFixture.Proofs)

	f := &oneShotV3Fixture{count: count, dealID: 1, root: bytes.Clone(proofFixture.Root),
		payer:    secp256k1.GenPrivKeyFromSecret([]byte("retrieval v3 one-shot payer")),
		provider: secp256k1.GenPrivKeyFromSecret([]byte("retrieval v3 one-shot provider"))}
	payer := sdk.AccAddress(f.payer.PubKey().Address())
	provider := sdk.AccAddress(f.provider.PubKey().Address())
	owner := sdk.AccAddress(bytes.Repeat([]byte{0x41}, 20))
	accounts := []authtypes.GenesisAccount{
		authtypes.NewBaseAccount(payer, f.payer.PubKey(), 0, 0),
		authtypes.NewBaseAccount(provider, f.provider.PubKey(), 1, 0),
	}
	funds := int64(count) * 100
	balances := []banktypes.Balance{
		{Address: payer.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("aatom", int64(count)*100000), sdk.NewInt64Coin("stake", funds))},
		{Address: provider.String(), Coins: sdk.NewCoins(sdk.NewInt64Coin("aatom", int64(count)*100000))},
	}
	db := dbm.NewMemDB()
	a := retrievalNativeApp(tb, db)
	defer a.Close()
	valSet, err := simtestutil.CreateRandomValidatorSet()
	require.NoError(tb, err)
	genesis, err := simtestutil.GenesisStateWithValSet(a.AppCodec(), a.DefaultGenesis(), valSet, accounts, balances...)
	require.NoError(tb, err)
	var bank banktypes.GenesisState
	a.AppCodec().MustUnmarshalJSON(genesis[banktypes.ModuleName], &bank)
	bank.DenomMetadata = append(bank.DenomMetadata, banktypes.Metadata{Base: "aatom", Display: "atom", Name: "Atom", Symbol: "ATOM",
		DenomUnits: []*banktypes.DenomUnit{{Denom: "aatom", Exponent: 0}, {Denom: "atom", Exponent: 18}}})
	genesis[banktypes.ModuleName] = a.AppCodec().MustMarshalJSON(&bank)
	params := types.DefaultParams()
	params.RetrievalV2ActivationHeight = 1
	params.RetrievalV3ActivationHeight = 1
	params.BaseRetrievalFee = sdk.NewInt64Coin("stake", 3)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin("stake", 20)
	genesis[types.ModuleName] = a.AppCodec().MustMarshalJSON(&types.GenesisState{Params: params})
	mint := minttypes.DefaultGenesisState()
	mint.Minter.Inflation = math.LegacyZeroDec()
	mint.Params.InflationRateChange, mint.Params.InflationMin, mint.Params.InflationMax = math.LegacyZeroDec(), math.LegacyZeroDec(), math.LegacyZeroDec()
	genesis[minttypes.ModuleName] = a.AppCodec().MustMarshalJSON(mint)
	rawGenesis, err := json.Marshal(genesis)
	require.NoError(tb, err)
	_, err = a.InitChain(&abci.RequestInitChain{ChainId: SimAppChainID, AppStateBytes: rawGenesis,
		ConsensusParams: &cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: maxGas, MaxBytes: types.MaxRetrievalV2BlockBytes}}})
	require.NoError(tb, err)

	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	providers := make([]string, 12)
	slots := make([]*types.DealSlot, 12)
	for i := range providers {
		providers[i] = sdk.AccAddress(bytes.Repeat([]byte{byte(0x60 + i)}, 20)).String()
		if i == 0 {
			providers[i] = provider.String()
		}
		slots[i] = &types.DealSlot{Slot: uint32(i), Provider: providers[i], Status: types.SlotStatus_SLOT_STATUS_ACTIVE}
		require.NoError(tb, a.PolyStoreChainKeeper.Providers.Set(setup, providers[i], types.Provider{Address: providers[i], Status: "Active"}))
	}
	deal := types.Deal{Id: f.dealID, Owner: owner.String(), ManifestRoot: f.root,
		Size_: 64 * retrievalchallenge.DataBlobPayloadBytes, EndBlock: 20000, CurrentGen: 1,
		TotalMdus: 3, WitnessMdus: 1, RedundancyMode: 2,
		Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, Mode2Slots: slots,
		RetrievalPolicy: types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC},
		EscrowBalance:   math.ZeroInt(), MaxMonthlySpend: math.ZeroInt(), SpendWindowSpent: math.ZeroInt()}
	require.NoError(tb, a.PolyStoreChainKeeper.Deals.Set(setup, deal.Id, deal))
	setupDigest, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(tb, err)
	require.NoError(tb, a.PolyStoreChainKeeper.AdmittedDealGenerationsV3.Set(setup, deal.Id, types.DealGenerationAdmissionV3{
		DealId: deal.Id, Owner: deal.Owner, Generation: 1, PreviousPolyfsRoot: bytes.Repeat([]byte{0x60}, 32),
		PolyfsRoot: f.root, IntegrityRoot: bytes.Repeat([]byte{0x62}, 32), Size_: deal.Size_, TotalMdus: 3,
		WitnessMdus: 1, MetadataMdus: 2, UserMdus: 1, IntegrityLeafCount: 96, SetupDigest: setupDigest,
		Providers: providers, AcceptedSlotsMask: (1 << 12) - 1, ChainId: SimAppChainID,
	}))
	oneShotV3Finalize(tb, a, 1, maxGas)

	sequence := uint64(0)
	height := int64(2)
	for offset := 0; offset < count; offset += oneShotV3CohortLimit {
		end := min(offset+oneShotV3CohortLimit, count)
		txs := make([][]byte, 0, end-offset)
		for i := offset; i < end; i++ {
			msg := &types.MsgOpenRetrievalSessionV3Sponsored{Creator: payer.String(), DealId: deal.Id, Generation: 1,
				Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024},
				Nonce: uint64(i + 1), DeadlineHeight: uint64(height) + types.MaxRetrievalSessionTTL, MaxTotalFee: math.NewInt(23)}
			txs = append(txs, retrievalNativeSign(tb, a, f.payer, sequence, msg))
			sequence++
		}
		oneShotV3Finalize(tb, a, height, maxGas, txs...)
		height++
	}
	oneShotV3Finalize(tb, a, height, maxGas)
	f.height = height
	f.initialPayerSeq = sequence

	ctx := retrievalNativeQuery(tb, a)
	module := authtypes.NewModuleAddress(types.ModuleName)
	f.payerStake = a.BankKeeper.GetBalance(ctx, payer, "stake").Amount
	f.providerStake = a.BankKeeper.GetBalance(ctx, provider, "stake").Amount
	f.moduleStake = a.BankKeeper.GetBalance(ctx, module, "stake").Amount
	f.stakeSupply = a.BankKeeper.GetSupply(ctx, "stake").Amount
	var sessions []types.RetrievalSessionV3
	require.NoError(tb, a.PolyStoreChainKeeper.RetrievalSessionsV3.Walk(ctx, nil, func(_ []byte, session types.RetrievalSessionV3) (bool, error) {
		sessions = append(sessions, session)
		return false, nil
	}))
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Nonce < sessions[j].Nonce })
	require.Len(tb, sessions, count)
	blob := make([]byte, types.BLOB_SIZE)
	for i := 31; i < len(blob); i += 32 {
		blob[i] = byte(1 + (i/32)%251)
	}
	commitment, err := crypto_ffi.CommitReceivedBlob(blob)
	require.NoError(tb, err)
	require.Equal(tb, commitment, proofFixture.Proofs[0].BlobCommitment)
	for _, session := range sessions {
		challengeContext := oneShotV3ChallengeContext(tb, session)
		anchor, err := a.PolyStoreChainKeeper.ChallengeAnchors.Get(ctx, session.AnchorHeight)
		require.NoError(tb, err)
		seed, err := challengeContext.Seed(anchor.Seed)
		require.NoError(tb, err)
		challenges, err := challengeContext.Challenges(seed[:])
		require.NoError(tb, err)
		require.Len(tb, challenges, 1)
		require.Zero(tb, challenges[0].Slot)
		proof := proofFixture.Proofs[0]
		proof.ZValue = bytes.Clone(challenges[0].Z[:])
		proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(blob, proof.ZValue)
		require.NoError(tb, err)
		f.proofs = append(f.proofs, &types.MsgSubmitRetrievalSessionProofBatchV3{Creator: provider.String(),
			Sessions: []types.RetrievalSessionProofBatchEntryV3{{SessionId: session.SessionId, Slot: 0,
				Proofs: []types.RetrievalSampleProofV3{{Ordinal: challenges[0].Ordinal, Proof: proof}}}}})
		f.acks = append(f.acks, &types.MsgAcknowledgeRetrievalObligationV3{Creator: payer.String(), SessionId: session.SessionId,
			Slot: 0, AckDigest: oneShotV3AckDigest(tb, session, 0)})
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

func (f *oneShotV3Fixture) restore(tb testing.TB) *App {
	tb.Helper()
	db := dbm.NewMemDB()
	for key, value := range f.database {
		require.NoError(tb, db.Set([]byte(key), bytes.Clone(value)))
	}
	a := retrievalNativeApp(tb, db)
	require.Equal(tb, f.height, a.LastBlockHeight())
	return a
}

func (f *oneShotV3Fixture) submit(tb testing.TB, a *App, cohort int, maxGas int64) oneShotV3Result {
	tb.Helper()
	result := oneShotV3Result{}
	started := time.Now()
	payerSeq, providerSeq := f.initialPayerSeq, uint64(0)
	for offset := 0; offset < f.count; offset += cohort {
		end := min(offset+cohort, f.count)
		height := f.height + 1 + int64(len(result.responses))
		txs := make([][]byte, 0, 3*(end-offset))
		signStarted := time.Now()
		for i := offset; i < end; i++ {
			open := &types.MsgOpenRetrievalSessionV3Sponsored{Creator: f.acks[i].Creator, DealId: f.dealID, Generation: 1,
				Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024},
				Nonce: uint64(f.count + i + 1), DeadlineHeight: uint64(height) + types.MaxRetrievalSessionTTL,
				MaxTotalFee: math.NewInt(23)}
			txs = append(txs, retrievalNativeSign(tb, a, f.payer, payerSeq, open))
			payerSeq++
			txs = append(txs, retrievalNativeSign(tb, a, f.payer, payerSeq, f.acks[i]))
			payerSeq++
			txs = append(txs, retrievalNativeSign(tb, a, f.provider, providerSeq, f.proofs[i]))
			providerSeq++
		}
		result.signEncode += time.Since(signStarted)
		response := oneShotV3Finalize(tb, a, height, maxGas, txs...)
		result.responses = append(result.responses, response)
		for txIndex, tx := range txs {
			result.gas += uint64(response.TxResults[txIndex].GasUsed)
			result.txBytes += uint64(len(tx))
		}
		result.elapsed = time.Since(started)
	}
	result.responses = append(result.responses,
		oneShotV3Finalize(tb, a, f.height+1+int64(len(result.responses)), maxGas))
	result.elapsed = time.Since(started)
	return result
}

func (f *oneShotV3Fixture) assertState(tb testing.TB, a *App) {
	tb.Helper()
	ctx := retrievalNativeQuery(tb, a)
	completed, open := 0, 0
	require.NoError(tb, a.PolyStoreChainKeeper.RetrievalSessionsV3.Walk(ctx, nil, func(_ []byte, session types.RetrievalSessionV3) (bool, error) {
		mask := uint32(0)
		for _, obligation := range session.Obligations {
			mask |= 1 << obligation.Slot
		}
		switch {
		case mask != 0 && session.AckedSlotsMask == mask && session.SettledSlotsMask == mask && session.LockedFee.IsZero():
			completed++
		case session.AckedSlotsMask == 0 && session.SettledSlotsMask == 0 && session.RefundedSlotsMask == 0 && session.LockedFee.IsPositive():
			open++
		default:
			tb.Fatalf("unexpected one-shot session masks ack=%d settled=%d refunded=%d locked=%s", session.AckedSlotsMask, session.SettledSlotsMask, session.RefundedSlotsMask, session.LockedFee)
		}
		return false, nil
	}))
	require.Equal(tb, f.count, completed)
	require.Equal(tb, f.count, open)
	live, err := a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(tb, err)
	require.Equal(tb, uint64(f.count), live)
	count := int64(f.count)
	payer := sdk.AccAddress(f.payer.PubKey().Address())
	provider := sdk.AccAddress(f.provider.PubKey().Address())
	module := authtypes.NewModuleAddress(types.ModuleName)
	require.Equal(tb, f.payerStake.SubRaw(23*count), a.BankKeeper.GetBalance(ctx, payer, "stake").Amount)
	require.Equal(tb, f.providerStake.AddRaw(19*count), a.BankKeeper.GetBalance(ctx, provider, "stake").Amount)
	require.Equal(tb, f.moduleStake, a.BankKeeper.GetBalance(ctx, module, "stake").Amount)
	require.Equal(tb, f.stakeSupply.SubRaw(4*count), a.BankKeeper.GetSupply(ctx, "stake").Amount)
	require.Equal(tb, f.initialPayerSeq+uint64(2*f.count), a.AuthKeeper.GetAccount(ctx, sdk.AccAddress(f.payer.PubKey().Address())).GetSequence())
	require.Equal(tb, uint64(f.count), a.AuthKeeper.GetAccount(ctx, sdk.AccAddress(f.provider.PubKey().Address())).GetSequence())
}

func oneShotV3ChallengeContext(tb testing.TB, s types.RetrievalSessionV3) retrievalchallenge.ContextV3 {
	tb.Helper()
	var setup, id, root, integrity, plan [32]byte
	copy(setup[:], s.SetupDigest)
	copy(id[:], s.SessionId)
	copy(root[:], s.PolyfsRoot)
	copy(integrity[:], s.IntegrityRoot)
	copy(plan[:], s.PlanHash)
	owner, err := sdk.AccAddressFromBech32(s.Owner)
	require.NoError(tb, err)
	payer, err := sdk.AccAddressFromBech32(s.Payer)
	require.NoError(tb, err)
	var owner20, payer20 [20]byte
	copy(owner20[:], owner)
	copy(payer20[:], payer)
	c := retrievalchallenge.ContextV3{ChainID: s.ChainId, SetupDigest: setup, SessionID: id, SessionOwner: owner20,
		DealID: s.DealId, Generation: s.Generation, PolyFSRoot: root, IntegrityRoot: integrity,
		FileRecordIndex: s.FileRecordIndex, FileStartOffset: s.FileStartOffset, FileLength: s.FileLength,
		RangeStart: s.RangeStart, RangeLength: s.RangeLength, MetadataMDUs: s.MetadataMdus, UserMDUs: s.UserMdus,
		PlanHash: plan, Population: s.Population, SampleCount: s.SampleCount, Nonce: s.Nonce,
		PriceDenom: s.PriceDenom, PricePerBlob: s.PricePerBlob.String(), BaseFee: s.BaseFee.String(),
		CompletionBurnBPS: s.CompletionBurnBps, FundingKind: uint8(s.Funding), FundingPayer: payer20,
		Window:  retrievalchallenge.Window{Snapshot: s.SnapshotHeight, Anchor: s.AnchorHeight, First: s.FirstResponseHeight, Deadline: s.DeadlineHeight},
		DealEnd: s.DealEndHeight}
	hash, err := c.Hash()
	require.NoError(tb, err)
	require.Equal(tb, hash[:], s.ContextHash)
	return c
}

func oneShotV3AckDigest(tb testing.TB, session types.RetrievalSessionV3, slot uint32) []byte {
	tb.Helper()
	var obligation types.RetrievalObligationV3
	for _, candidate := range session.Obligations {
		if candidate.Slot == slot {
			obligation = candidate
			break
		}
	}
	assigned, err := sdk.AccAddressFromBech32(obligation.AssignedProvider)
	require.NoError(tb, err)
	payee, err := sdk.AccAddressFromBech32(obligation.Payee)
	require.NoError(tb, err)
	context := oneShotV3ChallengeContext(tb, session)
	var contextHash [32]byte
	copy(contextHash[:], session.ContextHash)
	var assigned20, payee20 [20]byte
	copy(assigned20[:], assigned)
	copy(payee20[:], payee)
	digest, err := (retrievalchallenge.ObligationAckV3{ChainID: session.ChainId, SessionID: context.SessionID,
		ContextHash: contextHash, PlanHash: context.PlanHash, Slot: slot, Assigned: assigned20, Payee: payee20,
		BlobCount: obligation.BlobCount, BilledEncodedBytes: obligation.BlobCount * retrievalchallenge.EncodedBlobBytes,
		IntegrityRoot: context.IntegrityRoot}).Hash()
	require.NoError(tb, err)
	return digest[:]
}
