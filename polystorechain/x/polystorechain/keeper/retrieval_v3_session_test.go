package keeper_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"os"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

type cryptoSessionV3Fixture struct {
	g           generationV3Fixture
	session     types.RetrievalSessionV3
	mduData     []byte
	witnessFlat []byte
	shards      [][]byte
	mduRoot     []byte
	rootDU      []byte
	rootDUPath  [][]byte
	rootOpening []byte
}

func openOwnerSessionV3(t *testing.T) (generationV3Fixture, types.RetrievalSessionV3) {
	return openOwnerSessionV3WithPrice(t, 3)
}

func setupAdmittedSessionV3(t *testing.T, price int64) generationV3Fixture {
	t.Helper()
	g := setupGenerationV3(t)
	activateGenerationV3(t, g)
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	g.deal.EscrowBalance = math.NewInt(100)
	require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
	g.bank.moduleBalances[types.ModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100))
	params := g.fixture.keeper.GetParams(g.ctx)
	params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, price)
	params.RetrievalBurnBps = 250
	require.NoError(t, g.fixture.keeper.Params.Set(g.ctx, params))
	require.NoError(t, g.fixture.keeper.StorageAuditEpochLength.Set(g.ctx, params.EpochLenBlocks))
	require.NoError(t, g.fixture.keeper.AdmittedDealGenerationsV3.Set(g.ctx, g.deal.Id, types.DealGenerationAdmissionV3{
		DealId: g.deal.Id, Owner: g.owner, Generation: g.deal.CurrentGen,
		PreviousPolyfsRoot: bytes.Repeat([]byte{0x30}, 32), PolyfsRoot: append([]byte(nil), g.deal.ManifestRoot...),
		IntegrityRoot: bytes.Repeat([]byte{0x32}, 32), Size_: g.deal.Size_, TotalMdus: g.deal.TotalMdus,
		WitnessMdus: g.deal.WitnessMdus, MetadataMdus: 2, UserMdus: 1, IntegrityLeafCount: 96,
		SetupDigest: setup, Providers: append([]string(nil), g.providers...), AcceptedSlotsMask: (1 << 12) - 1,
		ChainId: g.ctx.ChainID(),
	}))
	return g
}

func openOwnerSessionV3WithPrice(t *testing.T, price int64) (generationV3Fixture, types.RetrievalSessionV3) {
	t.Helper()
	g := setupAdmittedSessionV3(t, price)
	response, err := g.server.OpenRetrievalSessionV3(g.ctx, &types.MsgOpenRetrievalSessionV3{
		Creator: g.owner, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024},
		Nonce: 1, DeadlineHeight: 20,
	})
	require.NoError(t, err)
	session, err := g.fixture.keeper.RetrievalSessionsV3.Get(g.ctx, response.SessionId)
	require.NoError(t, err)
	return g, session
}

func ackDigestV3(t *testing.T, session types.RetrievalSessionV3, slot uint32) []byte {
	t.Helper()
	var obligation types.RetrievalObligationV3
	for _, candidate := range session.Obligations {
		if candidate.Slot == slot {
			obligation = candidate
			break
		}
	}
	assigned, err := sdk.AccAddressFromBech32(obligation.AssignedProvider)
	require.NoError(t, err)
	payee, err := sdk.AccAddressFromBech32(obligation.Payee)
	require.NoError(t, err)
	var sid, contextHash, planHash, integrity [32]byte
	var assignedRaw, payeeRaw [20]byte
	copy(sid[:], session.SessionId)
	copy(contextHash[:], session.ContextHash)
	copy(planHash[:], session.PlanHash)
	copy(integrity[:], session.IntegrityRoot)
	copy(assignedRaw[:], assigned)
	copy(payeeRaw[:], payee)
	digest, err := (retrievalchallenge.ObligationAckV3{
		ChainID: session.ChainId, SessionID: sid, ContextHash: contextHash, PlanHash: planHash,
		Slot: slot, Assigned: assignedRaw, Payee: payeeRaw, BlobCount: obligation.BlobCount,
		BilledEncodedBytes: obligation.BlobCount * retrievalchallenge.EncodedBlobBytes, IntegrityRoot: integrity,
	}).Hash()
	require.NoError(t, err)
	return digest[:]
}

