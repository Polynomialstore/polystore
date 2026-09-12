package keeper_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	corestore "cosmossdk.io/core/store"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

// Inject real collection storage errors, while forwarding every other operation
// into the fixture's SDK cache store. No production test hook is required.
type sessionFaultService struct {
	corestore.KVStoreService
	operation string
	prefix    []byte
}
type sessionFaultStore struct {
	corestore.KVStore
	fault *sessionFaultService
}

func (s *sessionFaultService) OpenKVStore(ctx context.Context) corestore.KVStore {
	return sessionFaultStore{s.KVStoreService.OpenKVStore(ctx), s}
}
func (s sessionFaultStore) fails(op string, key []byte) bool {
	return s.fault.operation == op && bytes.HasPrefix(key, s.fault.prefix)
}
func (s sessionFaultStore) Get(key []byte) ([]byte, error) {
	if s.fails("get", key) {
		return nil, fmt.Errorf("injected session store get failure")
	}
	return s.KVStore.Get(key)
}
func (s sessionFaultStore) Set(key, value []byte) error {
	if s.fails("set", key) {
		return fmt.Errorf("injected session store set failure")
	}
	return s.KVStore.Set(key, value)
}
func (s sessionFaultStore) Delete(key []byte) error {
	if s.fails("delete", key) {
		return fmt.Errorf("injected session store delete failure")
	}
	return s.KVStore.Delete(key)
}

// Monetary effects are stored in the same SDK multistore as session state. This
// establishes cache rollback for these failures, unlike the tracking map bank.
// The production x/bank + signed transaction boundary is covered by app tests.
type sessionCacheBank struct {
	MockBankKeeper
	balances collections.Map[string, string]
}

func newSessionCacheBank(t testing.TB, svc corestore.KVStoreService) sessionCacheBank {
	sb := collections.NewSchemaBuilder(svc)
	b := sessionCacheBank{balances: collections.NewMap(sb, collections.NewPrefix("SessionFaultBank/value/"), "SessionFaultBank", collections.StringKey, collections.StringValue)}
	_, err := sb.Build()
	require.NoError(t, err)
	return b
}
func (b sessionCacheBank) amount(ctx context.Context, key string) (math.Int, error) {
	s, err := b.balances.Get(ctx, key)
	if errors.Is(err, collections.ErrNotFound) {
		return math.ZeroInt(), nil
	}
	if err != nil {
		return math.Int{}, err
	}
	n, ok := math.NewIntFromString(s)
	if !ok {
		return math.Int{}, fmt.Errorf("invalid cached balance")
	}
	return n, nil
}
func (b sessionCacheBank) move(ctx context.Context, from, to string, amt sdk.Coins) error {
	n := amt.AmountOf(sdk.DefaultBondDenom)
	a, err := b.amount(ctx, from)
	if err != nil {
		return err
	}
	if a.LT(n) {
		return fmt.Errorf("insufficient cached settlement funds")
	}
	z, err := b.amount(ctx, to)
	if err != nil {
		return err
	}
	if err = b.balances.Set(ctx, from, a.Sub(n).String()); err != nil {
		return err
	}
	return b.balances.Set(ctx, to, z.Add(n).String())
}
func (b sessionCacheBank) BurnCoins(ctx context.Context, mod string, amt sdk.Coins) error {
	return b.move(ctx, "module/"+mod, "burned", amt)
}
func (b sessionCacheBank) SendCoinsFromModuleToAccount(ctx context.Context, mod string, addr sdk.AccAddress, amt sdk.Coins) error {
	return b.move(ctx, "module/"+mod, "account/"+addr.String(), amt)
}

func sessionStoreSnapshot(t *testing.T, ctx sdk.Context, svc corestore.KVStoreService) map[string]string {
	t.Helper()
	it, err := svc.OpenKVStore(ctx).Iterator(nil, nil)
	require.NoError(t, err)
	defer it.Close()
	out := make(map[string]string)
	for ; it.Valid(); it.Next() {
		out[string(it.Key())] = string(it.Value())
	}
	require.NoError(t, it.Error())
	return out
}

