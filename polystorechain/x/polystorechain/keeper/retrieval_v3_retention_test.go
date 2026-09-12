package keeper

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"path/filepath"
	"runtime"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	"cosmossdk.io/math"
	"cosmossdk.io/store"
	"cosmossdk.io/store/metrics"
	storetypes "cosmossdk.io/store/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

// This is a serializer/storage experiment, not a funded retrieval benchmark.
// Use the production context, plan, sample derivation and stored-row validator;
// insert phase snapshots directly, without pretending to execute delivery/KZG.
func retentionSessionV3(t testing.TB, length, nonce uint64, phase string) types.RetrievalSessionV3 {
	t.Helper()
	userMDUs := (length + 64*retrievalchallenge.DataBlobPayloadBytes - 1) / (64 * retrievalchallenge.DataBlobPayloadBytes)
	r, err := retrievalchallenge.CheckedRangeV3(0, length, 0, length, userMDUs)
	require.NoError(t, err)
	var providers [8][20]byte
	for i := range providers {
		copy(providers[i][:], bytes.Repeat([]byte{byte(i + 1)}, 20))
	}
	plan, err := retrievalchallenge.BuildPlanV3(r, providers)
	require.NoError(t, err)
	planHash, err := plan.Hash()
	require.NoError(t, err)
	ownerRaw := [20]byte{9}
	owner := sdk.AccAddress(ownerRaw[:]).String()
	id, err := (retrievalchallenge.SessionBindingV3{ChainID: "retention-341", Owner: ownerRaw, DealID: 42, Generation: 7, FileRecordIndex: 3, RangeLength: length, PlanHash: planHash, Nonce: nonce}).ID()
	require.NoError(t, err)
	s := types.RetrievalSessionV3{
		SessionId: id[:], DealId: 42, Generation: 7, Owner: owner, Payer: owner,
		PolyfsRoot: bytes.Repeat([]byte{1}, 32), IntegrityRoot: bytes.Repeat([]byte{2}, 32), SetupDigest: bytes.Repeat([]byte{3}, 32),
		FileRecordIndex: 3, FileLength: length, RangeLength: length, MetadataMdus: 2, UserMdus: userMDUs,
		PlanHash: planHash[:], FirstBlob: r.First, LastBlob: r.Last, Population: r.Population,
		SampleCount: min(r.Population, retrievalchallenge.MaxLargeSessionSamples), Nonce: nonce,
		PriceDenom: "stake", PricePerBlob: math.NewInt(3), BaseFee: math.NewInt(5), CompletionBurnBps: 250,
		Funding:        types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW,
		SnapshotHeight: 10000, AnchorHeight: 10001, FirstResponseHeight: 10002, DeadlineHeight: 14096, DealEndHeight: 1000000,
		AcceptedSampleBitmap: make([]byte, v3SampleBitmapBytes), LockedFee: math.NewIntFromUint64(r.Population * 3),
		OpenedHeight: 10000, UpdatedHeight: 10000, ChainId: "retention-341",
	}
	var mask uint32
	for _, o := range plan.Obligations {
		provider := sdk.AccAddress(o.Assigned[:]).String()
		s.Obligations = append(s.Obligations, types.RetrievalObligationV3{Slot: o.Slot, AssignedProvider: provider, Payee: provider, BlobCount: o.BlobCount, LockedFee: math.NewIntFromUint64(o.BlobCount * 3)})
		mask |= 1 << o.Slot
	}
	c, err := sessionContextV3(s)
	require.NoError(t, err)
	h, err := c.Hash()
	require.NoError(t, err)
	s.ContextHash = h[:]
	_, err = materializeV3Samples(&s, c, bytes.Repeat([]byte{4}, 32))
	require.NoError(t, err)
	switch phase {
	case "live":
	case "settled":
		s.AckedSlotsMask, s.SettledSlotsMask = mask, mask
		s.LockedFee = math.ZeroInt()
		s.UpdatedHeight = 10004
		for i := uint64(0); i < s.SampleCount; i++ {
			v3SetBit(s.AcceptedSampleBitmap, i)
		}
	case "expired-unrefunded":
		s.Expired, s.UpdatedHeight = true, 14097
	case "refunded":
		s.Expired, s.UpdatedHeight = true, 14098
		s.RefundedSlotsMask, s.LockedFee = mask, math.ZeroInt()
	default:
		t.Fatalf("unknown retention phase %q", phase)
	}
	_, err = validateStoredSessionV3(s)
	require.NoError(t, err)
	return s
}

func retentionEntryBytes[K, V any](t testing.TB, m collections.Map[K, V], key K, value V) int {
	t.Helper()
	k, err := collections.EncodeKeyWithPrefix(m.GetPrefix(), m.KeyCodec(), key)
	require.NoError(t, err)
	v, err := m.ValueCodec().Encode(value)
	require.NoError(t, err)
	return len(k) + len(v)
}