func challengeContextV3(t *testing.T, s types.RetrievalSessionV3) retrievalchallenge.ContextV3 {
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

func openCryptoSessionV3(t *testing.T, length uint64) cryptoSessionV3Fixture {
	t.Helper()
	t.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt")
	}
	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))

	g := setupGenerationV3(t)
	activateGenerationV3(t, g)
	mduData := make([]byte, 8*1024*1024)
	for i := 31; i < len(mduData); i += 32 {
		mduData[i] = byte(1 + (i/32)%251)
	}
	witness, shards, err := crypto_ffi.ExpandMduRs(mduData, 8, 4)
	require.NoError(t, err)
	mduRoot, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witness)
	require.NoError(t, err)
	_, mdu0 := benchBuildPolyFSMdu0(t, map[uint64][]byte{benchTargetMduIndex: mduRoot})
	polyfsRoot, err := crypto_ffi.ComputeMduMerkleRoot(mdu0)
	require.NoError(t, err)
	rootDU, rootDUPath, rootOpening := benchMdu0RootTableProof(t, mdu0, benchTargetMduIndex, mduRoot)

	g.deal.ManifestRoot = polyfsRoot
	g.deal.Size_ = 64 * retrievalchallenge.DataBlobPayloadBytes
	g.deal.TotalMdus = 3
	g.deal.WitnessMdus = 1
	g.deal.EscrowBalance = math.NewInt(100)
	require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
	g.bank.moduleBalances[types.ModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100))
	params := g.fixture.keeper.GetParams(g.ctx)
	params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 3)
	params.RetrievalBurnBps = 250
	require.NoError(t, g.fixture.keeper.Params.Set(g.ctx, params))
	require.NoError(t, g.fixture.keeper.StorageAuditEpochLength.Set(g.ctx, params.EpochLenBlocks))
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	require.NoError(t, g.fixture.keeper.AdmittedDealGenerationsV3.Set(g.ctx, g.deal.Id, types.DealGenerationAdmissionV3{
		DealId: g.deal.Id, Owner: g.owner, Generation: g.deal.CurrentGen,
		PreviousPolyfsRoot: bytes.Repeat([]byte{0x30}, 32), PolyfsRoot: polyfsRoot,
		IntegrityRoot: bytes.Repeat([]byte{0x32}, 32), Size_: g.deal.Size_, TotalMdus: g.deal.TotalMdus,
		WitnessMdus: 1, MetadataMdus: 2, UserMdus: 1, IntegrityLeafCount: 96,
		SetupDigest: setup, Providers: append([]string(nil), g.providers...), AcceptedSlotsMask: (1 << 12) - 1,
		ChainId: g.ctx.ChainID(),
	}))
	opened, err := g.server.OpenRetrievalSessionV3(g.ctx, &types.MsgOpenRetrievalSessionV3{
		Creator: g.owner, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: length, RangeLength: length},
		Nonce: 1, DeadlineHeight: 20,
	})
	require.NoError(t, err)
	session, err := g.fixture.keeper.RetrievalSessionsV3.Get(g.ctx, opened.SessionId)
	require.NoError(t, err)
	return cryptoSessionV3Fixture{g, session, mduData, witness, shards, mduRoot, rootDU, rootDUPath, rootOpening}
}

func (f cryptoSessionV3Fixture) proof(t *testing.T, challenge retrievalchallenge.ChallengeV3) types.RetrievalSampleProofV3 {
	t.Helper()
	leaf := uint64(challenge.LeafIndex)
	blob := benchBlobBytesForLeaf(t, f.mduData, f.shards, 8, leaf/8, leaf%8)
	proof, y, err := crypto_ffi.ComputeBlobProof(blob, challenge.Z[:])
	require.NoError(t, err)
	commitment := append([]byte(nil), f.witnessFlat[leaf*48:(leaf+1)*48]...)
	return types.RetrievalSampleProofV3{Ordinal: challenge.Ordinal, Proof: types.ChainedProof{
		MduIndex: challenge.MDUIndex, MduRootFr: append([]byte(nil), f.mduRoot...),
		ManifestOpening: append([]byte(nil), f.rootOpening...), RootTableDuCommitment: append([]byte(nil), f.rootDU...),
		RootTableDuMerklePath: f.rootDUPath, BlobCommitment: commitment,
		MerklePath: benchMerklePathFromWitnessFlat(t, f.witnessFlat, leaf), BlobIndex: challenge.LeafIndex,
		ZValue: append([]byte(nil), challenge.Z[:]...), YValue: y, KzgOpeningProof: proof,
	}}
}

func TestRetrievalSessionV3AckRequiresCommittedAnchor(t *testing.T) {
	g, session := openOwnerSessionV3(t)
	before := sessionStoreSnapshot(t, g.ctx, g.fixture.storeService)
	_, err := g.server.AcknowledgeRetrievalObligationV3(g.ctx, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: g.owner, SessionId: session.SessionId, Slot: session.Obligations[0].Slot,
		AckDigest: ackDigestV3(t, session, session.Obligations[0].Slot),
	})
	require.ErrorContains(t, err, "outside v3 session response window")
	require.Equal(t, before, sessionStoreSnapshot(t, g.ctx, g.fixture.storeService))
	stored, err := g.fixture.keeper.RetrievalSessionsV3.Get(g.ctx, session.SessionId)
	require.NoError(t, err)
	require.Zero(t, stored.AckedSlotsMask)
	require.Zero(t, stored.SettledSlotsMask)
	require.Zero(t, stored.Obligations[0].SampleCount)
}