func TestRetrievalV2FailedSettlementDiscardsAllCachedEffects(t *testing.T) {
	for _, failure := range []string{"pin get", "pin set", "pin remove", "activity set", "insufficient bank"} {
		t.Run(failure, func(t *testing.T) {
			f, tracking, server, owner, created, _ := setupRetrievalExpiryDeal(t)
			ctx := activateSessionFixture(t, f)
			_, proof := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
			deal, err := f.keeper.Deals.Get(ctx, created.DealId)
			require.NoError(t, err)
			opened, err := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 10, ChallengeVersion: 2})
			require.NoError(t, err)
			_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: opened.SessionId})
			require.NoError(t, err)
			seed := bytes.Repeat([]byte{0xa2}, 32)
			ctx = ctx.WithBlockHeight(3).WithHeaderHash(seed)
			require.NoError(t, f.keeper.BeginBlock(ctx))
			ctx = ctx.WithBlockHeight(4)
			s, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
			require.NoError(t, err)
			c, err := types.RetrievalChallengeContext(s)
			require.NoError(t, err)
			points, err := c.Challenges(seed)
			require.NoError(t, err)
			proof.ZValue = points[0].Z[:]
			proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(make([]byte, types.BlobSizeBytes), proof.ZValue)
			require.NoError(t, err)
			bank := newSessionCacheBank(t, f.storeService)
			for mod, coins := range tracking.moduleBalances {
				require.NoError(t, bank.balances.Set(ctx, "module/"+mod, coins.AmountOf(sdk.DefaultBondDenom).String()))
			}
			for account, coins := range tracking.accountBalances {
				require.NoError(t, bank.balances.Set(ctx, "account/"+account, coins.AmountOf(sdk.DefaultBondDenom).String()))
			}
			fault := &sessionFaultService{KVStoreService: f.storeService, prefix: types.RetrievalSessionProofProviderKey.Bytes()}
			switch failure {
			case "pin get":
				fault.operation = "get"
			case "pin set":
				fault.operation = "set"
			case "pin remove":
				fault.operation = "delete"
			case "activity set":
				fault.operation = "set"
				fault.prefix = types.DealActivityStateKey.Bytes()
			case "insufficient bank":
				require.NoError(t, bank.balances.Set(ctx, "module/"+types.ModuleName, "1"))
			}
			enc := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
			failingKeeper := keeper.NewKeeper(fault, enc.Codec, f.addressCodec, authtypes.NewModuleAddress(types.GovModuleName), bank, MockAccountKeeper{})
			failing := keeper.NewMsgServerImpl(failingKeeper)
			before := sessionStoreSnapshot(t, ctx, f.storeService)
			events := ctx.EventManager().Events()
			cached, _ := ctx.CacheContext()
			_, err = failing.SubmitRetrievalSessionProof(cached, &types.MsgSubmitRetrievalSessionProof{Creator: created.AssignedProviders[0], SessionId: opened.SessionId, Proofs: []types.ChainedProof{proof}})
			require.Error(t, err)
			if failure == "insufficient bank" {
				require.ErrorContains(t, err, "insufficient cached settlement funds")
			} else {
				require.ErrorContains(t, err, "injected session store")
			}
			// Later failures occur after actual cached monetary writes; the test must
			// demonstrate rollback rather than merely failing before any side effect.
			if failure == "pin remove" || failure == "activity set" || failure == "insufficient bank" {
				burned, err := bank.amount(cached, "burned")
				require.NoError(t, err)
				require.True(t, burned.IsPositive())
			}
			require.Equal(t, before, sessionStoreSnapshot(t, ctx, f.storeService), "discarded transaction cache must preserve every state, balance and credit key")
			require.Equal(t, events, ctx.EventManager().Events())
		})
	}
}
