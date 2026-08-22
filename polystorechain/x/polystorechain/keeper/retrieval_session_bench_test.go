package keeper_test

// Deterministic retrieval-session throughput benchmarks (issue #245).
//
// These benchmarks reuse the exact fixture/construction pattern of
// msg_server_retrieval_sessions_test.go and retrieval_proof_helpers_test.go:
// initFixture-style in-memory keeper, registered providers, one funded deal,
// and a single family of valid Mode 2 chained proofs built through crypto_ffi.
//
// Local *testing.TB-compatible copies of the *testing.T-typed helpers live at
// the bottom of this file (Go does not let us pass a *testing.B where a
// *testing.T is declared); their bodies are verbatim adaptations.
//
// Gas accounting is deliberately separated from wall-clock timing: gas is read
// off the context meter around each measured op and accumulated separately,
// then reported as a custom "gas/op" metric. Sessions needed by the submit /
// confirm benchmarks are opened BEFORE the timed loop so the timer only sees
// the operation under measurement.

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/testutil"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	storetypes "cosmossdk.io/store/types"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/blake2s"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

const benchTargetMduIndex = uint64(2) // MDU #0 metadata + one witness MDU, then first user MDU.
const benchWitnessMdus = uint64(1)

type benchRetrievalEnv struct {
	f         *fixture
	msgServer types.MsgServer
	owner     string
	provider  string
	dealID    uint64
	deal      types.Deal

	k         uint64
	m         uint64
	rows      uint64
	leafCount uint64

	mduData     []byte
	witnessFlat []byte
	shards      [][]byte
	mduRoot     []byte

	rootTableDuCommitment []byte
	rootTableDuMerklePath [][]byte
	rootTableOpening      []byte
}

func benchGasConsumed(ctx context.Context) uint64 {
	return sdk.UnwrapSDKContext(ctx).GasMeter().GasConsumed()
}

func setupBenchRetrievalEnv(tb testing.TB) *benchRetrievalEnv {
	tb.Helper()

	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		tb.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping retrieval session benchmark")
	}

	f := newBenchFixture(tb)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register enough providers for placement (same pattern as lifecycle tests).
	for i := range 10 {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte("bench_provider___"))
		addrBz[16] = byte('A' + i)
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(tb, err)
	}

	privOwnerBz := make([]byte, 20)
	copy(privOwnerBz, []byte("bench_owner_______"))
	owner, _ := f.addressCodec.BytesToString(privOwnerBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(100000000),
		MaxMonthlySpend:     math.NewInt(10000000),
	})
	require.NoError(tb, err)
	require.NotEmpty(tb, resDeal.AssignedProviders)

	require.NoError(tb, crypto_ffi.Init("../../../trusted_setup.txt"))

	mduData := make([]byte, 8*1024*1024)
	dealAfterCreate, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(tb, err)
	require.NotNil(tb, dealAfterCreate.Mode2Profile)
	k := uint64(dealAfterCreate.Mode2Profile.K)
	m := uint64(dealAfterCreate.Mode2Profile.M)
	rows := uint64(64) / k

	witnessFlat, shards, err := crypto_ffi.ExpandMduRs(mduData, k, m)
	require.NoError(tb, err)
	root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
	require.NoError(tb, err)

	polyfsCid, mdu0 := benchBuildPolyFSMdu0(tb, map[uint64][]byte{benchTargetMduIndex: root})
	rootTableDuCommitment, rootTableDuMerklePath, rootTableOpening := benchMdu0RootTableProof(tb, mdu0, benchTargetMduIndex, root)

	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         polyfsCid,
		Size_:       8 * 1024 * 1024,
		TotalMdus:   4,
		WitnessMdus: benchWitnessMdus,
	})
	require.NoError(tb, err)

	deal, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(tb, err)
	require.Len(tb, deal.ManifestRoot, types.POLYFS_ROOT_SIZE)

	return &benchRetrievalEnv{
		f:                     f,
		msgServer:             msgServer,
		owner:                 owner,
		provider:              resDeal.AssignedProviders[0],
		dealID:                resDeal.DealId,
		deal:                  deal,
		k:                     k,
		m:                     m,
		rows:                  rows,
		leafCount:             (k + m) * rows,
		mduData:               mduData,
		witnessFlat:           witnessFlat,
		shards:                shards,
		mduRoot:               root,
		rootTableDuCommitment: rootTableDuCommitment,
		rootTableDuMerklePath: rootTableDuMerklePath,
		rootTableOpening:      rootTableOpening,
	}
}