func TestRetrievalSessionV3RealProofAckSettlementAndReplay(t *testing.T) {
	f := openCryptoSessionV3(t, 1024)
	seed := sha256.Sum256([]byte("v3-real-proof-anchor"))
	_, err := f.g.fixture.keeper.ChallengeAnchors.Get(f.g.ctx, 3)
	require.NoError(t, err)
	_, err = f.g.fixture.keeper.RetrievalSessionOpenCounts.Get(f.g.ctx, 2)
	require.NoError(t, err)
	_, err = f.g.fixture.keeper.StorageAuditEpochLength.Get(f.g.ctx)
	require.NoError(t, err)
	_, err = f.g.fixture.keeper.RetrievalSessionLiveCount.Get(f.g.ctx)
	require.NoError(t, err)
	_, err = f.g.fixture.keeper.RetrievalSessionGenerationCount.Get(f.g.ctx)
	require.NoError(t, err)
	pending, err := f.g.fixture.keeper.ChallengePendingAnchors.Has(f.g.ctx, 3)
	require.NoError(t, err)
	require.True(t, pending)
	anchor := f.g.ctx.WithBlockHeight(3).WithHeaderHash(seed[:])
	require.NoError(t, f.g.fixture.keeper.BeginBlock(anchor))
	response := anchor.WithBlockHeight(4)
	s, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(response, f.session.SessionId)
	require.NoError(t, err)
	storedAnchor, err := f.g.fixture.keeper.ChallengeAnchors.Get(response, 3)
	require.NoError(t, err)
	require.Equal(t, seed[:], storedAnchor.Seed)
	queried, err := keeper.NewQueryServerImpl(f.g.fixture.keeper).GetRetrievalSessionV3(response, &types.QueryGetRetrievalSessionV3Request{SessionId: s.SessionId})
	require.NoError(t, err)
	require.Equal(t, storedAnchor.Seed, queried.AnchorSeed)
	challengeSeed, err := challengeContextV3(t, s).Seed(storedAnchor.Seed)
	require.NoError(t, err)
	require.NotEqual(t, challengeSeed[:], queried.AnchorSeed)
	challenges, err := challengeContextV3(t, s).Challenges(challengeSeed[:])
	require.NoError(t, err)
	require.Len(t, challenges, 1)
	require.Equal(t, uint32(0), challenges[0].Slot)
	sample := f.proof(t, challenges[0])

	proofGasBefore := response.GasMeter().GasConsumed()
	submitted, err := f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0,
		Proofs: []types.RetrievalSampleProofV3{sample},
	})
	require.NoError(t, err)
	require.Equal(t, uint32(1), submitted.NewlyAccepted)
	require.False(t, submitted.Settled)
	proofGas := response.GasMeter().GasConsumed() - proofGasBefore
	require.GreaterOrEqual(t, proofGas, keeper.ProofCryptoGas)
	require.Less(t, proofGas, uint64(types.MaxRetrievalV2BlockGas))
	t.Logf("fixture native v3 one-proof gas: %d (includes one canonical four-hop verification; excludes delivery)", proofGas)
	ackGasBefore := response.GasMeter().GasConsumed()
	ack, err := f.g.server.AcknowledgeRetrievalObligationV3(response, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: s.SessionId, Slot: 0, AckDigest: ackDigestV3(t, s, 0),
	})
	require.NoError(t, err)
	require.True(t, ack.Settled)
	ackGas := response.GasMeter().GasConsumed() - ackGasBefore
	require.Less(t, ackGas, uint64(types.MaxRetrievalV2BlockGas))
	t.Logf("fixture native v3 ACK-and-settlement gas: %d (excludes transport and full-byte integrity work)", ackGas)
	settled, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(response, s.SessionId)
	require.NoError(t, err)
	require.Equal(t, uint32(1), settled.AckedSlotsMask)
	require.Equal(t, uint32(1), settled.SettledSlotsMask)
	require.True(t, settled.LockedFee.IsZero())
	provider, err := sdk.AccAddressFromBech32(settled.Obligations[0].Payee)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(2), f.g.bank.accountBalances[provider.String()].AmountOf(sdk.DefaultBondDenom))

	beforeReplay := sessionStoreSnapshot(t, response, f.g.fixture.storeService)
	replayed, err := f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: settled.Obligations[0].AssignedProvider, SessionId: settled.SessionId, Slot: 0,
		Proofs: []types.RetrievalSampleProofV3{sample},
	})
	require.NoError(t, err)
	require.Zero(t, replayed.NewlyAccepted)
	require.True(t, replayed.Settled)
	require.Equal(t, beforeReplay, sessionStoreSnapshot(t, response, f.g.fixture.storeService))

	tampered := sample
	tampered.Proof.YValue = append([]byte(nil), sample.Proof.YValue...)
	tampered.Proof.YValue[31] ^= 1
	_, err = f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: settled.Obligations[0].AssignedProvider, SessionId: settled.SessionId, Slot: 0,
		Proofs: []types.RetrievalSampleProofV3{tampered},
	})
	require.ErrorContains(t, err, "invalid v3 chained proof")
	require.Equal(t, beforeReplay, sessionStoreSnapshot(t, response, f.g.fixture.storeService))
}

