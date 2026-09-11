package polystore

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func setupPrecompileSessionV3(t *testing.T) (*testFixture, *Precompile, common.Address, types.Deal) {
	t.Helper()
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)
	f.ctx = ctx
	owner := common.HexToAddress("0x1100000000000000000000000000000000000011")
	ownerNative := sdk.AccAddress(owner.Bytes()).String()
	providers := make([]string, 12)
	slots := make([]*types.DealSlot, 12)
	for i := range providers {
		provider := sdk.AccAddress(bytes.Repeat([]byte{byte(0x20 + i)}, 20)).String()
		providers[i] = provider
		slots[i] = &types.DealSlot{Slot: uint32(i), Provider: provider, Status: types.SlotStatus_SLOT_STATUS_ACTIVE}
		require.NoError(t, f.keeper.Providers.Set(ctx, provider, types.Provider{Address: provider, Status: "Active"}))
	}
	root := bytes.Repeat([]byte{0x31}, 32)
	deal := types.Deal{
		Id: 7, Owner: ownerNative, ManifestRoot: root, Size_: 64 * 126976,
		EscrowBalance: math.NewInt(100), StartBlock: 1, EndBlock: 100, CurrentGen: 4,
		TotalMdus: 3, WitnessMdus: 1, RedundancyMode: 2,
		Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}, Mode2Slots: slots,
		MaxMonthlySpend: math.ZeroInt(), SpendWindowSpent: math.ZeroInt(),
	}
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	require.NoError(t, err)
	require.NoError(t, f.keeper.RetrievalV2ActivatedHeight.Set(ctx, 1))
	require.NoError(t, f.keeper.RetrievalV3ActivatedHeight.Set(ctx, 1))
	params := f.keeper.GetParams(ctx)
	require.NoError(t, f.keeper.StorageAuditEpochLength.Set(ctx, params.EpochLenBlocks))
	require.NoError(t, f.keeper.AdmittedDealGenerationsV3.Set(ctx, deal.Id, types.DealGenerationAdmissionV3{
		DealId: deal.Id, Owner: deal.Owner, Generation: deal.CurrentGen,
		PreviousPolyfsRoot: bytes.Repeat([]byte{0x30}, 32), PolyfsRoot: root,
		IntegrityRoot: bytes.Repeat([]byte{0x32}, 32), Size_: deal.Size_, TotalMdus: deal.TotalMdus,
		WitnessMdus: deal.WitnessMdus, MetadataMdus: 2, UserMdus: 1, IntegrityLeafCount: 96,
		SetupDigest: setup, Providers: providers, AcceptedSlotsMask: (1 << 12) - 1, ChainId: ctx.ChainID(),
	}))
	p, err := New(&f.keeper)
	require.NoError(t, err)
	return f, p, owner, deal
}