// benchBuildChainedProof constructs a valid ChainedProof for leafIndex within
// the committed MDU, mirroring commitValidMode2ContentAndProof's construction.
func (e *benchRetrievalEnv) benchBuildChainedProof(tb testing.TB, leafIndex uint64, zHint uint64) types.ChainedProof {
	tb.Helper()
	require.True(tb, leafIndex < e.leafCount, "leafIndex out of range")

	path := benchMerklePathFromWitnessFlat(tb, e.witnessFlat, leafIndex)
	commitmentOff := int(leafIndex) * 48
	blobCommitment := make([]byte, 48)
	copy(blobCommitment, e.witnessFlat[commitmentOff:commitmentOff+48])

	slot := leafIndex / e.rows
	row := leafIndex % e.rows
	blobBytes := benchBlobBytesForLeaf(tb, e.mduData, e.shards, e.k, slot, row)

	z := make([]byte, 32)
	z[0] = 42
	z[1] = byte(slot & 0xFF)
	var zb [8]byte
	binary.BigEndian.PutUint64(zb[:], zHint)
	copy(z[2:10], zb[:])

	kzgProof, y, err := crypto_ffi.ComputeBlobProof(blobBytes, z)
	require.NoError(tb, err)

	return types.ChainedProof{
		MduIndex:              benchTargetMduIndex,
		MduRootFr:             e.mduRoot,
		ManifestOpening:       e.rootTableOpening,
		RootTableDuCommitment: e.rootTableDuCommitment,
		RootTableDuMerklePath: e.rootTableDuMerklePath,
		BlobCommitment:        blobCommitment,
		MerklePath:            path,
		BlobIndex:             uint32(leafIndex),
		ZValue:                z,
		YValue:                y,
		KzgOpeningProof:       kzgProof,
	}
}

func (e *benchRetrievalEnv) openBenchSession(tb testing.TB, nonce uint64, blobCount uint64) *types.MsgOpenRetrievalSessionResponse {
	tb.Helper()
	openRes, err := e.msgServer.OpenRetrievalSession(e.f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        e.owner,
		DealId:         e.dealID,
		Provider:       e.provider,
		ManifestRoot:   e.deal.ManifestRoot,
		StartMduIndex:  benchTargetMduIndex,
		StartBlobIndex: 0,
		BlobCount:      blobCount,
		Nonce:          nonce,
		ExpiresAt:      0,
	})
	require.NoError(tb, err)
	require.Len(tb, openRes.SessionId, 32)
	return openRes
}

func BenchmarkOpenRetrievalSession(b *testing.B) {
	env := setupBenchRetrievalEnv(b)

	var totalGas uint64
	// b.Loop gives no index; track our own counter for unique nonces.
	nonce := uint64(0)
	var gasBefore uint64
	for b.Loop() {
		gasBefore = benchGasConsumed(env.f.ctx)
		openRes, err := env.msgServer.OpenRetrievalSession(env.f.ctx, &types.MsgOpenRetrievalSession{
			Creator:        env.owner,
			DealId:         env.dealID,
			Provider:       env.provider,
			ManifestRoot:   env.deal.ManifestRoot,
			StartMduIndex:  benchTargetMduIndex,
			StartBlobIndex: 0,
			BlobCount:      1,
			Nonce:          nonce + 1, // unique nonce per op: nonce replays are rejected
			ExpiresAt:      0,
		})
		totalGas += benchGasConsumed(env.f.ctx) - gasBefore
		nonce++
		if err != nil {
			b.Fatalf("OpenRetrievalSession failed: %v", err)
		}
		if len(openRes.SessionId) != 32 {
			b.Fatalf("unexpected session id length %d", len(openRes.SessionId))
		}
	}

	gasPerOp := float64(totalGas) / float64(nonce)
	if gasPerOp <= 0 {
		b.Fatalf("sanity: zero average gas (%v) over %d opens", gasPerOp, nonce)
	}
	b.ReportMetric(gasPerOp, "gas/op")
}