func TestRetrievalSessionV3MixedReplayAndAckBeforeProof(t *testing.T) {
	f := openCryptoSessionV3(t, 9*retrievalchallenge.DataBlobPayloadBytes)
	anchorHash := sha256.Sum256([]byte("v3-mixed-replay-anchor"))
	anchor := f.g.ctx.WithBlockHeight(3).WithHeaderHash(anchorHash[:])
	require.NoError(t, f.g.fixture.keeper.BeginBlock(anchor))
	response := anchor.WithBlockHeight(4)
	s, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(response, f.session.SessionId)
	require.NoError(t, err)
	storedAnchor, err := f.g.fixture.keeper.ChallengeAnchors.Get(response, s.AnchorHeight)
	require.NoError(t, err)
	seed, err := challengeContextV3(t, s).Seed(storedAnchor.Seed)
	require.NoError(t, err)
	challenges, err := challengeContextV3(t, s).Challenges(seed[:])
	require.NoError(t, err)
	var slotZero []retrievalchallenge.ChallengeV3
	for _, challenge := range challenges {
		if challenge.Slot == 0 {
			slotZero = append(slotZero, challenge)
		}
	}
	require.Len(t, slotZero, 2)
	first := f.proof(t, slotZero[0])
	second := f.proof(t, slotZero[1])
	before := sessionStoreSnapshot(t, response, f.g.fixture.storeService)

	oversized := make([]types.RetrievalSampleProofV3, 65)
	for i := range oversized {
		oversized[i] = first
	}
	for _, tc := range []struct {
		name   string
		proofs []types.RetrievalSampleProofV3
		want   string
	}{
		{name: "oversized", proofs: oversized, want: "proof count"},
		{name: "duplicate ordinal", proofs: []types.RetrievalSampleProofV3{first, first}, want: "repeated within message"},
		{name: "out of range ordinal", proofs: []types.RetrievalSampleProofV3{{Ordinal: uint64(len(challenges)), Proof: first.Proof}}, want: "ordinal out of range"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
				Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0, Proofs: tc.proofs,
			})
			require.ErrorContains(t, err, tc.want)
			require.Equal(t, before, sessionStoreSnapshot(t, response, f.g.fixture.storeService))
		})
	}
	wrongZ := first
	wrongZ.Proof.ZValue = append([]byte(nil), first.Proof.ZValue...)
	wrongZ.Proof.ZValue[0] ^= 1
	_, err = f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0, Proofs: []types.RetrievalSampleProofV3{wrongZ},
	})
	require.ErrorContains(t, err, "does not match selected v3 sample")
	require.Equal(t, before, sessionStoreSnapshot(t, response, f.g.fixture.storeService))

	wrongAck := ackDigestV3(t, s, 0)
	wrongAck[0] ^= 1
	_, err = f.g.server.AcknowledgeRetrievalObligationV3(response, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: s.SessionId, Slot: 0, AckDigest: wrongAck,
	})
	require.ErrorContains(t, err, "ACK digest does not match")
	acked, err := f.g.server.AcknowledgeRetrievalObligationV3(response, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: s.SessionId, Slot: 0, AckDigest: ackDigestV3(t, s, 0),
	})
	require.NoError(t, err)
	require.False(t, acked.Settled)

	accepted, err := f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0, Proofs: []types.RetrievalSampleProofV3{first},
	})
	require.NoError(t, err)
	require.Equal(t, uint32(1), accepted.NewlyAccepted)
	require.False(t, accepted.Settled)
	beforeMixedFailure := sessionStoreSnapshot(t, response, f.g.fixture.storeService)
	transfersBeforeMixedFailure := len(f.g.bank.transfers)
	badSecond := second
	badSecond.Proof.YValue = append([]byte(nil), second.Proof.YValue...)
	badSecond.Proof.YValue[31] ^= 1
	_, err = f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0,
		Proofs: []types.RetrievalSampleProofV3{first, badSecond},
	})
	require.ErrorContains(t, err, "invalid v3 chained proof")
	require.Equal(t, beforeMixedFailure, sessionStoreSnapshot(t, response, f.g.fixture.storeService))
	require.Len(t, f.g.bank.transfers, transfersBeforeMixedFailure)

	accepted, err = f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0, Proofs: []types.RetrievalSampleProofV3{first, second},
	})
	require.NoError(t, err)
	require.Equal(t, uint32(1), accepted.NewlyAccepted)
	require.True(t, accepted.Settled)
	settled, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(response, s.SessionId)
	require.NoError(t, err)
	require.Equal(t, uint32(1), settled.SettledSlotsMask)
	provider, err := sdk.AccAddressFromBech32(settled.Obligations[0].Payee)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(5), f.g.bank.accountBalances[provider.String()].AmountOf(sdk.DefaultBondDenom))

	replayCtx := response.WithBlockHeight(5)
	after := sessionStoreSnapshot(t, replayCtx, f.g.fixture.storeService)
	replayed, err := f.g.server.SubmitRetrievalSessionProofV3(replayCtx, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0, Proofs: []types.RetrievalSampleProofV3{first, second},
	})
	require.NoError(t, err)
	require.Zero(t, replayed.NewlyAccepted)
	require.True(t, replayed.Settled)
	require.Equal(t, after, sessionStoreSnapshot(t, replayCtx, f.g.fixture.storeService))
}