func TestRetrievalV3ABIAndConversions(t *testing.T) {
	f, p, _, _ := setupPrecompileSessionV3(t)
	_ = f
	want := map[string]int{
		"proposeDealGenerationV3": 9, "acceptDealGenerationV3": 3, "finalizeDealGenerationV3": 3,
		"openRetrievalSessionV3": 5, "openRetrievalSessionV3Sponsored": 18,
		"submitRetrievalSessionProofV3": 3, "acknowledgeRetrievalObligationV3": 3, "refundRetrievalSessionV3": 1,
	}
	for name, inputs := range want {
		method, ok := p.abi.Methods[name]
		require.True(t, ok, name)
		require.Equal(t, "nonpayable", method.StateMutability, name)
		require.Len(t, method.Inputs, inputs, name)
	}
	require.Contains(t, p.abi.Events, "RetrievalSessionV3Opened")

	native := nativeProof(sessionProofInput{
		MduIndex: 3, MduRootFr: []byte{1}, ManifestOpening: []byte{2}, RootTableDuCommitment: []byte{3},
		RootTableDuMerklePath: [][]byte{{4}}, BlobCommitment: []byte{5}, MerklePath: [][]byte{{6}},
		BlobIndex: 7, ZValue: []byte{8}, YValue: []byte{9}, KzgOpeningProof: []byte{10},
	})
	require.Equal(t, uint64(3), native.MduIndex)
	require.Equal(t, uint32(7), native.BlobIndex)
	require.Equal(t, []byte{10}, native.KzgOpeningProof)

	allowlist := &types.MsgOpenRetrievalSessionV3Sponsored{}
	require.NoError(t, applySponsoredRetrievalV3Auth(allowlist, sponsoredRetrievalV3Input{
		AuthType: 1, AllowlistLeafIndex: 9, AllowlistMerklePath: []common.Hash{common.HexToHash("0x12")},
	}))
	require.Equal(t, uint32(9), allowlist.GetAllowlistProof().LeafIndex)
	require.Equal(t, common.HexToHash("0x12").Bytes(), allowlist.GetAllowlistProof().MerklePath[0])

	voucher := &types.MsgOpenRetrievalSessionV3Sponsored{}
	require.NoError(t, applySponsoredRetrievalV3Auth(voucher, sponsoredRetrievalV3Input{
		DealId: 7, AuthType: 2, VoucherManifestRoot: bytes.Repeat([]byte{0x44}, 32),
		VoucherProvider: "provider", VoucherStartMduIndex: 11, VoucherStartBlobIndex: 12,
		VoucherBlobCount: 13, VoucherExpiresAt: 14, VoucherNonce: 15,
		VoucherRedeemer: "redeemer", VoucherSignature: []byte{16},
	}))
	got := voucher.GetVoucher()
	require.Equal(t, uint64(7), got.DealId)
	require.Equal(t, bytes.Repeat([]byte{0x44}, 32), got.ManifestRoot)
	require.Equal(t, uint64(11), got.StartMduIndex)
	require.Equal(t, uint32(12), got.StartBlobIndex)
	require.Equal(t, uint64(13), got.BlobCount)
	require.Equal(t, []byte{16}, got.Signature)
	require.Error(t, applySponsoredRetrievalV3Auth(&types.MsgOpenRetrievalSessionV3Sponsored{}, sponsoredRetrievalV3Input{AuthType: 3}))
}

func TestOpenRetrievalSessionV3DispatchReplayAndCallerAuthority(t *testing.T) {
	f, p, owner, deal := setupPrecompileSessionV3(t)
	method := p.abi.Methods["openRetrievalSessionV3"]
	rangeArg := retrievalRangeV3Input{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024}
	args, err := method.Inputs.Pack(deal.Id, deal.CurrentGen, rangeArg, uint64(1), uint64(20))
	require.NoError(t, err)
	call := func(caller common.Address, value uint64, packed []byte) ([]byte, error) {
		contract := vm.NewPrecompile(caller, Address, uint256.NewInt(value), 8_000_000)
		contract.Input = append(append([]byte(nil), method.ID...), packed...)
		return p.runNative(sdk.UnwrapSDKContext(f.ctx), nil, contract)
	}

	out, err := call(owner, 0, args)
	require.NoError(t, err)
	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Len(t, decoded, 4)
	sid := decoded[0].([32]byte)
	require.NotEqual(t, [32]byte{}, sid)
	require.Equal(t, uint64(1024), decoded[1])
	stored, err := f.keeper.RetrievalSessionsV3.Get(sdk.UnwrapSDKContext(f.ctx), sid[:])
	require.NoError(t, err)
	require.Equal(t, deal.Owner, stored.Owner)
	charged, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), deal.Id)
	require.NoError(t, err)

	replayed, err := call(owner, 0, args)
	require.NoError(t, err)
	require.Equal(t, out, replayed)
	afterReplay, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), deal.Id)
	require.NoError(t, err)
	require.Equal(t, charged.EscrowBalance, afterReplay.EscrowBalance)

	changed, err := method.Inputs.Pack(deal.Id, deal.CurrentGen,
		retrievalRangeV3Input{FileRecordIndex: 1, FileLength: 2048, RangeLength: 2048}, uint64(1), uint64(20))
	require.NoError(t, err)
	_, err = call(owner, 0, changed)
	require.ErrorContains(t, err, "nonce")
	_, err = call(common.HexToAddress("0x2200000000000000000000000000000000000022"), 0, args)
	require.Error(t, err)
	_, err = call(owner, 1, args)
	require.ErrorContains(t, err, "nonpayable")
}

