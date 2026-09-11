package keeper

import (
	"bytes"
	"testing"

	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func largeStoredSessionV3(tb testing.TB) types.RetrievalSessionV3 {
	tb.Helper()
	const chainID = "polystore-bench-1"
	const dealID = uint64(42)
	const generation = uint64(7)
	const fileRecordIndex = uint32(3)
	const nonce = uint64(9)
	const pricePerBlob = int64(3)
	const snapshotHeight = uint64(100)
	const deadlineHeight = uint64(200)
	const dealEndHeight = uint64(300)

	var owner [20]byte
	for i := range owner {
		owner[i] = 0x11
	}
	ownerAddress := sdk.AccAddress(owner[:]).String()
	userMDUs := (retrievalchallenge.MaxLargeRangeBytes + 64*retrievalchallenge.DataBlobPayloadBytes - 1) / (64 * retrievalchallenge.DataBlobPayloadBytes)
	r, err := retrievalchallenge.CheckedRangeV3(0, retrievalchallenge.MaxLargeRangeBytes, 0, retrievalchallenge.MaxLargeRangeBytes, userMDUs)
	require.NoError(tb, err)
	var providers [8][20]byte
	for slot := range providers {
		for i := range providers[slot] {
			providers[slot][i] = byte(0x40 + slot)
		}
	}
	plan, err := retrievalchallenge.BuildPlanV3(r, providers)
	require.NoError(tb, err)
	planHash, err := plan.Hash()
	require.NoError(tb, err)
	sessionID, err := (retrievalchallenge.SessionBindingV3{
		ChainID: chainID, Owner: owner, DealID: dealID, Generation: generation,
		FileRecordIndex: fileRecordIndex, RangeLength: retrievalchallenge.MaxLargeRangeBytes,
		PlanHash: planHash, Nonce: nonce,
	}).ID()
	require.NoError(tb, err)
	window, err := retrievalchallenge.SessionWindow(snapshotHeight, deadlineHeight, dealEndHeight)
	require.NoError(tb, err)

	obligations := make([]types.RetrievalObligationV3, len(plan.Obligations))
	for i, obligation := range plan.Obligations {
		provider := sdk.AccAddress(obligation.Assigned[:]).String()
		obligations[i] = types.RetrievalObligationV3{
			Slot: obligation.Slot, AssignedProvider: provider, Payee: provider,
			BlobCount: obligation.BlobCount, LockedFee: cosmosmath.NewInt(pricePerBlob).MulRaw(int64(obligation.BlobCount)),
		}
	}
	s := types.RetrievalSessionV3{
		SessionId: sessionID[:], DealId: dealID, Generation: generation, Owner: ownerAddress, Payer: ownerAddress,
		PolyfsRoot: bytes.Repeat([]byte{0x22}, 32), IntegrityRoot: bytes.Repeat([]byte{0x33}, 32), SetupDigest: bytes.Repeat([]byte{0x44}, 32),
		FileRecordIndex: fileRecordIndex, FileLength: retrievalchallenge.MaxLargeRangeBytes, RangeLength: retrievalchallenge.MaxLargeRangeBytes,
		MetadataMdus: 2, UserMdus: userMDUs, PlanHash: planHash[:], FirstBlob: r.First, LastBlob: r.Last, Population: r.Population,
		SampleCount: retrievalchallenge.MaxLargeSessionSamples, Nonce: nonce, PriceDenom: "stake", PricePerBlob: cosmosmath.NewInt(pricePerBlob),
		BaseFee: cosmosmath.NewInt(5), CompletionBurnBps: 250, Funding: types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW,
		SnapshotHeight: window.Snapshot, AnchorHeight: window.Anchor, FirstResponseHeight: window.First, DeadlineHeight: window.Deadline, DealEndHeight: dealEndHeight,
		Obligations: obligations, AcceptedSampleBitmap: make([]byte, v3SampleBitmapBytes),
		LockedFee: cosmosmath.NewInt(pricePerBlob).MulRaw(int64(r.Population)), OpenedHeight: int64(snapshotHeight), UpdatedHeight: int64(snapshotHeight), ChainId: chainID,
	}
	c, err := sessionContextV3(s)
	require.NoError(tb, err)
	contextHash, err := c.Hash()
	require.NoError(tb, err)
	s.ContextHash = contextHash[:]
	_, err = validateStoredSessionV3(s)
	require.NoError(tb, err)
	return s
}

func cloneStoredSessionV3(s types.RetrievalSessionV3) types.RetrievalSessionV3 {
	s.Obligations = append([]types.RetrievalObligationV3(nil), s.Obligations...)
	return s
}

// validateAndMaterializeV3Samples preserves the former two-step call path as
// an equivalence oracle and benchmark control.
func validateAndMaterializeV3Samples(s *types.RetrievalSessionV3, anchor []byte) ([]retrievalchallenge.ChallengeV3, error) {
	c, err := validateStoredSessionV3(*s)
	if err != nil {
		return nil, err
	}
	return materializeV3Samples(s, c, anchor)
}

func TestMaterializeV3SamplesReusesValidatedContext(t *testing.T) {
	s := largeStoredSessionV3(t)
	anchor := bytes.Repeat([]byte{0x55}, 32)
	wantSession := cloneStoredSessionV3(s)
	wantChallenges, err := validateAndMaterializeV3Samples(&wantSession, anchor)
	require.NoError(t, err)

	validatedContext, err := validateStoredSessionV3(s)
	require.NoError(t, err)
	gotSession := cloneStoredSessionV3(s)
	gotChallenges, err := materializeV3Samples(&gotSession, validatedContext, anchor)
	require.NoError(t, err)

	require.Equal(t, wantChallenges, gotChallenges)
	require.Equal(t, wantSession, gotSession)
}

func BenchmarkMaterializeV3SamplesContextReuse(b *testing.B) {
	s := largeStoredSessionV3(b)
	anchor := bytes.Repeat([]byte{0x55}, 32)
	validatedContext, err := validateStoredSessionV3(s)
	require.NoError(b, err)

	b.Run("validate-and-materialize", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			candidate := cloneStoredSessionV3(s)
			if _, err := validateAndMaterializeV3Samples(&candidate, anchor); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("reuse-validated-context", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			candidate := cloneStoredSessionV3(s)
			if _, err := materializeV3Samples(&candidate, validatedContext, anchor); err != nil {
				b.Fatal(err)
			}
		}
	})
}