func TestRetrievalSessionV3PartialSettlementExpiryAndRefund(t *testing.T) {
	f := openCryptoSessionV3(t, retrievalchallenge.DataBlobPayloadBytes+1)
	anchorHash := sha256.Sum256([]byte("v3-partial-settlement-anchor"))
	anchor := f.g.ctx.WithBlockHeight(3).WithHeaderHash(anchorHash[:])
	require.NoError(t, f.g.fixture.keeper.BeginBlock(anchor))
	response := anchor.WithBlockHeight(4)
	s, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(response, f.session.SessionId)
	require.NoError(t, err)
	storedAnchor, err := f.g.fixture.keeper.ChallengeAnchors.Get(response, s.AnchorHeight)
	require.NoError(t, err)
	challengeSeed, err := challengeContextV3(t, s).Seed(storedAnchor.Seed)
	require.NoError(t, err)
	challenges, err := challengeContextV3(t, s).Challenges(challengeSeed[:])
	require.NoError(t, err)
	require.Len(t, challenges, 2)
	bySlot := make(map[uint32]retrievalchallenge.ChallengeV3, 2)
	for _, challenge := range challenges {
		bySlot[challenge.Slot] = challenge
	}
	require.Contains(t, bySlot, uint32(0))
	require.Contains(t, bySlot, uint32(1))

	_, err = f.g.server.SubmitRetrievalSessionProofV3(response, &types.MsgSubmitRetrievalSessionProofV3{
		Creator: s.Obligations[0].AssignedProvider, SessionId: s.SessionId, Slot: 0,
		Proofs: []types.RetrievalSampleProofV3{f.proof(t, bySlot[0])},
	})
	require.NoError(t, err)
	_, err = f.g.server.AcknowledgeRetrievalObligationV3(response, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: s.SessionId, Slot: 0, AckDigest: ackDigestV3(t, s, 0),
	})
	require.NoError(t, err)
	_, err = f.g.server.AcknowledgeRetrievalObligationV3(response, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: s.SessionId, Slot: 1, AckDigest: ackDigestV3(t, s, 1),
	})
	require.NoError(t, err)
	partial, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(response, s.SessionId)
	require.NoError(t, err)
	require.Equal(t, uint32(3), partial.AckedSlotsMask)
	require.Equal(t, uint32(1), partial.SettledSlotsMask)
	require.Equal(t, math.NewInt(3), partial.LockedFee)

	expiredCtx := response.WithBlockHeight(21).WithHeaderHash(bytes.Repeat([]byte{0x77}, 32))
	require.NoError(t, f.g.fixture.keeper.BeginBlock(expiredCtx))
	_, err = f.g.fixture.keeper.ChallengeAnchors.Get(expiredCtx, s.AnchorHeight)
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = f.g.fixture.keeper.RetrievalSessionGenerationRefs.Get(expiredCtx, collections.Join(s.DealId, s.Generation))
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = f.g.fixture.keeper.RetrievalSessionGenerationCounts.Get(expiredCtx, s.DealId)
	require.ErrorIs(t, err, collections.ErrNotFound)
	globalGenerations, err := f.g.fixture.keeper.RetrievalSessionGenerationCount.Get(expiredCtx)
	require.NoError(t, err)
	require.Zero(t, globalGenerations)
	globalLive, err := f.g.fixture.keeper.RetrievalSessionLiveCount.Get(expiredCtx)
	require.NoError(t, err)
	require.Zero(t, globalLive)

	refunded, err := f.g.server.RefundRetrievalSessionV3(expiredCtx, &types.MsgRefundRetrievalSessionV3{
		Creator: f.g.owner, SessionId: s.SessionId,
	})
	require.NoError(t, err)
	require.True(t, refunded.Refunded)
	final, err := f.g.fixture.keeper.RetrievalSessionsV3.Get(expiredCtx, s.SessionId)
	require.NoError(t, err)
	require.Equal(t, uint32(1), final.SettledSlotsMask)
	require.Equal(t, uint32(2), final.RefundedSlotsMask)
	require.True(t, final.LockedFee.IsZero())
	deal, err := f.g.fixture.keeper.Deals.Get(expiredCtx, s.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(95), deal.EscrowBalance)

	beforeRetry := sessionStoreSnapshot(t, expiredCtx, f.g.fixture.storeService)
	retried, err := f.g.server.RefundRetrievalSessionV3(expiredCtx, &types.MsgRefundRetrievalSessionV3{
		Creator: f.g.owner, SessionId: s.SessionId,
	})
	require.NoError(t, err)
	require.False(t, retried.Refunded)
	require.Equal(t, beforeRetry, sessionStoreSnapshot(t, expiredCtx, f.g.fixture.storeService))
}

func TestRetrievalSessionV3ZeroPricedRefundPersistsOnce(t *testing.T) {
	g, s := openOwnerSessionV3WithPrice(t, 0)
	expiredCtx := g.ctx.WithBlockHeight(21).WithHeaderHash(bytes.Repeat([]byte{0x88}, 32))
	require.NoError(t, g.fixture.keeper.BeginBlock(expiredCtx))
	before := sessionStoreSnapshot(t, expiredCtx, g.fixture.storeService)
	refunded, err := g.server.RefundRetrievalSessionV3(expiredCtx, &types.MsgRefundRetrievalSessionV3{Creator: g.owner, SessionId: s.SessionId})
	require.NoError(t, err)
	require.True(t, refunded.Refunded)
	after := sessionStoreSnapshot(t, expiredCtx, g.fixture.storeService)
	require.NotEqual(t, before, after)
	stored, err := g.fixture.keeper.RetrievalSessionsV3.Get(expiredCtx, s.SessionId)
	require.NoError(t, err)
	require.Equal(t, uint32(1), stored.RefundedSlotsMask)
	require.True(t, stored.LockedFee.IsZero())

	retried, err := g.server.RefundRetrievalSessionV3(expiredCtx, &types.MsgRefundRetrievalSessionV3{Creator: g.owner, SessionId: s.SessionId})
	require.NoError(t, err)
	require.False(t, retried.Refunded)
	require.Equal(t, after, sessionStoreSnapshot(t, expiredCtx, g.fixture.storeService))
}