type benchSessionPlan struct {
	sessionID []byte
	creator   string
	proofs    []types.ChainedProof
}

func (e *benchRetrievalEnv) slotProvider(tb testing.TB, slot uint64) string {
	tb.Helper()
	if int(slot) < len(e.deal.Mode2Slots) && e.deal.Mode2Slots[slot] != nil {
		return e.deal.Mode2Slots[slot].Provider
	}
	require.Less(tb, int(slot), len(e.deal.Providers))
	return e.deal.Providers[slot]
}

// buildBenchSubmitPlan opens the sessions needed to deliver `count` chained
// proofs. Mode 2 caps each session's blob range at a single placement slot
// (rows blobs), so proofs are spread across ceil(count/rows) slot-scoped
// sessions, each opened with the provider assigned to that slot.
func buildBenchSubmitPlan(
	tb testing.TB,
	env *benchRetrievalEnv,
	nonceBase uint64,
	count int,
) []benchSessionPlan {
	tb.Helper()
	plan := make([]benchSessionPlan, 0, (count+int(env.rows)-1)/int(env.rows))
	leaf := uint64(0)
	nonce := nonceBase
	for emitted := 0; emitted < count; {
		n := count - emitted
		if n > int(env.rows) {
			n = int(env.rows)
		}
		slot := leaf / env.rows
		provider := env.slotProvider(tb, slot)

		proofs := make([]types.ChainedProof, n)
		for i := range n {
			proofs[i] = env.benchBuildChainedProof(tb, leaf, leaf+100)
			leaf++
		}

		openRes, err := env.msgServer.OpenRetrievalSession(env.f.ctx, &types.MsgOpenRetrievalSession{
			Creator:        env.owner,
			DealId:         env.dealID,
			Provider:       provider,
			ManifestRoot:   env.deal.ManifestRoot,
			StartMduIndex:  benchTargetMduIndex,
			StartBlobIndex: uint32(proofs[0].BlobIndex),
			BlobCount:      uint64(n),
			Nonce:          nonce,
			ExpiresAt:      0,
		})
		require.NoError(tb, err)
		nonce++
		emitted += n
		plan = append(plan, benchSessionPlan{sessionID: openRes.SessionId, creator: provider, proofs: proofs})
	}
	return plan
}