func runV3Method(t *testing.T, p *Precompile, ctx sdk.Context, caller common.Address, name string, args ...interface{}) []byte {
	t.Helper()
	method := p.abi.Methods[name]
	packed, err := method.Inputs.Pack(args...)
	require.NoError(t, err)
	contract := vm.NewPrecompile(caller, Address, uint256.NewInt(0), 20_000_000)
	contract.Input = append(append([]byte(nil), method.ID...), packed...)
	out, err := p.runNative(ctx, nil, contract)
	require.NoError(t, err)
	return out
}

func generationAcceptanceDigestV3(t *testing.T, candidate types.DealGenerationAdmissionV3, slot uint32) []byte {
	t.Helper()
	provider, err := sdk.AccAddressFromBech32(candidate.Providers[slot])
	require.NoError(t, err)
	var setup, root, integrity [32]byte
	var provider20 [20]byte
	copy(setup[:], candidate.SetupDigest)
	copy(root[:], candidate.PolyfsRoot)
	copy(integrity[:], candidate.IntegrityRoot)
	copy(provider20[:], provider)
	digest, err := (retrievalchallenge.GenerationAcceptanceV3{
		ChainID: candidate.ChainId, SetupDigest: setup, DealID: candidate.DealId,
		Generation: candidate.Generation, PolyFSRoot: root, IntegrityRoot: integrity,
		MetadataMDUs: candidate.MetadataMdus, UserMDUs: candidate.UserMdus,
		Slot: slot, Provider: provider20,
	}).Hash()
	require.NoError(t, err)
	return digest[:]
}

func obligationAckDigestV3(t *testing.T, session types.RetrievalSessionV3, slot uint32) []byte {
	t.Helper()
	var obligation *types.RetrievalObligationV3
	for i := range session.Obligations {
		if session.Obligations[i].Slot == slot {
			obligation = &session.Obligations[i]
			break
		}
	}
	require.NotNil(t, obligation)
	assigned, err := sdk.AccAddressFromBech32(obligation.AssignedProvider)
	require.NoError(t, err)
	payee, err := sdk.AccAddressFromBech32(obligation.Payee)
	require.NoError(t, err)
	var sid, contextHash, planHash, integrity [32]byte
	var assigned20, payee20 [20]byte
	copy(sid[:], session.SessionId)
	copy(contextHash[:], session.ContextHash)
	copy(planHash[:], session.PlanHash)
	copy(integrity[:], session.IntegrityRoot)
	copy(assigned20[:], assigned)
	copy(payee20[:], payee)
	digest, err := (retrievalchallenge.ObligationAckV3{
		ChainID: session.ChainId, SessionID: sid, ContextHash: contextHash, PlanHash: planHash,
		Slot: slot, Assigned: assigned20, Payee: payee20, BlobCount: obligation.BlobCount,
		BilledEncodedBytes: obligation.BlobCount * retrievalchallenge.EncodedBlobBytes, IntegrityRoot: integrity,
	}).Hash()
	require.NoError(t, err)
	return digest[:]
}

