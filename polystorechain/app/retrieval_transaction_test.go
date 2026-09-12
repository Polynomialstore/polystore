package app

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"math/rand"
	"os"
	"os/exec"
	"regexp"
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
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// Exercise the production decoder, signature ante handler, message router, bank
// keeper and FinalizeBlock commit. A later message fails after the v2 open has
// burned its base fee and written its session, nonce and retention indexes.
func TestRetrievalSessionSignedTransactionRollback(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
	}
	key := secp256k1.GenPrivKeyFromSecret([]byte("retrieval transaction rollback owner"))
	a := newRetrievalTransactionApp(t, key)
	owner := sdk.AccAddress(key.PubKey().Address())
	provider := sdk.AccAddress(bytes.Repeat([]byte{0x23}, 20))
	module := authtypes.NewModuleAddress(types.ModuleName)
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

func TestGenerationV3SignedOwnerAuthority(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
	}
	ownerKey := secp256k1.GenPrivKeyFromSecret([]byte("generation v3 owner"))
	attackerKey := secp256k1.GenPrivKeyFromSecret([]byte("generation v3 attacker"))
	a := newRetrievalTransactionApp(t, ownerKey)
	defer func() { require.NoError(t, a.Close()) }()
	owner := sdk.AccAddress(ownerKey.PubKey().Address())
	attacker := sdk.AccAddress(attackerKey.PubKey().Address())
	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	account := a.AuthKeeper.NewAccountWithAddress(setup, attacker)
	a.AuthKeeper.SetAccount(setup, account)
	require.NoError(t, a.BankKeeper.SendCoins(setup, owner, attacker, sdk.NewCoins(sdk.NewInt64Coin("aatom", 100000))))
	retrievalNativeFinalize(t, a, 1)

	msg := &types.MsgProposeDealGenerationV3{Creator: owner.String(), DealId: 1}
	wrongSigner := retrievalNativeFinalize(t, a, 2, retrievalNativeSign(t, a, attackerKey, 0, msg)).TxResults[0]
	require.NotZero(t, wrongSigner.Code, wrongSigner.Log)
	require.Contains(t, wrongSigner.Log, "pubKey does not match signer address")
	require.NotContains(t, wrongSigner.Log, "retrieval v3 is not active", "wrong signer must fail before the message handler")

	ownerSigned := retrievalNativeFinalize(t, a, 3, retrievalNativeSign(t, a, ownerKey, 0, msg)).TxResults[0]
	require.NotZero(t, ownerSigned.Code, ownerSigned.Log)
	require.Contains(t, ownerSigned.Log, "retrieval v3 is not active", "authenticated owner reaches the disabled handler")
}