func TestRetrievalSessionV3ExactOpenRetryUsesFrozenTerms(t *testing.T) {
	g, s := openOwnerSessionV3(t)
	msg := &types.MsgOpenRetrievalSessionV3{
		Creator: g.owner, DealId: s.DealId, Generation: s.Generation,
		Range: types.RetrievalRangeV3{FileRecordIndex: s.FileRecordIndex, FileStartOffset: s.FileStartOffset,
			FileLength: s.FileLength, RangeStart: s.RangeStart, RangeLength: s.RangeLength},
		Nonce: s.Nonce, DeadlineHeight: s.DeadlineHeight,
	}

	// Once admitted, an exact retry reconstructs from frozen state even when the
	// current deal has advanced and the original deadline has passed.
	advanced := g.deal
	advanced.CurrentGen++
	advanced.ManifestRoot = bytes.Repeat([]byte{0xa1}, 32)
	advanced.Mode2Slots[0].Provider = g.providers[1]
	retryCtx := g.ctx.WithBlockHeight(int64(s.DeadlineHeight + 1))
	require.NoError(t, g.fixture.keeper.Deals.Set(retryCtx, advanced.Id, advanced))
	before := sessionStoreSnapshot(t, retryCtx, g.fixture.storeService)
	transfers := len(g.bank.transfers)
	retried, err := g.server.OpenRetrievalSessionV3(retryCtx, msg)
	require.NoError(t, err)
	require.Equal(t, s.SessionId, retried.SessionId)
	require.Equal(t, before, sessionStoreSnapshot(t, retryCtx, g.fixture.storeService))
	require.Len(t, g.bank.transfers, transfers)

	different := *msg
	different.Range.RangeLength++
	_, err = g.server.OpenRetrievalSessionV3(retryCtx, &different)
	require.ErrorContains(t, err, "nonce replay with different terms")
	require.Equal(t, before, sessionStoreSnapshot(t, retryCtx, g.fixture.storeService))
	require.Len(t, g.bank.transfers, transfers)
}

func TestRetrievalSessionV3CheckedFeeOverflowRejectsBeforeEffects(t *testing.T) {
	maxAmount := math.NewIntFromBigInt(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))
	tests := []struct {
		name, want string
		length     uint64
		base       math.Int
	}{
		{name: "price times population", want: "exceeds uint256", length: retrievalchallenge.DataBlobPayloadBytes + 1, base: math.ZeroInt()},
		{name: "base plus variable", want: "exceeds uint256", length: 1, base: math.OneInt()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := setupAdmittedSessionV3(t, 3)
			params := g.fixture.keeper.GetParams(g.ctx)
			params.RetrievalPricePerBlob = sdk.NewCoin(sdk.DefaultBondDenom, maxAmount)
			params.BaseRetrievalFee = sdk.NewCoin(sdk.DefaultBondDenom, tc.base)
			require.NoError(t, g.fixture.keeper.Params.Set(g.ctx, params))
			before := sessionStoreSnapshot(t, g.ctx, g.fixture.storeService)
			_, err := g.server.OpenRetrievalSessionV3(g.ctx, &types.MsgOpenRetrievalSessionV3{
				Creator: g.owner, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
				Range: types.RetrievalRangeV3{FileRecordIndex: 10, FileLength: tc.length, RangeLength: tc.length},
				Nonce: 1, DeadlineHeight: 20,
			})
			require.ErrorContains(t, err, tc.want)
			require.Equal(t, before, sessionStoreSnapshot(t, g.ctx, g.fixture.storeService))
			require.Empty(t, g.bank.transfers)
		})
	}
}

func TestRetrievalSessionV2AndV3ShareLifecycleCapacity(t *testing.T) {
	g := setupAdmittedSessionV3(t, 3)
	v2, err := g.server.OpenRetrievalSession(g.ctx, &types.MsgOpenRetrievalSession{
		Creator: g.owner, DealId: g.deal.Id, Provider: g.providers[0], ManifestRoot: g.deal.ManifestRoot,
		StartMduIndex: 2, StartBlobIndex: 0, BlobCount: 1, Nonce: 91, ExpiresAt: 20, ChallengeVersion: retrievalchallenge.Version,
	})
	require.NoError(t, err)
	v3, err := g.server.OpenRetrievalSessionV3(g.ctx, &types.MsgOpenRetrievalSessionV3{
		Creator: g.owner, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 11, FileLength: 1024, RangeLength: 1024},
		Nonce: 1, DeadlineHeight: 20,
	})
	require.NoError(t, err)
	live, err := g.fixture.keeper.RetrievalSessionLiveCount.Get(g.ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(2), live)
	refs, err := g.fixture.keeper.RetrievalSessionGenerationRefs.Get(g.ctx, collections.Join(g.deal.Id, g.deal.CurrentGen))
	require.NoError(t, err)
	require.Equal(t, uint64(2), refs)

	expiredCtx := g.ctx.WithBlockHeight(21).WithHeaderHash(bytes.Repeat([]byte{0xb1}, 32))
	require.NoError(t, g.fixture.keeper.BeginBlock(expiredCtx))
	live, err = g.fixture.keeper.RetrievalSessionLiveCount.Get(expiredCtx)
	require.NoError(t, err)
	require.Zero(t, live)
	_, err = g.fixture.keeper.RetrievalSessionGenerationRefs.Get(expiredCtx, collections.Join(g.deal.Id, g.deal.CurrentGen))
	require.ErrorIs(t, err, collections.ErrNotFound)
	legacy, err := g.fixture.keeper.RetrievalSessions.Get(expiredCtx, v2.SessionId)
	require.NoError(t, err)
	// V2 preserves its legacy OPEN status until its cancel/refund path runs even
	// though the shared expiry index has released its challenge references.
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, legacy.Status)
	large, err := g.fixture.keeper.RetrievalSessionsV3.Get(expiredCtx, v3.SessionId)
	require.NoError(t, err)
	require.True(t, large.Expired)
	query, err := keeper.NewQueryServerImpl(g.fixture.keeper).GetRetrievalSessionV3(expiredCtx, &types.QueryGetRetrievalSessionV3Request{SessionId: v3.SessionId})
	require.NoError(t, err)
	require.Empty(t, query.AnchorSeed)
}

