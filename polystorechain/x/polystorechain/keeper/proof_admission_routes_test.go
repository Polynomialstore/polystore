package keeper_test

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"testing"

	"cosmossdk.io/collections"
	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestNativeLegacyBatchPrepaysAllCrypto(t *testing.T) {
	env := setupBenchRetrievalEnv(t)
	data, err := os.ReadFile("testdata/proof_admission_k8.json")
	require.NoError(t, err)
	var fixture struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(t, json.Unmarshal(data, &fixture))
	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))
	key, err := gethCrypto.HexToECDSA("0000000000000000000000000000000000000000000000000000000000000001")
	require.NoError(t, err)
	deal := env.deal
	deal.Owner = sdk.AccAddress(gethCrypto.PubkeyToAddress(key.PublicKey).Bytes()).String()
	deal.ManifestRoot = fixture.Root
	deal.Mode2Profile = &types.StripeReplicaProfile{K: 8, M: 4}
	base := sdk.UnwrapSDKContext(env.f.ctx).WithBlockHeight(2)
	require.NoError(t, env.f.keeper.Deals.Set(base, deal.Id, deal))
	for _, invalid := range []int{-1, 0, 1, 2} {
		t.Run(fmt.Sprintf("invalid_%d", invalid), func(t *testing.T) {
			ctx, _ := base.CacheContext()
			ctx = ctx.WithGasMeter(storetypes.NewInfiniteGasMeter()).WithKVGasConfig(storetypes.GasConfig{}).WithTransientKVGasConfig(storetypes.GasConfig{})
			receipts := make([]types.RetrievalReceipt, 3)
			for i, p := range fixture.Proofs {
				if i == invalid {
					p.YValue = append([]byte{}, p.YValue...)
					p.YValue[31] ^= 1
				}
				r := types.RetrievalReceipt{DealId: deal.Id, EpochId: 1, Provider: env.provider, FilePath: fmt.Sprintf("file%d", i), RangeStart: 0, RangeLen: 1024, BytesServed: 1024, Nonce: 1, ExpiresAt: 20, ProofDetails: p}
				h, err := types.HashRetrievalReceiptV3(&r)
				require.NoError(t, err)
				d := types.ComputeEIP712Digest(types.HashDomainSeparator(new(big.Int).SetUint64(types.DefaultParams().Eip712ChainId)), h)
				r.UserSignature, err = gethCrypto.Sign(d, key)
				require.NoError(t, err)
				receipts[i] = r
			}
			msg := &types.MsgProveLiveness{Creator: env.provider, DealId: deal.Id, EpochId: 1, ProofType: &types.MsgProveLiveness_UserReceiptBatch{UserReceiptBatch: &types.RetrievalReceiptBatch{Receipts: receipts}}}
			_, err := env.msgServer.ProveLiveness(ctx, msg)
			if invalid < 0 {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, "invalid liveness proof")
			}
			require.Equal(t, 3*keeper.ProofCryptoGas, ctx.GasMeter().GasConsumed(), "invalid position must not discount declared crypto")
			// Child cache is deliberately not committed; neither partial nor successful
			// handler writes become parent state until the transaction succeeds.
			found, err := env.f.keeper.ReceiptNoncesByDealFile.Has(base, collections.Join(deal.Id, "file0"))
			require.NoError(t, err)
			require.False(t, found)
		})
	}
	// A cryptographically invalid first proof would return an error if entered.
	// Full-list prepayment instead exhausts this meter before either native call.
	p := fixture.Proofs[0]
	p.YValue = append([]byte{}, p.YValue...)
	p.YValue[31] ^= 1
	r := types.RetrievalReceipt{DealId: deal.Id, EpochId: 1, Provider: env.provider, FilePath: "smallgas", RangeLen: 1, BytesServed: 1, Nonce: 1, ProofDetails: p}
	ctx, _ := base.CacheContext()
	ctx = ctx.WithGasMeter(storetypes.NewGasMeter(keeper.ProofCryptoGas - 1)).WithKVGasConfig(storetypes.GasConfig{}).WithTransientKVGasConfig(storetypes.GasConfig{})
	require.Panics(t, func() {
		_, _ = env.msgServer.ProveLiveness(ctx, &types.MsgProveLiveness{Creator: env.provider, DealId: deal.Id, EpochId: 1, ProofType: &types.MsgProveLiveness_UserReceipt{UserReceipt: &r}})
	})
}

func TestLegacySessionWholeListGas(t *testing.T) {
	t.Setenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT", "1")
	t.Setenv("POLYSTORE_BENCH_FIXTURE_SERVICE_HINT", "General:rs=8+4")
	env := setupBenchRetrievalEnv(t)
	opened := env.openBenchSession(t, 1, 3)
	data, err := os.ReadFile("testdata/proof_admission_k8.json")
	require.NoError(t, err)
	var fixture struct {
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(t, json.Unmarshal(data, &fixture))
	for _, invalid := range []int{0, 1, 2, 3, 4} {
		t.Run(fmt.Sprintf("invalid_%d", invalid), func(t *testing.T) {
			ctx, _ := sdk.UnwrapSDKContext(env.f.ctx).CacheContext()
			meter := storetypes.NewGasMeter(3 * keeper.ProofCryptoGas)
			if invalid == 3 {
				meter = storetypes.NewGasMeter(3*keeper.ProofCryptoGas - 1)
			}
			ctx = ctx.WithGasMeter(meter).WithKVGasConfig(storetypes.GasConfig{}).WithTransientKVGasConfig(storetypes.GasConfig{})
			proofs := append([]types.ChainedProof{}, fixture.Proofs...)
			index := invalid
			if index > 2 {
				index = 0
			}
			proofs[index].YValue = append([]byte{}, proofs[index].YValue...)
			proofs[index].YValue[31] ^= 1
			if invalid == 4 {
				proofs[2].MerklePath = append(proofs[2].MerklePath, make([]byte, 32))
			}
			msg := &types.MsgSubmitRetrievalSessionProof{Creator: env.provider, SessionId: opened.SessionId, Proofs: proofs}
			if invalid == 3 {
				require.Panics(t, func() { _, _ = env.msgServer.SubmitRetrievalSessionProof(ctx, msg) })
				return
			}
			_, err := env.msgServer.SubmitRetrievalSessionProof(ctx, msg)
			if invalid == 4 {
				require.ErrorContains(t, err, "consumed siblings")
				require.Zero(t, meter.GasConsumed())
				return
			}
			require.ErrorContains(t, err, "invalid retrieval proof")
			require.Equal(t, 3*keeper.ProofCryptoGas, meter.GasConsumed())
		})
	}
}