func TestRetrievalSessionV3SignedNativeAuthorityAndRollback(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
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
	ownerKey := secp256k1.GenPrivKeyFromSecret([]byte("retrieval v3 native owner"))
	attackerKey := secp256k1.GenPrivKeyFromSecret([]byte("retrieval v3 native attacker"))
	a := newRetrievalTransactionApp(t, ownerKey)
	defer func() { require.NoError(t, a.Close()) }()
	owner := sdk.AccAddress(ownerKey.PubKey().Address())
	attacker := sdk.AccAddress(attackerKey.PubKey().Address())
	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	a.AuthKeeper.SetAccount(setup, a.AuthKeeper.NewAccountWithAddress(setup, attacker))
	require.NoError(t, a.BankKeeper.SendCoins(setup, owner, attacker, sdk.NewCoins(sdk.NewInt64Coin("aatom", 100000))))

	providers := make([]string, 12)
	slots := make([]*types.DealSlot, 12)
	for i := range providers {
		provider := sdk.AccAddress(bytes.Repeat([]byte{byte(0x40 + i)}, 20)).String()
		if i == 0 {
			provider = owner.String()
		}
		providers[i] = provider
		slots[i] = &types.DealSlot{Slot: uint32(i), Provider: provider, Status: types.SlotStatus_SLOT_STATUS_ACTIVE}
		require.NoError(t, a.PolyStoreChainKeeper.Providers.Set(setup, provider, types.Provider{Address: provider, Status: "Active"}))
	}
	root := fixture.Root
	deal := types.Deal{Id: 1, Owner: owner.String(), ManifestRoot: root, Size_: 64 * 126976,
		EscrowBalance: sdkmath.NewInt(100), StartBlock: 1, EndBlock: 100, CurrentGen: 1,
		TotalMdus: 3, WitnessMdus: 1, RedundancyMode: 2,
		Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, Mode2Slots: slots,
		MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt()}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(setup, deal.Id, deal))
	setupDigest, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	require.NoError(t, a.PolyStoreChainKeeper.AdmittedDealGenerationsV3.Set(setup, deal.Id, types.DealGenerationAdmissionV3{
		DealId: deal.Id, Owner: deal.Owner, Generation: deal.CurrentGen,
		PreviousPolyfsRoot: bytes.Repeat([]byte{0x60}, 32), PolyfsRoot: root, IntegrityRoot: bytes.Repeat([]byte{0x62}, 32),
		Size_: deal.Size_, TotalMdus: deal.TotalMdus, WitnessMdus: deal.WitnessMdus, MetadataMdus: 2, UserMdus: 1,
		IntegrityLeafCount: 96, SetupDigest: setupDigest, Providers: providers, AcceptedSlotsMask: (1 << 12) - 1,
		ChainId: SimAppChainID,
	}))
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalV3ActivatedHeight.Set(setup, 1))
	retrievalNativeFinalize(t, a, 1)

	open := &types.MsgOpenRetrievalSessionV3{Creator: owner.String(), DealId: deal.Id, Generation: deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024}, Nonce: 1, DeadlineHeight: 20}
	wrongSigner := retrievalNativeFinalize(t, a, 2, retrievalNativeSign(t, a, attackerKey, 0, open)).TxResults[0]
	require.NotZero(t, wrongSigner.Code, wrongSigner.Log)
	require.Contains(t, wrongSigner.Log, "pubKey does not match signer address")

	accepted := retrievalNativeFinalize(t, a, 3, retrievalNativeSign(t, a, ownerKey, 0, open)).TxResults[0]
	require.Zero(t, accepted.Code, accepted.Log)
	ctx := retrievalNativeQuery(t, a)
	updated, err := a.PolyStoreChainKeeper.Deals.Get(ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, sdkmath.NewInt(90), updated.EscrowBalance)
	count := 0
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessionsV3.Walk(ctx, nil, func(_ []byte, _ types.RetrievalSessionV3) (bool, error) { count++; return false, nil }))
	require.Equal(t, 1, count)

	rollbackOpen := *open
	rollbackOpen.Nonce = 2
	laterFailure := &banktypes.MsgSend{FromAddress: owner.String(), ToAddress: providers[1], Amount: sdk.NewCoins(sdk.NewInt64Coin("stake", 2000000))}
	failed := retrievalNativeFinalize(t, a, 4, retrievalNativeSign(t, a, ownerKey, 1, &rollbackOpen, laterFailure)).TxResults[0]
	require.NotZero(t, failed.Code, failed.Log)
	require.Contains(t, failed.Log, "insufficient funds")
	ctx = retrievalNativeQuery(t, a)
	updated, err = a.PolyStoreChainKeeper.Deals.Get(ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, sdkmath.NewInt(90), updated.EscrowBalance)
	count = 0
	require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessionsV3.Walk(ctx, nil, func(_ []byte, _ types.RetrievalSessionV3) (bool, error) { count++; return false, nil }))
	require.Equal(t, 1, count)
	present, err := a.PolyStoreChainKeeper.RetrievalSessionV3NonceIDs.Has(ctx, collections.Join(collections.Join(owner.String(), deal.Id), uint64(2)))
	require.NoError(t, err)
	require.False(t, present)

	// Accept a real proof, then fail a later message after the terminal ACK has
	// paid and released its references. SDK transaction caching must undo all of it.
	id, err := a.PolyStoreChainKeeper.RetrievalSessionV3NonceIDs.Get(ctx, collections.Join(collections.Join(owner.String(), deal.Id), uint64(1)))
	require.NoError(t, err)
	session, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, id)
	require.NoError(t, err)
	anchor, err := a.PolyStoreChainKeeper.ChallengeAnchors.Get(ctx, session.AnchorHeight)
	require.NoError(t, err)
	challengeContext := appChallengeContextV3(t, session)
	seed, err := challengeContext.Seed(anchor.Seed)
	require.NoError(t, err)
	challenges, err := challengeContext.Challenges(seed[:])
	require.NoError(t, err)
	require.Len(t, challenges, 1)
	require.Zero(t, challenges[0].Slot)
	require.Zero(t, challenges[0].LeafIndex)
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
	proved := retrievalNativeFinalize(t, a, 5, retrievalNativeSign(t, a, ownerKey, 2,
		&types.MsgSubmitRetrievalSessionProofV3{Creator: owner.String(), SessionId: id, Slot: 0,
			Proofs: []types.RetrievalSampleProofV3{{Ordinal: challenges[0].Ordinal, Proof: proof}}})).TxResults[0]
	require.Zero(t, proved.Code, proved.Log)
	ctx = retrievalNativeQuery(t, a)
	beforeACK, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, byte(1), beforeACK.AcceptedSampleBitmap[0]&1)
	require.Zero(t, beforeACK.SettledSlotsMask)
	module := authtypes.NewModuleAddress(types.ModuleName)
	beforeModule := a.BankKeeper.GetBalance(ctx, module, "stake")
	beforeOwner := a.BankKeeper.GetBalance(ctx, owner, "stake")
	beforeSupply := a.BankKeeper.GetSupply(ctx, "stake")
	var contextHash [32]byte
	copy(contextHash[:], session.ContextHash)
	ackDigest, err := (retrievalchallenge.ObligationAckV3{
		ChainID: session.ChainId, SessionID: challengeContext.SessionID, ContextHash: contextHash,
		PlanHash: challengeContext.PlanHash, Slot: 0, Assigned: challengeContext.SessionOwner, Payee: challengeContext.SessionOwner,
		BlobCount: session.Obligations[0].BlobCount, BilledEncodedBytes: session.Obligations[0].BlobCount * retrievalchallenge.EncodedBlobBytes,
		IntegrityRoot: challengeContext.IntegrityRoot,
	}).Hash()
	require.NoError(t, err)
	ack := &types.MsgAcknowledgeRetrievalObligationV3{Creator: owner.String(), SessionId: id, Slot: 0, AckDigest: ackDigest[:]}
	failed = retrievalNativeFinalize(t, a, 6, retrievalNativeSign(t, a, ownerKey, 3, ack, laterFailure)).TxResults[0]
	require.NotZero(t, failed.Code, failed.Log)
	require.Contains(t, failed.Log, "insufficient funds", "terminal ACK must reach the later bank message")
	ctx = retrievalNativeQuery(t, a)
	stored, err := a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, id)
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
	expiry, err := a.PolyStoreChainKeeper.RetrievalSessionExpiryRefs.Has(ctx, collections.Join(session.DeadlineHeight, id))
	require.NoError(t, err)
	require.True(t, expiry)
	terminal, err := a.PolyStoreChainKeeper.RetrievalSessionV3TerminalAnchors.Has(ctx, id)
	require.NoError(t, err)
	require.False(t, terminal)
	require.Equal(t, beforeModule, a.BankKeeper.GetBalance(ctx, module, "stake"))
	require.Equal(t, beforeOwner, a.BankKeeper.GetBalance(ctx, owner, "stake"))
	require.Equal(t, beforeSupply, a.BankKeeper.GetSupply(ctx, "stake"))
	require.Equal(t, uint64(4), a.AuthKeeper.GetAccount(ctx, owner).GetSequence(), "failed message preserves ante sequence")
	completed := retrievalNativeFinalize(t, a, 7, retrievalNativeSign(t, a, ownerKey, 4, ack)).TxResults[0]
	require.Zero(t, completed.Code, completed.Log)
	ctx = retrievalNativeQuery(t, a)
	stored, err = a.PolyStoreChainKeeper.RetrievalSessionsV3.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, uint32(1), stored.SettledSlotsMask)
	live, err = a.PolyStoreChainKeeper.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Zero(t, live)
	terminalSeed, err := a.PolyStoreChainKeeper.RetrievalSessionV3TerminalAnchors.Get(ctx, id)
	require.NoError(t, err)
	require.Equal(t, anchor.Seed, terminalSeed)
	expiry, err = a.PolyStoreChainKeeper.RetrievalSessionExpiryRefs.Has(ctx, collections.Join(session.DeadlineHeight, id))
	require.NoError(t, err)
	require.False(t, expiry)
	_, err = a.PolyStoreChainKeeper.RetrievalSessionGenerationRefs.Get(ctx, collections.Join(session.DealId, session.Generation))
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = a.PolyStoreChainKeeper.ChallengeAnchors.Get(ctx, session.AnchorHeight)
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.True(t, a.BankKeeper.GetBalance(ctx, owner, "stake").Amount.GT(beforeOwner.Amount))
}

// Pinned cosmos/evm seals process-global coin configuration at InitGenesis.
// Keep production configuration intact and give each full-genesis test its own
// process; the other app tests intentionally initialize only individual modules.
func runGenesisTestInFreshProcess(t *testing.T) bool {
	t.Helper()
	if os.Getenv("POLYSTORE_GENESIS_TEST_CHILD") == t.Name() {
		return false
	}
	binary, err := os.Executable()
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-test.run=^"+regexp.QuoteMeta(t.Name())+"$", "-test.count=1", "-test.v")
	cmd.Env = append(os.Environ(), "POLYSTORE_GENESIS_TEST_CHILD="+t.Name())
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s", output)
	t.Logf("%s", output)
	return true
}

// Shared full-genesis setup for signed retrieval transaction regressions.
func newRetrievalTransactionApp(t *testing.T, key *secp256k1.PrivKey) *App {
	t.Helper()
	a := New(log.NewNopLogger(), dbm.NewMemDB(), nil, true, simtestutil.AppOptionsMap{"home": t.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID}, baseapp.SetChainID(SimAppChainID))
	owner := sdk.AccAddress(key.PubKey().Address())
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
	return a
}