func TestRetrievalSessionV3SponsoredPublicChargesRequesterOnce(t *testing.T) {
	g := setupAdmittedSessionV3(t, 3)
	g.deal.RetrievalPolicy.Mode = types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC
	require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
	requesterBytes := bytes.Repeat([]byte{0x7b}, 20)
	requester, err := g.fixture.addressCodec.BytesToString(requesterBytes)
	require.NoError(t, err)
	g.bank.setAccountBalance(sdk.AccAddress(requesterBytes), sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
	msg := &types.MsgOpenRetrievalSessionV3Sponsored{
		Creator: requester, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 2, FileLength: 1024, RangeLength: 1024},
		Nonce: 1, DeadlineHeight: 20, MaxTotalFee: math.NewInt(5),
	}
	opened, err := g.server.OpenRetrievalSessionV3Sponsored(g.ctx, msg)
	require.NoError(t, err)
	s, err := g.fixture.keeper.RetrievalSessionsV3.Get(g.ctx, opened.SessionId)
	require.NoError(t, err)
	require.Equal(t, requester, s.Owner)
	require.Equal(t, requester, s.Payer)
	require.Equal(t, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER, s.Funding)
	require.Equal(t, math.NewInt(95), g.bank.accountBalances[sdk.AccAddress(requesterBytes).String()].AmountOf(sdk.DefaultBondDenom))
	deal, err := g.fixture.keeper.Deals.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(100), deal.EscrowBalance)

	transfers := len(g.bank.transfers)
	retried, err := g.server.OpenRetrievalSessionV3Sponsored(g.ctx, msg)
	require.NoError(t, err)
	require.Equal(t, opened.SessionId, retried.SessionId)
	require.Len(t, g.bank.transfers, transfers)
}

func TestRetrievalSessionV3VoucherRejectsMultiProviderBeforeConsumption(t *testing.T) {
	g := setupAdmittedSessionV3(t, 3)
	g.deal.RetrievalPolicy.Mode = types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER
	require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
	requesterBytes := bytes.Repeat([]byte{0x7c}, 20)
	requester, err := g.fixture.addressCodec.BytesToString(requesterBytes)
	require.NoError(t, err)
	g.bank.setAccountBalance(sdk.AccAddress(requesterBytes), sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
	before := sessionStoreSnapshot(t, g.ctx, g.fixture.storeService)
	_, err = g.server.OpenRetrievalSessionV3Sponsored(g.ctx, &types.MsgOpenRetrievalSessionV3Sponsored{
		Creator: requester, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 3, FileLength: retrievalchallenge.DataBlobPayloadBytes + 1, RangeLength: retrievalchallenge.DataBlobPayloadBytes + 1},
		Nonce: 1, DeadlineHeight: 20, MaxTotalFee: math.NewInt(0),
		Auth: &types.MsgOpenRetrievalSessionV3Sponsored_Voucher{Voucher: &types.VoucherAuth{}},
	})
	require.ErrorContains(t, err, "voucher cannot authorize multiple v3 provider obligations")
	require.Equal(t, before, sessionStoreSnapshot(t, g.ctx, g.fixture.storeService))
	require.Empty(t, g.bank.transfers)
	require.Equal(t, math.NewInt(100), g.bank.accountBalances[sdk.AccAddress(requesterBytes).String()].AmountOf(sdk.DefaultBondDenom))
}