func BenchmarkSubmitRetrievalSessionProof(b *testing.B) {
	for _, count := range []int{1, 8, 64} {
		b.Run(fmt.Sprintf("proofs-%d", count), func(b *testing.B) {
			env := setupBenchRetrievalEnv(b)
			require.GreaterOrEqual(b, env.leafCount, uint64(count))

			// Lazily prepare one fresh session plan per measured iteration. b.Loop
			// may expand beyond the initial b.N target.
			plans := make([][]benchSessionPlan, 0, b.N)

			b.ReportMetric(float64(count), "proofs/op")
			iter := 0
			var totalGas uint64
			for b.Loop() {
				if iter == len(plans) {
					b.StopTimer()
					plans = append(plans, buildBenchSubmitPlan(b, env, uint64(iter)*1000+1, count))
					b.StartTimer()
				}
				plan := plans[iter]
				iter++

				for _, step := range plan {
					gasBefore := benchGasConsumed(env.f.ctx)
					res, err := env.msgServer.SubmitRetrievalSessionProof(env.f.ctx, &types.MsgSubmitRetrievalSessionProof{
						Creator:   step.creator,
						SessionId: step.sessionID,
						Proofs:    step.proofs,
					})
					totalGas += benchGasConsumed(env.f.ctx) - gasBefore
					if err != nil {
						b.Fatalf("SubmitRetrievalSessionProof failed: %v", err)
					}
					if !res.Success {
						b.Fatal("sanity: submit did not report success")
					}
				}
			}

			gasPerProof := float64(totalGas) / float64(iter*count)
			if gasPerProof <= 0 {
				b.Fatalf("sanity: zero average gas (%v) over %d proofs", gasPerProof, iter*count)
			}
			b.ReportMetric(gasPerProof*float64(count), "gas/op")
		})

		// FFI-wrapper isolation probe: measures ONLY the cumulative crypto_ffi
		// verification cost of `count` chained proofs. The timed loop calls the
		// same two exported FFI entry points keeper.verifyPolyFSChainedProof
		// uses, with all Merkle paths flattened before timing; it excludes
		// keeper/state access and gas metering.
		b.Run(fmt.Sprintf("ffi-verify-only-%d", count), func(b *testing.B) {
			env := setupBenchRetrievalEnv(b)
			proofs := make([]types.ChainedProof, count)
			rootTableMerklePaths := make([][]byte, count)
			merklePaths := make([][]byte, count)
			for i := range count {
				proofs[i] = env.benchBuildChainedProof(b, uint64(i), uint64(i)+100)
				rootTableMerklePaths[i] = benchFlattenPath(proofs[i].RootTableDuMerklePath)
				merklePaths[i] = benchFlattenPath(proofs[i].MerklePath)
			}

			b.ReportMetric(float64(count), "proofs/op")
			for b.Loop() {
				for j := range count {
					p := &proofs[j]
					ok, err := crypto_ffi.VerifyMdu0RootTableProof(
						env.deal.ManifestRoot,
						p.MduIndex,
						p.MduRootFr,
						p.RootTableDuCommitment,
						rootTableMerklePaths[j],
						p.ManifestOpening,
					)
					if err != nil || !ok {
						b.Fatalf("hop1 verify failed: ok=%v err=%v", ok, err)
					}
					ok, err = crypto_ffi.VerifyMduProof(
						p.MduRootFr,
						p.BlobCommitment,
						merklePaths[j],
						p.BlobIndex,
						env.leafCount,
						p.ZValue,
						p.YValue,
						p.KzgOpeningProof,
					)
					if err != nil || !ok {
						b.Fatalf("hop3 verify failed: ok=%v err=%v", ok, err)
					}
				}
			}
		})
	}
}

func BenchmarkConfirmRetrievalSession(b *testing.B) {
	env := setupBenchRetrievalEnv(b)

	// Lazily preopen one fresh OPEN session per measured iteration. b.Loop may
	// expand beyond the initial b.N target.
	sessions := make([][]byte, 0, b.N)
	idx := 0
	var totalGas uint64
	for b.Loop() {
		if idx == len(sessions) {
			b.StopTimer()
			sessions = append(sessions, env.openBenchSession(b, uint64(idx)+1, 1).SessionId)
			b.StartTimer()
		}
		session := sessions[idx]
		idx++

		gasBefore := benchGasConsumed(env.f.ctx)
		_, err := env.msgServer.ConfirmRetrievalSession(env.f.ctx, &types.MsgConfirmRetrievalSession{
			Creator:   env.owner,
			SessionId: session,
		})
		totalGas += benchGasConsumed(env.f.ctx) - gasBefore
		if err != nil {
			b.Fatalf("ConfirmRetrievalSession failed: %v", err)
		}
	}

	gasPerOp := float64(totalGas) / float64(idx)
	if gasPerOp <= 0 {
		b.Fatalf("sanity: zero average gas (%v) over %d confirms", gasPerOp, idx)
	}
	b.ReportMetric(gasPerOp, "gas/op")
}