func TestRetrievalV3RetentionSerializedFootprint(t *testing.T) {
	k, _, _, db, _ := storageStateFixture(t)
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	for _, length := range []uint64{1024, 8 * retrievalchallenge.DataBlobPayloadBytes, 1 << 30} {
		for _, phase := range []string{"live", "settled", "expired-unrefunded", "refunded"} {
			s := retentionSessionV3(t, length, 1, phase)
			wire, err := s.Marshal()
			require.NoError(t, err)
			var decoded types.RetrievalSessionV3
			require.NoError(t, decoded.Unmarshal(wire))
			roundTrip, err := decoded.Marshal()
			require.NoError(t, err)
			require.Equal(t, wire, roundTrip)
			row := retentionEntryBytes(t, k.RetrievalSessionsV3, s.SessionId, s)
			index := retentionEntryBytes(t, k.RetrievalSessionV3NonceIDs, collections.Join(collections.Join(s.Owner, s.DealId), s.Nonce), s.SessionId)
			highWater := retentionEntryBytes(t, k.RetrievalSessionV3Nonces, collections.Join(s.Owner, s.DealId), s.Nonce)
			t.Logf("length=%d slots=%d samples=%d phase=%s protobuf=%d row=%d nonce_index=%d per_session=%d high_water_per_owner_deal=%d", length, len(s.Obligations), s.SampleCount, phase, len(wire), row, index, row+index, highWater)
		}
	}
}

func retentionDBBytes(t testing.TB, db dbm.DB) int64 {
	t.Helper()
	it, err := db.Iterator(nil, nil)
	require.NoError(t, err)
	defer it.Close()
	var size int64
	for ; it.Valid(); it.Next() {
		size += int64(len(it.Key()) + len(it.Value()))
	}
	require.NoError(t, it.Error())
	return size
}

func TestRetrievalV3RetentionCommittedGrowth(t *testing.T) {
	for _, length := range []uint64{1024, 1 << 30} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			dir := t.TempDir()
			db, err := dbm.NewGoLevelDB("retention", dir, nil)
			require.NoError(t, err)
			t.Cleanup(func() { _ = db.Close() })
			key := storetypes.NewKVStoreKey(types.StoreKey)
			cms := store.NewCommitMultiStore(db, log.NewNopLogger(), metrics.NewNoOpMetrics())
			cms.MountStoreWithDB(key, storetypes.StoreTypeIAVL, db)
			require.NoError(t, cms.LoadLatestVersion())
			k := newStorageStateKeeper(key)
			ctx := sdk.NewContext(cms, cmtproto.Header{ChainID: "retention-341", Height: 1}, false, log.NewNopLogger())
			runtime.GC()
			var initial runtime.MemStats
			runtime.ReadMemStats(&initial)
			var previousDB int64
			for group := uint64(0); group < 4; group++ {
				for n := group*128 + 1; n <= (group+1)*128; n++ {
					s := retentionSessionV3(t, length, n, "settled")
					require.NoError(t, k.RetrievalSessionsV3.Set(ctx, s.SessionId, s))
					require.NoError(t, k.RetrievalSessionV3Nonces.Set(ctx, collections.Join(s.Owner, s.DealId), n))
					require.NoError(t, k.RetrievalSessionV3NonceIDs.Set(ctx, collections.Join(collections.Join(s.Owner, s.DealId), n), s.SessionId))
				}
				cms.Commit() // Four retained IAVL versions; no claims about default pruning.
				size := retentionDBBytes(t, db)
				require.Greater(t, size, previousDB)
				require.NoError(t, db.ForceCompact(nil, nil))
				runtime.GC()
				var current runtime.MemStats
				runtime.ReadMemStats(&current)
				t.Logf("length=%d sessions=%d versions=%d database_kv_bytes=%d incremental_db_bytes_per_session=%.2f retained_heap_delta=%d", length, (group+1)*128, group+1, size, float64(size-previousDB)/128, int64(current.HeapAlloc)-int64(initial.HeapAlloc))
				previousDB = size
			}
			// Compaction can retire files even after ForceCompact returns. Stop
			// the backend before walking its directory; never ignore missing SSTs
			// and report the resulting partial sum as a storage measurement.
			require.NoError(t, db.Close())
			var disk int64
			require.NoError(t, filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if d.Type().IsRegular() {
					info, err := d.Info()
					if err != nil {
						return err
					}
					disk += info.Size()
				}
				return nil
			}))
			t.Logf("length=%d sessions=512 closed_compacted_directory_bytes=%d", length, disk)
			reopenedDB, err := dbm.NewGoLevelDB("retention", dir, nil)
			require.NoError(t, err)
			db = reopenedDB
			// Persistent store reload and exact nonce lookup survive measurement.
			reopened := store.NewCommitMultiStore(db, log.NewNopLogger(), metrics.NewNoOpMetrics())
			reopened.MountStoreWithDB(key, storetypes.StoreTypeIAVL, db)
			require.NoError(t, reopened.LoadLatestVersion())
			ctx = ctx.WithMultiStore(reopened)
			want := retentionSessionV3(t, length, 512, "settled")
			got, err := k.RetrievalSessionsV3.Get(ctx, want.SessionId)
			require.NoError(t, err)
			wantWire, err := want.Marshal()
			require.NoError(t, err)
			gotWire, err := got.Marshal()
			require.NoError(t, err)
			require.Equal(t, sha256.Sum256(wantWire), sha256.Sum256(gotWire))
			id, err := k.RetrievalSessionV3NonceIDs.Get(ctx, collections.Join(collections.Join(want.Owner, want.DealId), want.Nonce))
			require.NoError(t, err)
			require.Equal(t, want.SessionId, id)
		})
	}
}
