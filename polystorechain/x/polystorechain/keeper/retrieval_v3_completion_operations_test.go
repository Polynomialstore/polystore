package keeper_test

import (
	"bytes"
	"context"
	"fmt"
	"testing"

	corestore "cosmossdk.io/core/store"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

// Untimed, bounded reference-operation audit. This wrapper is deliberately not
// installed in the CPU/allocation benchmark. Reads count Get/Has calls, not
// iterator steps or the bank/session economic rows.
type completionReferenceCounter struct {
	corestore.KVStoreService
	reads, writes, deletes uint64
}

type completionReferenceStore struct {
	corestore.KVStore
	counter *completionReferenceCounter
}

func (c *completionReferenceCounter) OpenKVStore(ctx context.Context) corestore.KVStore {
	return completionReferenceStore{c.KVStoreService.OpenKVStore(ctx), c}
}

func completionReferenceKey(key []byte) bool {
	for _, prefix := range [][]byte{
		types.ChallengeAnchorsKey.Bytes(), types.RetrievalSessionExpiryRefsKey.Bytes(), types.RetrievalSessionExpiryCountsKey.Bytes(),
		types.RetrievalSessionLiveCountKey.Bytes(), types.RetrievalSessionGenerationRefsKey.Bytes(),
		types.RetrievalSessionGenerationCountsKey.Bytes(), types.RetrievalSessionGenerationCountKey.Bytes(),
		[]byte("RetrievalSessionV3TerminalAnchors/value/"),
	} {
		if bytes.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func (s completionReferenceStore) Get(key []byte) ([]byte, error) {
	if completionReferenceKey(key) {
		s.counter.reads++
	}
	return s.KVStore.Get(key)
}
func (s completionReferenceStore) Has(key []byte) (bool, error) {
	if completionReferenceKey(key) {
		s.counter.reads++
	}
	return s.KVStore.Has(key)
}
func (s completionReferenceStore) Set(key, value []byte) error {
	if completionReferenceKey(key) {
		s.counter.writes++
	}
	return s.KVStore.Set(key, value)
}
func (s completionReferenceStore) Delete(key []byte) error {
	if completionReferenceKey(key) {
		s.counter.deletes++
	}
	return s.KVStore.Delete(key)
}

func TestRetrievalV3CompletionReferenceOperationCounts(t *testing.T) {
	for _, count := range []int{1, 8} {
		t.Run(fmt.Sprintf("sessions=%d", count), func(t *testing.T) {
			f, ctx, sessions, samples := openCryptoSessionV3Batch(t, count)
			_, err := f.g.server.SubmitRetrievalSessionProofBatchV3(ctx, batchProofMessageV3(f.g.providers[0], sessions, samples))
			require.NoError(t, err)
			counter := &completionReferenceCounter{KVStoreService: f.g.fixture.storeService}
			enc := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
			k := keeper.NewKeeper(counter, enc.Codec, f.g.fixture.addressCodec, authtypes.NewModuleAddress(types.GovModuleName), f.g.bank, MockAccountKeeper{})
			server := keeper.NewMsgServerImpl(k)
			for _, s := range sessions {
				ack, err := server.AcknowledgeRetrievalObligationV3(ctx, &types.MsgAcknowledgeRetrievalObligationV3{
					Creator: f.g.owner, SessionId: s.SessionId, Slot: 0, AckDigest: ackDigestV3(t, s, 0),
				})
				require.NoError(t, err)
				require.True(t, ack.Settled)
			}
			t.Logf("ACK completion sessions=%d reference_get_has=%d reference_sets=%d reference_deletes=%d", count, counter.reads, counter.writes, counter.deletes)
			counter.reads, counter.writes, counter.deletes = 0, 0, 0
			require.NoError(t, k.BeginBlock(ctx.WithBlockHeight(21)))
			t.Logf("later expiry sessions=%d reference_get_has=%d reference_sets=%d reference_deletes=%d", count, counter.reads, counter.writes, counter.deletes)
		})
	}
}