// TestRetrievalSessionBenchCharacterization bounds benchmark correctness:
// every message type consumes positive gas, and submit-proof gas is
// monotonically non-decreasing in proof count (gas is deterministic, so this
// comparison is exact rather than statistical).
func TestRetrievalSessionBenchCharacterization(t *testing.T) {
	env := setupBenchRetrievalEnv(t)

	// Open: positive gas.
	gasBefore := benchGasConsumed(env.f.ctx)
	_, err := env.msgServer.OpenRetrievalSession(env.f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        env.owner,
		DealId:         env.dealID,
		Provider:       env.provider,
		ManifestRoot:   env.deal.ManifestRoot,
		StartMduIndex:  benchTargetMduIndex,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
	})
	require.NoError(t, err)
	openGas := benchGasConsumed(env.f.ctx) - gasBefore
	require.Greater(t, openGas, uint64(0), "OpenRetrievalSession must consume gas")

	// Confirm: positive gas (fresh OPEN session).
	gasBefore = benchGasConsumed(env.f.ctx)
	_, err = env.msgServer.ConfirmRetrievalSession(env.f.ctx, &types.MsgConfirmRetrievalSession{
		Creator:   env.owner,
		SessionId: env.openBenchSession(t, 2, 1).SessionId,
	})
	require.NoError(t, err)
	confirmGas := benchGasConsumed(env.f.ctx) - gasBefore
	require.Greater(t, confirmGas, uint64(0), "ConfirmRetrievalSession must consume gas")

	// Cancel: positive gas. Cancel only succeeds on an EXPIRED session, so
	// open with ExpiresAt=1 and cancel at a later block height (same pattern
	// as TestRetrievalSession_LocksFeesAndCancels).
	cancelCtx := sdk.UnwrapSDKContext(env.f.ctx).WithBlockHeight(10)
	cancelRes, err := env.msgServer.OpenRetrievalSession(env.f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        env.owner,
		DealId:         env.dealID,
		Provider:       env.provider,
		ManifestRoot:   env.deal.ManifestRoot,
		StartMduIndex:  benchTargetMduIndex,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          3,
		ExpiresAt:      1,
	})
	require.NoError(t, err)

	gasBefore = benchGasConsumed(cancelCtx)
	_, err = env.msgServer.CancelRetrievalSession(cancelCtx, &types.MsgCancelRetrievalSession{
		Creator:   env.owner,
		SessionId: cancelRes.SessionId,
	})
	require.NoError(t, err)
	cancelGas := benchGasConsumed(cancelCtx) - gasBefore
	require.Greater(t, cancelGas, uint64(0), "CancelRetrievalSession must consume gas")

	// Submit: positive gas and monotone non-decreasing in proof count. Mode 2
	// sessions are slot-scoped, so each count is delivered via its session
	// plan and gas is summed over every message in the plan.
	submitGas := make(map[int]uint64)
	for _, count := range []int{1, 8, 64} {
		plan := buildBenchSubmitPlan(t, env, uint64(count)+100, count)
		var totalGas uint64
		for _, step := range plan {
			gasBefore = benchGasConsumed(env.f.ctx)
			_, err := env.msgServer.SubmitRetrievalSessionProof(env.f.ctx, &types.MsgSubmitRetrievalSessionProof{
				Creator:   step.creator,
				SessionId: step.sessionID,
				Proofs:    step.proofs,
			})
			require.NoError(t, err)
			totalGas += benchGasConsumed(env.f.ctx) - gasBefore
		}
		require.Greater(t, totalGas, uint64(0), "SubmitRetrievalSessionProof must consume gas")
		submitGas[count] = totalGas
		t.Logf("submit proofs=%d gas=%d", count, submitGas[count])
	}
	require.LessOrEqual(t, submitGas[1], submitGas[8], "submit gas must be non-decreasing in proof count")
	require.LessOrEqual(t, submitGas[8], submitGas[64], "submit gas must be non-decreasing in proof count")

	// Wall-clock sanity (ns/op > 0) is inherent to the benchmarks themselves;
	// here we additionally assert the FFI hop-verify path succeeds standalone.
	proof := env.benchBuildChainedProof(t, 0, 7)
	ok, err := crypto_ffi.VerifyMdu0RootTableProof(
		env.deal.ManifestRoot, proof.MduIndex, proof.MduRootFr,
		proof.RootTableDuCommitment, benchFlattenPath(proof.RootTableDuMerklePath), proof.ManifestOpening)
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = crypto_ffi.VerifyMduProof(
		proof.MduRootFr, proof.BlobCommitment, benchFlattenPath(proof.MerklePath),
		proof.BlobIndex, env.leafCount, proof.ZValue, proof.YValue, proof.KzgOpeningProof)
	require.NoError(t, err)
	require.True(t, ok)
}