func TestRetrievalSessionV3VoucherAcceptsExactSingleProviderPlan(t *testing.T) {
	g := setupAdmittedSessionV3(t, 3)
	ownerKey, err := gethCrypto.GenerateKey()
	require.NoError(t, err)
	ownerBytes := gethCrypto.PubkeyToAddress(ownerKey.PublicKey).Bytes()
	owner, err := g.fixture.addressCodec.BytesToString(ownerBytes)
	require.NoError(t, err)
	g.owner = owner
	g.deal.Owner = owner
	g.deal.RetrievalPolicy = types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER}
	require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
	admitted, err := g.fixture.keeper.AdmittedDealGenerationsV3.Get(g.ctx, g.deal.Id)
	require.NoError(t, err)
	admitted.Owner = owner
	require.NoError(t, g.fixture.keeper.AdmittedDealGenerationsV3.Set(g.ctx, g.deal.Id, admitted))

	requesterBytes := bytes.Repeat([]byte{0x7d}, 20)
	requester, err := g.fixture.addressCodec.BytesToString(requesterBytes)
	require.NoError(t, err)
	g.bank.setAccountBalance(sdk.AccAddress(requesterBytes), sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
	voucher := &types.VoucherAuth{
		DealId: g.deal.Id, ManifestRoot: append([]byte(nil), g.deal.ManifestRoot...), Provider: g.providers[0],
		StartMduIndex: 2, StartBlobIndex: 0, BlobCount: 1, ExpiresAt: 20, Nonce: 1, Redeemer: requester,
	}
	params := g.fixture.keeper.GetParams(g.ctx)
	voucher.Signature = signVoucher(t, voucher, params.Eip712ChainId, ownerKey)
	opened, err := g.server.OpenRetrievalSessionV3Sponsored(g.ctx, &types.MsgOpenRetrievalSessionV3Sponsored{
		Creator: requester, DealId: g.deal.Id, Generation: g.deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 4, FileLength: 1024, RangeLength: 1024},
		Nonce: 1, DeadlineHeight: 20, MaxTotalFee: math.NewInt(5),
		Auth: &types.MsgOpenRetrievalSessionV3Sponsored_Voucher{Voucher: voucher},
	})
	require.NoError(t, err)
	require.Len(t, opened.SessionId, 32)
	used, err := g.fixture.keeper.VoucherUsedNonces.Get(g.ctx, collections.Join(g.deal.Id, voucher.Nonce))
	require.NoError(t, err)
	require.True(t, used)
}

func TestRetrievalSessionV3RangeAndOneGiBControlPlaneBounds(t *testing.T) {
	tests := []struct {
		name                             string
		nonce                            uint64
		userMDUs, fileStart, fileLength  uint64
		rangeStart, rangeLength          uint64
		first, last, population, samples uint64
		obligations                      int
	}{
		{name: "one KiB", nonce: 1, userMDUs: 1, fileLength: 1024, rangeLength: 1024,
			first: 0, last: 0, population: 1, samples: 1, obligations: 1},
		{name: "both offsets cross MDU", nonce: 2, userMDUs: 2,
			fileStart:  61*retrievalchallenge.DataBlobPayloadBytes + 125000,
			fileLength: 2*retrievalchallenge.DataBlobPayloadBytes + 131000,
			rangeStart: 2*retrievalchallenge.DataBlobPayloadBytes + 1000, rangeLength: 130000,
			first: 63, last: 65, population: 3, samples: 3, obligations: 3},
		{name: "one GiB", nonce: 3, userMDUs: 133, fileLength: 1 << 30, rangeLength: 1 << 30,
			first: 0, last: 8456, population: 8457, samples: 132, obligations: 8},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := setupAdmittedSessionV3(t, 3)
			g.deal.TotalMdus = 2 + tc.userMDUs
			g.deal.Size_ = tc.userMDUs * 64 * retrievalchallenge.DataBlobPayloadBytes
			g.deal.EscrowBalance = math.NewInt(100000)
			require.NoError(t, g.fixture.keeper.Deals.Set(g.ctx, g.deal.Id, g.deal))
			g.bank.moduleBalances[types.ModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100000))
			admitted, err := g.fixture.keeper.AdmittedDealGenerationsV3.Get(g.ctx, g.deal.Id)
			require.NoError(t, err)
			admitted.Size_ = g.deal.Size_
			admitted.TotalMdus = g.deal.TotalMdus
			admitted.UserMdus = tc.userMDUs
			admitted.IntegrityLeafCount = tc.userMDUs * 96
			require.NoError(t, g.fixture.keeper.AdmittedDealGenerationsV3.Set(g.ctx, g.deal.Id, admitted))
			gasBefore := g.ctx.GasMeter().GasConsumed()
			opened, err := g.server.OpenRetrievalSessionV3(g.ctx, &types.MsgOpenRetrievalSessionV3{
				Creator: g.owner, DealId: g.deal.Id, Generation: g.deal.CurrentGen, Nonce: tc.nonce, DeadlineHeight: 20,
				Range: types.RetrievalRangeV3{FileRecordIndex: 9, FileStartOffset: tc.fileStart, FileLength: tc.fileLength, RangeStart: tc.rangeStart, RangeLength: tc.rangeLength},
			})
			require.NoError(t, err)
			openGas := g.ctx.GasMeter().GasConsumed() - gasBefore
			require.Less(t, openGas, uint64(types.MaxRetrievalV2BlockGas))
			t.Logf("fixture native v3 open gas (%s, U=%d, obligations=%d): %d; excludes delivery and proof verification", tc.name, tc.population, tc.obligations, openGas)
			s, err := g.fixture.keeper.RetrievalSessionsV3.Get(g.ctx, opened.SessionId)
			require.NoError(t, err)
			require.Equal(t, tc.first, s.FirstBlob)
			require.Equal(t, tc.last, s.LastBlob)
			require.Equal(t, tc.population, s.Population)
			require.Equal(t, tc.samples, s.SampleCount)
			require.Len(t, s.Obligations, tc.obligations)
			require.Len(t, s.AcceptedSampleBitmap, int((retrievalchallenge.MaxLargeSessionSamples+7)/8))
			require.Equal(t, tc.population*retrievalchallenge.EncodedBlobBytes, opened.BilledEncodedBytes)
		})
	}
}