func TestRetrievalV3GenerationAdapterLifecycle(t *testing.T) {
	f, p, owner, deal := setupPrecompileSessionV3(t)
	ctx := sdk.UnwrapSDKContext(f.ctx)
	newRoot := bytes.Repeat([]byte{0x41}, 32)
	proposed := runV3Method(t, p, ctx, owner, "proposeDealGenerationV3",
		deal.Id, deal.ManifestRoot, newRoot, bytes.Repeat([]byte{0x42}, 32),
		deal.Size_+1, uint64(4), uint64(1), uint64(192), deal.CurrentGen)
	decoded, err := p.abi.Methods["proposeDealGenerationV3"].Outputs.Unpack(proposed)
	require.NoError(t, err)
	require.Equal(t, deal.CurrentGen+1, decoded[0])

	for slot := uint32(0); slot < 12; slot++ {
		candidate, err := f.keeper.PendingDealGenerationsV3.Get(ctx, deal.Id)
		require.NoError(t, err)
		provider, err := sdk.AccAddressFromBech32(candidate.Providers[slot])
		require.NoError(t, err)
		out := runV3Method(t, p, ctx, common.BytesToAddress(provider), "acceptDealGenerationV3",
			deal.Id, slot, generationAcceptanceDigestV3(t, candidate, slot))
		accepted, err := p.abi.Methods["acceptDealGenerationV3"].Outputs.Unpack(out)
		require.NoError(t, err)
		require.Equal(t, true, accepted[0])
	}
	finalized := runV3Method(t, p, ctx, owner, "finalizeDealGenerationV3", deal.Id, deal.CurrentGen+1, newRoot)
	decoded, err = p.abi.Methods["finalizeDealGenerationV3"].Outputs.Unpack(finalized)
	require.NoError(t, err)
	require.Equal(t, true, decoded[0])
	stored, err := f.keeper.Deals.Get(ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, deal.CurrentGen+1, stored.CurrentGen)
	require.Equal(t, newRoot, stored.ManifestRoot)
}

func TestRetrievalV3SponsoredOpenAckAndRefundAdapters(t *testing.T) {
	f, p, _, deal := setupPrecompileSessionV3(t)
	ctx := sdk.UnwrapSDKContext(f.ctx)
	params := f.keeper.GetParams(ctx)
	params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	require.NoError(t, f.keeper.Params.Set(ctx, params))
	deal.RetrievalPolicy.Mode = types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
	requester := common.HexToAddress("0x3300000000000000000000000000000000000033")
	rangeArg := retrievalRangeV3Input{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024}
	opened := runV3Method(t, p, ctx, requester, "openRetrievalSessionV3Sponsored",
		deal.Id, deal.CurrentGen, rangeArg, uint64(2), uint64(20), big.NewInt(0), uint8(0), uint32(0), []common.Hash{}, "", []byte{}, "", uint64(0), uint32(0), uint64(0), uint64(0), uint64(0), []byte{})
	decoded, err := p.abi.Methods["openRetrievalSessionV3Sponsored"].Outputs.Unpack(opened)
	require.NoError(t, err)
	id := decoded[0].([32]byte)
	session, err := f.keeper.RetrievalSessionsV3.Get(ctx, id[:])
	require.NoError(t, err)
	require.Equal(t, sdk.AccAddress(requester.Bytes()).String(), session.Owner)
	require.Equal(t, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER, session.Funding)

	anchorCtx := ctx.WithBlockHeight(3).WithHeaderHash(bytes.Repeat([]byte{0x71}, 32))
	require.NoError(t, f.keeper.BeginBlock(anchorCtx))
	ack := runV3Method(t, p, anchorCtx.WithBlockHeight(4), requester, "acknowledgeRetrievalObligationV3",
		id, uint32(0), obligationAckDigestV3(t, session, 0))
	decoded, err = p.abi.Methods["acknowledgeRetrievalObligationV3"].Outputs.Unpack(ack)
	require.NoError(t, err)
	require.Equal(t, false, decoded[0], "ACK without the selected proof must not settle")

	refunded := runV3Method(t, p, ctx.WithBlockHeight(21), requester, "refundRetrievalSessionV3", id)
	decoded, err = p.abi.Methods["refundRetrievalSessionV3"].Outputs.Unpack(refunded)
	require.NoError(t, err)
	require.Equal(t, true, decoded[0])
	stored, err := f.keeper.RetrievalSessionsV3.Get(ctx.WithBlockHeight(21), id[:])
	require.NoError(t, err)
	require.Equal(t, uint32(1), stored.AckedSlotsMask)
	require.Equal(t, uint32(1), stored.RefundedSlotsMask)
}
