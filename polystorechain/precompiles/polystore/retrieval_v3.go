package polystore

import (
	"errors"
	"fmt"
	"math/big"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"
	nilkeeper "polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

type retrievalRangeV3Input struct {
	FileRecordIndex uint32 `abi:"fileRecordIndex"`
	FileStartOffset uint64 `abi:"fileStartOffset"`
	FileLength      uint64 `abi:"fileLength"`
	RangeStart      uint64 `abi:"rangeStart"`
	RangeLength     uint64 `abi:"rangeLength"`
}

type retrievalSampleProofV3Input struct {
	Ordinal uint64            `abi:"ordinal"`
	Proof   sessionProofInput `abi:"proof"`
}

func nativeRangeV3(in retrievalRangeV3Input) types.RetrievalRangeV3 {
	return types.RetrievalRangeV3{
		FileRecordIndex: in.FileRecordIndex, FileStartOffset: in.FileStartOffset,
		FileLength: in.FileLength, RangeStart: in.RangeStart, RangeLength: in.RangeLength,
	}
}

func nativeProof(in sessionProofInput) types.ChainedProof {
	return types.ChainedProof{
		MduIndex: in.MduIndex, MduRootFr: in.MduRootFr, ManifestOpening: in.ManifestOpening,
		RootTableDuCommitment: in.RootTableDuCommitment, RootTableDuMerklePath: in.RootTableDuMerklePath,
		BlobCommitment: in.BlobCommitment, MerklePath: in.MerklePath, BlobIndex: in.BlobIndex,
		ZValue: in.ZValue, YValue: in.YValue, KzgOpeningProof: in.KzgOpeningProof,
	}
}

func evmCreator(contract *vm.Contract) string {
	return sdk.AccAddress(contract.Caller().Bytes()).String()
}

func (p *Precompile) runProposeDealGenerationV3(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct {
		DealId                                                                      uint64
		PreviousPolyfsRoot, PolyfsRoot, IntegrityRoot                               []byte
		Size, TotalMdus, WitnessMdus, IntegrityLeafCount, ExpectedCurrentGeneration uint64
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("proposeDealGenerationV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("proposeDealGenerationV3: %w", err)
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).ProposeDealGenerationV3(sdk.WrapSDKContext(ctx), &types.MsgProposeDealGenerationV3{
		Creator: evmCreator(contract), DealId: in.DealId, PreviousPolyfsRoot: in.PreviousPolyfsRoot,
		PolyfsRoot: in.PolyfsRoot, IntegrityRoot: in.IntegrityRoot, Size_: in.Size,
		TotalMdus: in.TotalMdus, WitnessMdus: in.WitnessMdus, IntegrityLeafCount: in.IntegrityLeafCount,
		ExpectedCurrentGeneration: in.ExpectedCurrentGeneration,
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(res.Generation)
}

func (p *Precompile) runAcceptDealGenerationV3(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct {
		DealId           uint64
		Slot             uint32
		AcceptanceDigest []byte
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("acceptDealGenerationV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("acceptDealGenerationV3: %w", err)
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).AcceptDealGenerationV3(sdk.WrapSDKContext(ctx), &types.MsgAcceptDealGenerationV3{
		Creator: evmCreator(contract), DealId: in.DealId, Slot: in.Slot, AcceptanceDigest: in.AcceptanceDigest,
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(res.Accepted)
}

func (p *Precompile) runFinalizeDealGenerationV3(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct {
		DealId, Generation uint64
		PolyfsRoot         []byte
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("finalizeDealGenerationV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("finalizeDealGenerationV3: %w", err)
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).FinalizeDealGenerationV3(sdk.WrapSDKContext(ctx), &types.MsgFinalizeDealGenerationV3{
		Creator: evmCreator(contract), DealId: in.DealId, Generation: in.Generation, PolyfsRoot: in.PolyfsRoot,
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(res.Success)
}

func packOpenRetrievalV3(method *abi.Method, response *types.MsgOpenRetrievalSessionV3Response) ([]byte, [32]byte, error) {
	var id [32]byte
	if len(response.SessionId) != len(id) {
		return nil, id, errors.New("invalid native v3 session id")
	}
	copy(id[:], response.SessionId)
	out, err := method.Outputs.Pack(id, response.LogicalRequestedBytes, response.BilledEncodedBytes, response.SampleCount)
	return out, id, err
}

func (p *Precompile) runOpenRetrievalSessionV3(ctx sdk.Context, evm *vm.EVM, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct {
		DealId, Generation    uint64
		Range                 retrievalRangeV3Input
		Nonce, DeadlineHeight uint64
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("openRetrievalSessionV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("openRetrievalSessionV3: %w", err)
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).OpenRetrievalSessionV3(sdk.WrapSDKContext(ctx), &types.MsgOpenRetrievalSessionV3{
		Creator: evmCreator(contract), DealId: in.DealId, Generation: in.Generation,
		Range: nativeRangeV3(in.Range), Nonce: in.Nonce, DeadlineHeight: in.DeadlineHeight,
	})
	if err != nil {
		return nil, err
	}
	out, id, err := packOpenRetrievalV3(method, res)
	if err != nil {
		return nil, fmt.Errorf("openRetrievalSessionV3: %w", err)
	}
	p.emitEventRetrievalSessionV3Opened(evm, in.DealId, contract.Caller(), id)
	return out, nil
}

type sponsoredRetrievalV3Input struct {
	DealId, Generation               uint64
	Range                            retrievalRangeV3Input
	Nonce, DeadlineHeight            uint64
	MaxTotalFee                      *big.Int
	AuthType                         uint8
	AllowlistLeafIndex               uint32
	AllowlistMerklePath              []common.Hash
	VoucherRedeemer, VoucherProvider string
	VoucherManifestRoot              []byte
	VoucherStartMduIndex             uint64
	VoucherStartBlobIndex            uint32
	VoucherBlobCount                 uint64
	VoucherExpiresAt, VoucherNonce   uint64
	VoucherSignature                 []byte
}

func applySponsoredRetrievalV3Auth(msg *types.MsgOpenRetrievalSessionV3Sponsored, in sponsoredRetrievalV3Input) error {
	switch in.AuthType {
	case 0:
		return nil
	case 1:
		path := make([][]byte, len(in.AllowlistMerklePath))
		for i := range in.AllowlistMerklePath {
			path[i] = in.AllowlistMerklePath[i].Bytes()
		}
		msg.Auth = &types.MsgOpenRetrievalSessionV3Sponsored_AllowlistProof{AllowlistProof: &types.AllowlistProof{
			LeafIndex: in.AllowlistLeafIndex, MerklePath: path,
		}}
		return nil
	case 2:
		msg.Auth = &types.MsgOpenRetrievalSessionV3Sponsored_Voucher{Voucher: &types.VoucherAuth{
			DealId: in.DealId, ManifestRoot: in.VoucherManifestRoot, Provider: in.VoucherProvider,
			StartMduIndex: in.VoucherStartMduIndex, StartBlobIndex: in.VoucherStartBlobIndex,
			BlobCount: in.VoucherBlobCount, ExpiresAt: in.VoucherExpiresAt, Nonce: in.VoucherNonce,
			Redeemer: in.VoucherRedeemer, Signature: in.VoucherSignature,
		}}
		return nil
	default:
		return errors.New("openRetrievalSessionV3Sponsored: invalid authType")
	}
}

func (p *Precompile) runOpenRetrievalSessionV3Sponsored(ctx sdk.Context, evm *vm.EVM, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in sponsoredRetrievalV3Input
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("openRetrievalSessionV3Sponsored: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("openRetrievalSessionV3Sponsored: %w", err)
	}
	maxFee := math.ZeroInt()
	if in.MaxTotalFee != nil && in.MaxTotalFee.Sign() > 0 {
		maxFee = math.NewIntFromBigInt(in.MaxTotalFee)
	}
	msg := &types.MsgOpenRetrievalSessionV3Sponsored{
		Creator: evmCreator(contract), DealId: in.DealId, Generation: in.Generation, Range: nativeRangeV3(in.Range),
		Nonce: in.Nonce, DeadlineHeight: in.DeadlineHeight, MaxTotalFee: maxFee,
	}
	if err := applySponsoredRetrievalV3Auth(msg, in); err != nil {
		return nil, err
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).OpenRetrievalSessionV3Sponsored(sdk.WrapSDKContext(ctx), msg)
	if err != nil {
		return nil, err
	}
	out, id, err := packOpenRetrievalV3(method, res)
	if err != nil {
		return nil, fmt.Errorf("openRetrievalSessionV3Sponsored: %w", err)
	}
	p.emitEventRetrievalSessionV3Opened(evm, in.DealId, contract.Caller(), id)
	return out, nil
}

func (p *Precompile) runSubmitRetrievalSessionProofV3(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct {
		SessionId [32]byte
		Slot      uint32
		Proofs    []retrievalSampleProofV3Input
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("submitRetrievalSessionProofV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("submitRetrievalSessionProofV3: %w", err)
	}
	if err := nilkeeper.ValidateProofCount(uint64(len(in.Proofs))); err != nil {
		return nil, err
	}
	proofs := make([]types.RetrievalSampleProofV3, len(in.Proofs))
	for i := range in.Proofs {
		proofs[i] = types.RetrievalSampleProofV3{Ordinal: in.Proofs[i].Ordinal, Proof: nativeProof(in.Proofs[i].Proof)}
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).SubmitRetrievalSessionProofV3(sdk.WrapSDKContext(ctx), &types.MsgSubmitRetrievalSessionProofV3{
		Creator: evmCreator(contract), SessionId: in.SessionId[:], Slot: in.Slot, Proofs: proofs,
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(res.NewlyAccepted, res.Settled)
}

func (p *Precompile) runAcknowledgeRetrievalObligationV3(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct {
		SessionId [32]byte
		Slot      uint32
		AckDigest []byte
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("acknowledgeRetrievalObligationV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("acknowledgeRetrievalObligationV3: %w", err)
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).AcknowledgeRetrievalObligationV3(sdk.WrapSDKContext(ctx), &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: evmCreator(contract), SessionId: in.SessionId[:], Slot: in.Slot, AckDigest: in.AckDigest,
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(res.Settled)
}

func (p *Precompile) runRefundRetrievalSessionV3(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var in struct{ SessionId [32]byte }
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("refundRetrievalSessionV3: %w", err)
	}
	if err := method.Inputs.Copy(&in, values); err != nil {
		return nil, fmt.Errorf("refundRetrievalSessionV3: %w", err)
	}
	res, err := nilkeeper.NewMsgServerImpl(*p.keeper).RefundRetrievalSessionV3(sdk.WrapSDKContext(ctx), &types.MsgRefundRetrievalSessionV3{
		Creator: evmCreator(contract), SessionId: in.SessionId[:],
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(res.Refunded)
}

func (p *Precompile) emitEventRetrievalSessionV3Opened(evm *vm.EVM, dealID uint64, requester common.Address, sessionID [32]byte) {
	if evm == nil || evm.StateDB == nil {
		return
	}
	ev, ok := p.abi.Events["RetrievalSessionV3Opened"]
	if !ok {
		return
	}
	data, err := ev.Inputs.NonIndexed().Pack(sessionID)
	if err != nil {
		return
	}
	evm.StateDB.AddLog(&ethtypes.Log{Address: p.Address(), Topics: []common.Hash{ev.ID, common.BigToHash(new(big.Int).SetUint64(dealID)), common.BytesToHash(requester.Bytes())}, Data: data})
}