// ---------------------------------------------------------------------------
// *testing.TB-compatible copies of the *testing.T-typed fixture helpers.
// Bodies follow keeper_test.go initFixture, msg_server_test.go polyfs helpers,
// and mode2_proof_test.go merkle/blob helpers verbatim.
// ---------------------------------------------------------------------------

func newBenchFixture(tb testing.TB) *fixture {
	tb.Helper()

	encCfg := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
	addressCodec := addresscodec.NewBech32Codec(sdk.GetConfig().GetBech32AccountAddrPrefix())
	storeKey := storetypes.NewKVStoreKey(types.StoreKey)

	storeService := runtime.NewKVStoreService(storeKey)
	ctx := testutil.DefaultContextWithDB(tb, storeKey, storetypes.NewTransientStoreKey("transient_test")).Ctx

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx = sdkCtx.WithChainID("test-chain")
	ctx = sdkCtx

	authority := authtypes.NewModuleAddress(types.GovModuleName)

	k := keeper.NewKeeper(
		storeService,
		encCfg.Codec,
		addressCodec,
		authority,
		MockBankKeeper{},
		MockAccountKeeper{},
	)

	if err := k.Params.Set(ctx, types.DefaultParams()); err != nil {
		tb.Fatalf("failed to set params: %v", err)
	}

	return &fixture{ctx: ctx, keeper: k, addressCodec: addressCodec}
}

func benchBuildPolyFSMdu0(tb testing.TB, rootsByMdu map[uint64][]byte) (cid string, mdu0 []byte) {
	tb.Helper()
	require.NotEmpty(tb, rootsByMdu)

	mdu0 = make([]byte, types.MDU_SIZE)
	rootsByDu := make(map[uint64][][]byte)
	for mduIndex, root := range rootsByMdu {
		require.Len(tb, root, 32)
		du, cell := benchRootTablePositionForMduIndex(tb, mduIndex)
		require.Less(tb, du, uint64(16), "MDU root table supports 16 DUs")
		roots := rootsByDu[du]
		for uint64(len(roots)) <= cell {
			roots = append(roots, make([]byte, 32))
		}
		roots[cell] = root
		rootsByDu[du] = roots
	}

	for du, roots := range rootsByDu {
		_, blob := benchComputeManifestCid(tb, roots)
		start := int(du) * types.BLOB_SIZE
		copy(mdu0[start:start+types.BLOB_SIZE], blob)
	}

	polyfsRoot, err := crypto_ffi.ComputeMduMerkleRoot(mdu0)
	require.NoError(tb, err)
	return "0x" + hex.EncodeToString(polyfsRoot), mdu0
}

func benchComputeManifestCid(tb testing.TB, mduRoots [][]byte) (cid string, manifestBlob []byte) {
	tb.Helper()
	commitment, blob, err := crypto_ffi.ComputeManifestCommitment(mduRoots)
	require.NoError(tb, err)
	return "0x" + hex.EncodeToString(commitment), blob
}

func benchRootTablePositionForMduIndex(tb testing.TB, mduIndex uint64) (du uint64, cell uint64) {
	tb.Helper()
	require.GreaterOrEqual(tb, mduIndex, uint64(1), "MDU #0 is metadata and is not represented in its root table")
	idx := mduIndex - 1
	return idx / 4096, idx % 4096
}

func benchMdu0RootTableProof(
	tb testing.TB,
	mdu0 []byte,
	mduIndex uint64,
	targetMduRoot []byte,
) (rootTableDuCommitment []byte, rootTableDuMerklePath [][]byte, rootTableOpening []byte) {
	tb.Helper()
	duCommitment, duMerkleFlat, opening, _, err := crypto_ffi.ComputeMdu0RootTableProof(mdu0, mduIndex, targetMduRoot)
	require.NoError(tb, err)
	return duCommitment, benchSplitFlatPath(tb, duMerkleFlat), opening
}

func benchSplitFlatPath(tb testing.TB, flat []byte) [][]byte {
	tb.Helper()
	require.NotEmpty(tb, flat)
	require.Equal(tb, 0, len(flat)%32)
	out := make([][]byte, 0, len(flat)/32)
	for off := 0; off < len(flat); off += 32 {
		node := make([]byte, 32)
		copy(node, flat[off:off+32])
		out = append(out, node)
	}
	return out
}

func benchFlattenPath(path [][]byte) []byte {
	n := 0
	for _, p := range path {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range path {
		out = append(out, p...)
	}
	return out
}

func benchMerklePathFromWitnessFlat(tb testing.TB, witnessFlat []byte, leafIndex uint64) [][]byte {
	tb.Helper()
	require.True(tb, len(witnessFlat) > 0 && len(witnessFlat)%48 == 0, "witnessFlat must be a non-empty multiple of 48 bytes")
	leafCount := len(witnessFlat) / 48
	require.True(tb, int(leafIndex) >= 0 && int(leafIndex) < leafCount, "leafIndex out of range")

	level := make([][32]byte, 0, leafCount)
	for i := 0; i < len(witnessFlat); i += 48 {
		level = append(level, blake2s.Sum256(witnessFlat[i:i+48]))
	}
	idx := int(leafIndex)

	path := make([][]byte, 0, 10)
	for len(level) > 1 {
		if idx%2 == 0 {
			if idx+1 < len(level) {
				h := make([]byte, 32)
				copy(h, level[idx+1][:])
				path = append(path, h)
			}
		} else {
			h := make([]byte, 32)
			copy(h, level[idx-1][:])
			path = append(path, h)
		}

		next := make([][32]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			left := level[i]
			if i+1 < len(level) {
				right := level[i+1]
				var pair [64]byte
				copy(pair[:32], left[:])
				copy(pair[32:], right[:])
				next = append(next, blake2s.Sum256(pair[:]))
				continue
			}
			// rs_merkle propagates the left node when no sibling exists.
			next = append(next, left)
		}
		level = next
		idx /= 2
	}
	return path
}

func benchBlobBytesForLeaf(tb testing.TB, mduBytes []byte, shards [][]byte, k uint64, slot uint64, row uint64) []byte {
	tb.Helper()
	rows := uint64(64) / k
	require.True(tb, row < rows, "row out of range")
	require.True(tb, k > 0 && slot < uint64(len(shards)), "slot out of range")

	// Data slots map directly back to original MDU blobs.
	if slot < k {
		blobIndex := row*k + slot
		off := int(blobIndex) * types.BLOB_SIZE
		end := off + types.BLOB_SIZE
		require.True(tb, end <= len(mduBytes), "blob slice out of range")
		blob := make([]byte, types.BLOB_SIZE)
		copy(blob, mduBytes[off:end])
		return blob
	}

	// Parity slots come from RS expansion shards.
	shard := shards[slot]
	require.Len(tb, shard, int(rows)*types.BLOB_SIZE, "shard length mismatch")
	off := int(row) * types.BLOB_SIZE
	end := off + types.BLOB_SIZE
	blob := make([]byte, types.BLOB_SIZE)
	copy(blob, shard[off:end])
	return blob
}
